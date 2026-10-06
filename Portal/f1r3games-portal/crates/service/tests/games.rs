//! A registered game's own templates go through the service and the wallet:
//! the service renders them only from the on-chain manifest (hash-checked),
//! and the wallet signs them only as registered, within the allowance.

use axum::routing::{get, post};
use axum::{Json, Router};
use f1r3games_core::deploy::{DeployData, SignedDeploy};
use f1r3games_core::{keyfile, Address, Value};
use f1r3games_service::{config::Config, routes, State};
use f1r3games_wallet::keystore::Keystore;
use f1r3games_wallet::policy::{Allowance, Decision, Origin, Policy, SignRequest};
use f1r3games_wallet::wallet::{Consent, Wallet};
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
        Value::Set(xs) => json!({"ExprSet": {"data": xs.iter().map(rho).collect::<Vec<_>>()}}),
        Value::Map(m) => json!({"ExprMap": {"data": m.iter().map(|(k, v)| (k.clone(), rho(v))).collect::<serde_json::Map<_, _>>()}}),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_game_move_is_rendered_from_the_manifest_and_signed_within_the_allowance() {
    let pix = f1r3games_games::get("f1r3pix").unwrap();
    let game_key = keyfile::generate();
    let game_uri = f1r3games_games::env_uri(&game_key);
    let manifest = pix.manifest(&game_uri, "https://games.example/play").into_outcome_free();
    let canned = Arc::new(Mutex::new(rho(&Value::Tuple(vec![Value::Bool(true), manifest.clone()]))));
    let deploys: Arc<Mutex<Vec<SignedDeploy>>> = Default::default();

    let (c2, d2) = (canned.clone(), deploys.clone());
    let node = Router::new()
        .route("/api/prepare-deploy", get(|| async { Json(json!({"seqNumber": 5})) }))
        .route("/api/estimate-cost", post(|| async { Json(json!({"cost": 77})) }))
        .route("/api/explore-deploy", post(move |Json(b): Json<J>| {
            let c = c2.clone();
            async move {
                assert!(b["term"].as_str().unwrap().contains("\"games\", \"get\", \"f1r3pix\""));
                Json(json!({"expr": [c.lock().unwrap().clone()], "block": {"blockHash": "h"}}))
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
                Json(json!(id))
            }
        }));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node_url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, node).await.unwrap() });

    let coop = Address::from_public_key(keyfile::generate().verifying_key());
    let cfg = Config::from_toml(&format!("validator_url = \"{node_url}\"\nobserver_url = \"{node_url}\"\ncoop_address = \"{coop}\"\n")).unwrap();
    let st = Arc::new(State::new(cfg, keyfile::generate(), keyfile::generate(), vec![1u8; 32]));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let svc = format!("http://{}", l.local_addr().unwrap());
    let app = routes::router(st.clone());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

    // The wallet registers the game's templates from the manifest and grants an allowance.
    let (mut ks, u) = Keystore::create("pw", 1000);
    ks.add_key(&u, &keyfile::generate(), "main").unwrap();
    let mut policy = Policy::new("root", st.env_uri.clone(), 1_000_000_000);
    let Some(Value::List(ts)) = manifest.get("templates") else { panic!() };
    for t in ts {
        if t.get("kind").unwrap().as_str() == Some("deploy") {
            let tpl = f1r3games_core::Template::new(t.get("id").unwrap().as_str().unwrap(), f1r3games_core::TemplateKind::Deploy, t.get("source").unwrap().as_str().unwrap());
            policy.register_game_template("f1r3pix", tpl, t.get("hash").unwrap().as_str().unwrap()).unwrap();
        }
    }
    policy.grant(Allowance { game: "f1r3pix".into(), instance: "inst1".into(), templates: ["f1r3pix.paint".to_string()].into(), budget: 10_000_000, spent: 0, expires_at: i64::MAX });
    let mut w = Wallet::new(ks, policy);
    w.unlock_with_passphrase("pw").unwrap();

    let http = reqwest::Client::new();
    let p: J = http.post(format!("{svc}/api/prepare"))
        .json(&json!({"template": "f1r3pix.paint", "game": "f1r3pix", "deployer": w.active_public_key_hex().unwrap(),
                      "args": {"instance": "inst1", "colour": "#F3D630"}}))
        .send().await.unwrap().json().await.unwrap();
    assert!(p.get("error").is_none(), "{p}");
    let args: BTreeMap<String, Value> = p["args"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), Value::from_typed_json(v).unwrap())).collect();
    assert!(!args.contains_key("env_uri"), "game templates pin their environment in the source");
    let req = SignRequest { origin: Origin::Game("f1r3pix".into()), template: "f1r3pix.paint".into(), args, prepared: hex::decode(p["prepared"].as_str().unwrap()).unwrap(), instance: Some("inst1".into()) };
    assert!(matches!(w.review(&req, 0).unwrap(), Decision::Within { .. }));
    let s = w.sign(&req, Consent::Refused, 0).unwrap();
    let r: J = http.post(format!("{svc}/api/send"))
        .json(&json!({"prepared": p["prepared"], "deployer": hex::encode(&s.deployer), "signature": hex::encode(&s.sig), "token": p["token"]}))
        .send().await.unwrap().json().await.unwrap();
    assert!(r["deployId"].is_string(), "{r}");
    let term = deploys.lock().unwrap()[0].data.term.clone();
    assert!(term.contains(&format!("rl!(`{game_uri}`, *envCh)")));
    assert!(term.contains(r##"@env!("paint", "inst1", "#F3D630", *deployId)"##));

    // A manifest whose source does not match its listed hash is refused.
    let mut bad = manifest.clone();
    if let Value::Map(m) = &mut bad {
        if let Some(Value::List(ts)) = m.get_mut("templates") {
            // ts[1] is f1r3pix.paint, the template requested below.
            if let Value::Map(t0) = &mut ts[1] {
                t0.insert("source".into(), Value::str("new deployId(`rho:system:deployId`) in { deployId!(1) }"));
            }
        }
    }
    *canned.lock().unwrap() = rho(&Value::Tuple(vec![Value::Bool(true), bad]));
    let r = http.post(format!("{svc}/api/prepare"))
        .json(&json!({"template": "f1r3pix.paint", "game": "f1r3pix", "deployer": w.active_public_key_hex().unwrap(), "args": {"instance": "inst1", "colour": "#000000"}}))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 400);
}

trait Id {
    fn into_outcome_free(self) -> Value;
}
impl Id for Value {
    fn into_outcome_free(self) -> Value {
        // The manifest as registered: games.register adds status.
        match self {
            Value::Map(mut m) => {
                m.insert("status".into(), Value::str("active"));
                Value::Map(m)
            }
            v => v,
        }
    }
}
