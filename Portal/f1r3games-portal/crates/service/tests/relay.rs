//! F1R3Ink's relay (F1R3Ink design §8): a signed request is checked against
//! the round as the shard reads it, queued, and submitted once per window as
//! one `relayInk` signed by the relay key; the inker's address never reaches
//! the chain against an anonymous stripe.

use axum::routing::{get, post};
use axum::{Json, Router};
use f1r3games_core::deploy::{DeployData, SignedDeploy};
use f1r3games_core::{keyfile, relay as wire, Address, Value};
use f1r3games_service::{config::Config, relay, routes, State};
use k256::ecdsa::SigningKey;
use serde_json::{json, Value as J};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

fn rho(v: &Value) -> J {
    match v {
        Value::Nil => json!({"ExprPar": {"data": []}}),
        Value::Bool(b) => json!({"ExprBool": {"data": b}}),
        Value::Int(n) => json!({"ExprInt": {"data": n}}),
        Value::String(s) => json!({"ExprString": {"data": s}}),
        Value::Uri(s) => json!({"ExprUri": {"data": s}}),
        Value::Bytes(b) => json!({"ExprBytes": {"data": hex::encode(b)}}),
        Value::List(xs) => json!({"ExprList": {"data": xs.iter().map(rho).collect::<Vec<_>>()}}),
        Value::Tuple(xs) => json!({"ExprTuple": {"data": xs.iter().map(rho).collect::<Vec<_>>()}}),
        Value::Map(m) => json!({"ExprMap": {"data": m.iter().map(|(k, v)| (k.clone(), rho(v))).collect::<serde_json::Map<_, _>>()}}),
        other => panic!("{other:?}"),
    }
}

fn ok(v: Value) -> J {
    rho(&Value::Tuple(vec![Value::Bool(true), v]))
}

fn addr(k: &SigningKey) -> String {
    Address::from_public_key(k.verifying_key()).to_string()
}

/// A round of `n` players; `private` names those whose flags are private.
fn round(players: &[String], private: &[&str], left: &[&str]) -> Value {
    let ps = players
        .iter()
        .map(|a| {
            let flag = if private.contains(&a.as_str()) { "private" } else { "public" };
            (a.clone(), Value::map([("pk", Value::Bytes(vec![4; 65])), ("flag", Value::str(flag)), ("tags", Value::List(vec![])), ("left", Value::Bool(left.contains(&a.as_str())))]))
        })
        .collect::<BTreeMap<_, _>>();
    Value::map([
        ("capacity", Value::Int(24)),
        ("anonymous", Value::Bool(true)),
        ("anonMin", Value::Int(5)),
        ("minInterval", Value::Int(60_000)),
        ("status", Value::str("active")),
        ("players", Value::Map(ps)),
    ])
}

struct Rig {
    svc: String,
    st: Arc<State>,
    deploys: Arc<Mutex<Vec<SignedDeploy>>>,
    canned: Arc<Mutex<Value>>,
    http: reqwest::Client,
}

async fn rig() -> Rig {
    let ink = f1r3games_games::get("f1r3ink").unwrap();
    let game_uri = f1r3games_games::env_uri(&keyfile::generate());
    let mut manifest = ink.manifest_with(&game_uri, "https://games.example/play", Some("http://relay.example/api/relay"));
    if let Value::Map(m) = &mut manifest {
        m.insert("status".into(), Value::str("active"));
    }
    let canned: Arc<Mutex<Value>> = Arc::new(Mutex::new(Value::Nil));
    let deploys: Arc<Mutex<Vec<SignedDeploy>>> = Default::default();
    let height = Arc::new(Mutex::new(10i64));
    let (c2, d2, h2) = (canned.clone(), deploys.clone(), height.clone());
    let node = Router::new()
        .route("/api/blocks/1", get(move || {
            let h = h2.clone();
            async move { Json(json!([{ "blockInfo": { "blockNumber": *h.lock().unwrap() } }])) }
        }))
        .route("/api/explore-deploy", post(move |Json(b): Json<J>| {
            let (c, man) = (c2.clone(), manifest.clone());
            async move {
                let term = b["term"].as_str().unwrap();
                let v = if term.contains("\"games\", \"get\", \"f1r3ink\"") { ok(man) } else if term.contains("@env!(\"players\"") { ok(c.lock().unwrap().clone()) } else { panic!("{term}") };
                Json(json!({"expr": [v], "block": {"blockHash": "h", "blockNumber": 10, "timestamp": 1_700_000_000_000i64}}))
            }
        }))
        .route("/api/deploy", post(move |Json(b): Json<J>| {
            let d = d2.clone();
            async move {
                let x = &b["data"];
                let sd = SignedDeploy {
                    data: DeployData {
                        term: x["term"].as_str().unwrap().into(),
                        timestamp: x["timestamp"].as_i64().unwrap(),
                        phlo_price: x["phloPrice"].as_i64().unwrap(),
                        phlo_limit: x["phloLimit"].as_i64().unwrap(),
                        valid_after_block_number: x["validAfterBlockNumber"].as_i64().unwrap(),
                        shard_id: x["shardId"].as_str().unwrap().into(),
                        expiration_timestamp: x["expiration_timestamp"].as_i64(),
                    },
                    deployer: hex::decode(b["deployer"].as_str().unwrap()).unwrap(),
                    sig: hex::decode(b["signature"].as_str().unwrap()).unwrap(),
                };
                assert!(sd.verify());
                let id = sd.id();
                d.lock().unwrap().push(sd);
                Json(json!(format!("Success!\nDeployId is: {id}")))
            }
        }));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node_url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, node).await.unwrap() });

    let coop = addr(&keyfile::generate());
    let cfg = Config::from_toml(&format!(
        "validator_url = \"{node_url}\"\nobserver_url = \"{node_url}\"\ncoop_address = \"{coop}\"\n[relay]\nenabled = true\nbase_url = \"http://relay.example/api/relay/\"\n"
    ))
    .unwrap();
    let st = Arc::new(State::new(cfg, keyfile::generate(), keyfile::generate(), vec![1u8; 32]).with_relay(keyfile::generate(), vec![7u8; 32]));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let svc = format!("http://{}", l.local_addr().unwrap());
    let app = routes::router(st.clone());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    Rig { svc, st, deploys, canned, http: reqwest::Client::new() }
}

impl Rig {
    async fn ask(&self, k: &SigningKey, relay_url: &str, op: &str, params: J) -> (u16, J) {
        let m = json!({ "v": 1, "game": "f1r3ink", "instance": "inst1", "relay": relay_url, "op": op, "params": params, "address": addr(k), "at": f1r3games_service::bootstrap::now_ms() }).to_string();
        let sig = wire::sign(k, &m);
        let r = self
            .http
            .post(format!("{}/api/relay/f1r3ink", self.svc))
            .json(&json!({ "message": m, "publicKey": hex::encode(keyfile::public_key_bytes(k)), "signature": hex::encode(sig) }))
            .send()
            .await
            .unwrap();
        (r.status().as_u16(), r.json().await.unwrap())
    }
}

const URL: &str = "http://relay.example/api/relay/f1r3ink";

#[tokio::test]
async fn an_anonymous_ink_is_queued_then_written_by_the_relay_key() {
    let r = rig().await;
    let keys: Vec<SigningKey> = (0..5).map(|_| keyfile::generate()).collect();
    let names: Vec<String> = keys.iter().map(addr).collect();
    *r.canned.lock().unwrap() = round(&names, &[names[2].as_str()], &[]);
    let relay = r.st.relay.as_ref().unwrap();

    // Handles: one per other player, as the HMAC derives them.
    let (code, h) = r.ask(&keys[0], URL, "handles", json!({})).await;
    assert_eq!(code, 200, "{h}");
    assert_eq!(h["handles"].as_object().unwrap().len(), 4);
    assert_eq!(h["handles"][&names[1]], json!(relay.handle("inst1", &names[1], &names[0])));
    assert!(h["handles"].get(&names[0]).is_none());

    // A clear colour on a public flag is queued under the inker's handle.
    let (code, q) = r.ask(&keys[0], URL, "ink", json!({ "target": names[1], "ink": { "c": 3 } })).await;
    assert_eq!(code, 200, "{q}");
    assert_eq!(q, json!({ "queued": true, "handle": relay.handle("inst1", &names[1], &names[0]) }));
    // minInterval applies before queueing.
    assert_eq!(r.ask(&keys[0], URL, "ink", json!({ "target": names[1], "ink": { "c": 4 } })).await.0, 400);
    // The form must suit the flag: sealed for private, clear for public.
    assert_eq!(r.ask(&keys[0], URL, "ink", json!({ "target": names[2], "ink": { "c": 1 } })).await.0, 409);
    assert_eq!(r.ask(&keys[1], URL, "ink", json!({ "target": names[0], "ink": { "sealed": "00ff" } })).await.0, 409);
    let (code, _) = r.ask(&keys[1], URL, "ink", json!({ "target": names[2], "ink": { "sealed": "a0".repeat(300) } })).await;
    assert_eq!(code, 200);
    // Yourself, strangers, other relays and forged signatures are refused.
    assert_eq!(r.ask(&keys[3], URL, "ink", json!({ "target": names[3], "ink": { "c": 1 } })).await.0, 400);
    assert_eq!(r.ask(&keygen(), URL, "ink", json!({ "target": names[1], "ink": { "c": 1 } })).await.0, 403);
    assert_eq!(r.ask(&keys[3], "http://other.example/api/relay/f1r3ink", "ink", json!({ "target": names[1], "ink": { "c": 1 } })).await.0, 403);
    assert_eq!(relay.queued(), 2);

    // The window closes: one relayInk, signed by the relay key, naming handles, never inkers.
    let ids = relay::flush(&r.st).await;
    assert_eq!(ids.len(), 1);
    let d = r.deploys.lock().unwrap()[0].clone();
    assert_eq!(d.deployer, keyfile::public_key_bytes(&relay.key));
    assert!(d.data.term.contains("@env!(\"relayInk\", \"inst1\", ["), "{}", d.data.term);
    assert!(d.data.term.contains(&relay.handle("inst1", &names[1], &names[0])));
    assert!(d.data.term.contains("{\"c\" : 3}") || d.data.term.contains("{\"c\": 3}"), "{}", d.data.term);
    for n in &names {
        assert!(!d.data.term.contains(n.as_str()) || n == &names[1] || n == &names[2], "the inker's address reached the chain");
    }
    assert_eq!(relay.queued(), 0);

    // Reveal is deployed at once and names the inker (one way, D2).
    let (code, v) = r.ask(&keys[0], URL, "reveal", json!({ "target": names[1] })).await;
    assert_eq!(code, 200, "{v}");
    let t = r.deploys.lock().unwrap()[1].data.term.clone();
    assert!(t.contains(&format!("@env!(\"relayReveal\", \"inst1\", \"{}\", \"{}\", \"{}\"", names[1], v["handle"].as_str().unwrap(), names[0])), "{t}");
}

fn keygen() -> SigningKey {
    keyfile::generate()
}

#[tokio::test]
async fn anonymity_needs_enough_players_and_an_hourly_cap_holds() {
    let r = rig().await;
    let keys: Vec<SigningKey> = (0..5).map(|_| keyfile::generate()).collect();
    let names: Vec<String> = keys.iter().map(addr).collect();
    // One of five has left: four is below anonMin.
    *r.canned.lock().unwrap() = round(&names, &[], &[names[4].as_str()]);
    assert_eq!(r.ask(&keys[0], URL, "ink", json!({ "target": names[1], "ink": { "c": 1 } })).await.0, 400);
    // Someone who left is no longer served.
    assert_eq!(r.ask(&keys[4], URL, "handles", json!({})).await.0, 403);

    *r.canned.lock().unwrap() = round(&names, &[], &[]);
    // 30 relayed requests an hour; lifts (null) count too.
    let mut last = 0;
    for i in 0..31 {
        let target = &names[1 + (i % 4)];
        if target == &names[0] {
            continue;
        }
        // Each request names a new target only the first time; repeats are "too soon",
        // so reveal (deploys at once) is used to spend the allowance.
        last = r.ask(&keys[0], URL, "reveal", json!({ "target": target })).await.0;
    }
    assert_eq!(last, 429);
}
