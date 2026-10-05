//! A testbed for the portal shell: the real f1r3games-service in front of a
//! mock F1R3Node-Rust that verifies every deploy's signature as the node does
//! and records it, and answers exploratory reads from canned responses the
//! test installs. It does not execute Rholang.
//!
//!   cargo run -p f1r3games-service --example testbed -- <node-port> <service-port> <coop-address>
//!
//! Control endpoints on the node port:
//!   POST /__mock/explore  {"needle": "...", "expr": <RhoExpr JSON>}   answer terms containing needle
//!   POST /__mock/reset
//!   GET  /__mock/deploys  [{id, term, deployer, timestamp}]

use axum::extract::{Path, State as AxState};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use f1r3games_core::deploy::{DeployData, SignedDeploy};
use f1r3games_core::keyfile;
use f1r3games_service::{config::Config, routes, State};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Mock {
    deploys: Mutex<Vec<SignedDeploy>>,
    canned: Mutex<Vec<(String, Value)>>,
}

async fn deploy(AxState(m): AxState<Arc<Mock>>, Json(b): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let d = &b["data"];
    let sd = SignedDeploy {
        data: DeployData {
            term: d["term"].as_str().unwrap_or_default().into(),
            timestamp: d["timestamp"].as_i64().unwrap_or_default(),
            phlo_price: d["phloPrice"].as_i64().unwrap_or_default(),
            phlo_limit: d["phloLimit"].as_i64().unwrap_or_default(),
            valid_after_block_number: d["validAfterBlockNumber"].as_i64().unwrap_or_default(),
            shard_id: d["shardId"].as_str().unwrap_or_default().into(),
            expiration_timestamp: d["expiration_timestamp"].as_i64(),
        },
        deployer: hex::decode(b["deployer"].as_str().unwrap_or_default()).unwrap_or_default(),
        sig: hex::decode(b["signature"].as_str().unwrap_or_default()).unwrap_or_default(),
    };
    if !sd.verify() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_signature", "message": "signature does not verify"}))));
    }
    let id = sd.id();
    m.deploys.lock().unwrap().push(sd);
    Ok(Json(json!(id)))
}

async fn find(AxState(m): AxState<Arc<Mock>>, Path(id): Path<String>) -> Result<Json<Value>, StatusCode> {
    if m.deploys.lock().unwrap().iter().any(|d| d.id() == id) {
        Ok(Json(json!({"blockHash": "mockblock", "deployId": id})))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

async fn explore(AxState(m): AxState<Arc<Mock>>, Json(b): Json<Value>) -> Json<Value> {
    let term = b["term"].as_str().unwrap_or_default();
    let canned = m.canned.lock().unwrap();
    let expr = canned
        .iter()
        .rev()
        .find(|(needle, _)| term.contains(needle.as_str()))
        .map(|(_, e)| e.clone())
        .unwrap_or_else(|| {
            if term.contains("@env!") {
                json!({"ExprTuple": {"data": [{"ExprBool": {"data": true}}, {"ExprPar": {"data": []}}]}})
            } else {
                json!({"ExprInt": {"data": 1}})
            }
        });
    Json(json!({"expr": [expr], "block": {"blockHash": "mockblock", "blockNumber": 42}}))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let (np, sp, coop) = (a[1].clone(), a[2].clone(), a[3].clone());
    let m = Arc::new(Mock::default());
    let node = Router::new()
        .route("/api/prepare-deploy", get(|| async { Json(json!({"names": [], "seqNumber": 5})) }))
        .route("/api/deploy", post(deploy))
        .route("/api/deploy/{id}", get(find))
        .route("/api/explore-deploy", post(explore))
        .route("/api/estimate-cost", post(|| async { Json(json!({"cost": 1234})) }))
        .route("/api/balance/{a}", get(|| async { Json(json!({"balance": 1000000000})) }))
        .route("/__mock/explore", post(|AxState(m): AxState<Arc<Mock>>, Json(b): Json<Value>| async move {
            m.canned.lock().unwrap().push((b["needle"].as_str().unwrap_or_default().to_string(), b["expr"].clone()));
            Json(json!({"ok": true}))
        }))
        .route("/__mock/reset", post(|AxState(m): AxState<Arc<Mock>>| async move {
            m.canned.lock().unwrap().clear();
            m.deploys.lock().unwrap().clear();
            Json(json!({"ok": true}))
        }))
        .route("/__mock/deploys", get(|AxState(m): AxState<Arc<Mock>>| async move {
            Json(Value::Array(m.deploys.lock().unwrap().iter().map(|d| json!({
                "id": d.id(), "term": d.data.term, "deployer": hex::encode(&d.deployer), "timestamp": d.data.timestamp
            })).collect()))
        }))
        .with_state(m);
    let nl = tokio::net::TcpListener::bind(format!("127.0.0.1:{np}")).await?;
    tokio::spawn(async move { axum::serve(nl, node).await.unwrap() });

    let cfg = Config::from_toml(&format!(
        "validator_url = \"http://127.0.0.1:{np}\"\nobserver_url = \"http://127.0.0.1:{np}\"\ncoop_address = \"{coop}\"\nportal_base_url = \"http://127.0.0.1:{sp}\"\n[faucet]\nenabled = true\namount = 1000\n"
    ))?;
    let st = Arc::new(State::new(cfg, keyfile::generate(), keyfile::generate(), vec![9u8; 32]));
    let cors = tower_http::cors::CorsLayer::permissive();
    let sl = tokio::net::TcpListener::bind(format!("127.0.0.1:{sp}")).await?;
    println!("testbed ready node={np} service={sp} env={}", st.env_uri);
    axum::serve(sl, routes::router(st).layer(cors)).await?;
    Ok(())
}
