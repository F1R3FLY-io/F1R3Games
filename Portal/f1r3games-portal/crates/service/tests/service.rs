//! The service against a mock F1R3Node-Rust that verifies every deploy the
//! way the node does, with the F1R3Games wallet as the client.

use axum::extract::State as AxState;
use axum::routing::{get, post};
use axum::{Json, Router};
use f1r3games_core::deploy::{DeployData, SignedDeploy};
use f1r3games_core::invite::{self, InviteKey};
use f1r3games_core::{catalogue, ids, keyfile, registry, Address, Value};
use f1r3games_service::{bootstrap, config::Config, routes, State};
use f1r3games_wallet::keystore::Keystore;
use f1r3games_wallet::policy::{Origin, Policy, SignRequest};
use f1r3games_wallet::wallet::{Consent, Wallet};
use serde_json::{json, Value as Json_};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Mock {
    deploys: Mutex<Vec<SignedDeploy>>,
    env_version: Mutex<Option<i64>>,
}

fn rho_int(n: i64) -> Json_ {
    json!({"ExprInt": {"data": n}})
}

async fn mock_deploy(AxState(m): AxState<Arc<Mock>>, Json(b): Json<Json_>) -> Result<Json<Json_>, (axum::http::StatusCode, String)> {
    let d = &b["data"];
    let sd = SignedDeploy {
        data: DeployData {
            term: d["term"].as_str().unwrap().into(),
            timestamp: d["timestamp"].as_i64().unwrap(),
            phlo_price: d["phloPrice"].as_i64().unwrap(),
            phlo_limit: d["phloLimit"].as_i64().unwrap(),
            valid_after_block_number: d["validAfterBlockNumber"].as_i64().unwrap(),
            shard_id: d["shardId"].as_str().unwrap().into(),
            expiration_timestamp: d["expiration_timestamp"].as_i64(),
        },
        deployer: hex::decode(b["deployer"].as_str().unwrap()).unwrap(),
        sig: hex::decode(b["signature"].as_str().unwrap()).unwrap(),
    };
    assert_eq!(b["sigAlgorithm"], "secp256k1");
    if !sd.verify() {
        return Err((axum::http::StatusCode::BAD_REQUEST, "invalid signature".into()));
    }
    let id = sd.id();
    m.deploys.lock().unwrap().push(sd);
    Ok(Json(json!(id)))
}

async fn mock_explore(AxState(m): AxState<Arc<Mock>>, Json(b): Json<Json_>) -> Json<Json_> {
    let term = b["term"].as_str().unwrap();
    assert!(term.starts_with("new ret"), "explore terms bind ret first: {term}");
    let expr = if term.contains("\"profiles\", \"get\"") {
        json!({"ExprTuple": {"data": [{"ExprBool": {"data": true}}, {"ExprMap": {"data": {"name": {"ExprString": {"data": "Ada"}}}}}]}})
    } else if !term.contains("@env!") {
        match *m.env_version.lock().unwrap() {
            Some(v) => rho_int(v),
            None => json!({"ExprPar": {"data": []}}),
        }
    } else {
        json!({"ExprTuple": {"data": [{"ExprBool": {"data": false}}, {"ExprString": {"data": "unknown"}}]}})
    };
    Json(json!({"expr": [expr], "block": {"blockHash": "abc123", "blockNumber": 42}}))
}

async fn mock_node() -> (String, Arc<Mock>) {
    let m = Arc::new(Mock::default());
    let app = Router::new()
        .route("/api/prepare-deploy", get(|| async { Json(json!({"names": [], "seqNumber": 5})) }))
        .route("/api/deploy", post(mock_deploy))
        .route("/api/explore-deploy", post(mock_explore))
        .route("/api/estimate-cost", post(|| async { Json(json!({"cost": 1234})) }))
        .with_state(m.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, m)
}

async fn service(node: &str, coop: &Address) -> (String, Arc<State>) {
    let cfg = Config::from_toml(&format!(
        r#"validator_url = "{node}"
observer_url = "{node}"
coop_address = "{coop}"
shard_id = "root"
[faucet]
enabled = true
amount = 1000
"#
    ))
    .unwrap();
    let st = Arc::new(State::new(cfg, keyfile::generate(), keyfile::generate(), vec![7u8; 32]));
    let app = routes::router(st.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, st)
}

fn wallet(env_uri: &str) -> Wallet {
    let (mut ks, u) = Keystore::create("pw", 1000);
    ks.add_key(&u, &keyfile::generate(), "main").unwrap();
    let mut w = Wallet::new(ks, Policy::new("root", env_uri, 1_000_000_000));
    w.unlock_with_passphrase("pw").unwrap();
    w
}

/// prepare → wallet review and sign → send.
async fn call(http: &reqwest::Client, svc: &str, w: &mut Wallet, template: &str, args: BTreeMap<String, Value>, derive: &[&str]) -> (Json_, Json_) {
    let args_json: Json_ = Json_::Object(args.iter().map(|(k, v)| (k.clone(), v.to_typed_json())).collect());
    let p: Json_ = http
        .post(format!("{svc}/api/prepare"))
        .json(&json!({"template": template, "args": args_json, "deployer": w.active_public_key_hex().unwrap(), "derive": derive}))
        .send().await.unwrap().json().await.unwrap();
    assert!(p.get("error").is_none(), "{p}");
    let mut final_args = BTreeMap::new();
    for (k, v) in p["args"].as_object().unwrap() {
        final_args.insert(k.clone(), Value::from_typed_json(v).unwrap());
    }
    let prepared = hex::decode(p["prepared"].as_str().unwrap()).unwrap();
    let req = SignRequest { origin: Origin::Portal, template: template.into(), args: final_args, prepared: prepared.clone(), instance: None };
    let s = w.sign(&req, Consent::Approved, 0).unwrap();
    let r: Json_ = http
        .post(format!("{svc}/api/send"))
        .json(&json!({"prepared": hex::encode(&prepared), "deployer": hex::encode(&s.deployer), "signature": hex::encode(&s.sig), "token": p["token"]}))
        .send().await.unwrap().json().await.unwrap();
    (p, r)
}

#[tokio::test]
async fn end_to_end_against_a_verifying_mock_node() {
    let (node, mock) = mock_node().await;
    let coop = Address::from_public_key(keyfile::generate().verifying_key());
    let (svc, st) = service(&node, &coop).await;
    let http = reqwest::Client::new();

    // 1. The environment is installed under the env key's URI with a valid insertSigned signature.
    let id = bootstrap::ensure_env(&st).await.unwrap().expect("deployed");
    let env_deploy = mock.deploys.lock().unwrap()[0].clone();
    assert_eq!(env_deploy.id(), id);
    assert_eq!(env_deploy.deployer, keyfile::public_key_bytes(&st.service_key));
    assert!(env_deploy.data.term.contains(&format!("`{}`", st.env_uri)));
    assert!(env_deploy.data.term.contains(&format!("\"{coop}\"")));
    assert_eq!(st.env_uri, registry::uri_for_public_key(&keyfile::public_key_bytes(&st.env_key)));
    let sig = registry::insert_signed_signature(&st.env_key, env_deploy.data.timestamp, &env_deploy.deployer, 1);
    assert!(env_deploy.data.term.contains(&format!("\"{}\".hexToBytes()", hex::encode(sig))));
    *mock.env_version.lock().unwrap() = Some(1);
    assert_eq!(bootstrap::ensure_env(&st).await.unwrap(), None, "a current environment is not redeployed");

    let env: Json_ = http.get(format!("{svc}/api/env")).send().await.unwrap().json().await.unwrap();
    assert_eq!(env["envUri"], st.env_uri.as_str());
    let mut w = wallet(&st.env_uri);

    // 2. A profile save goes through prepare → wallet → send and verifies at the node.
    let mut args = BTreeMap::new();
    args.insert("profile".to_string(), Value::map([("name", Value::str("Ada"))]));
    let (p, r) = call(&http, &svc, &mut w, "profiles.save", args, &[]).await;
    assert!(r["deployId"].is_string(), "{r}");
    assert_eq!(p["estimatedCost"], 1234);
    assert_eq!(mock.deploys.lock().unwrap().len(), 2);

    // 3. Launch: the instance id is derived from (deployer, timestamp) before the deploy.
    let mut args = BTreeMap::new();
    args.insert("game".to_string(), Value::str("f1r3pix"));
    args.insert("visibility".to_string(), Value::str("unlisted"));
    args.insert("config".to_string(), Value::map::<String>([]));
    let (p, _) = call(&http, &svc, &mut w, "instances.create", args, &["id"]).await;
    let launched = mock.deploys.lock().unwrap().last().unwrap().clone();
    let expect = ids::derive("instances.create:id", &launched.deployer, launched.data.timestamp);
    assert_eq!(p["derived"]["id"], expect.as_str());
    assert!(launched.data.term.contains(&format!("\"{expect}\", \"f1r3pix\", \"unlisted\"")));

    // 4. Invitation: issue by the host, redeem by a newcomer's wallet.
    let inv = InviteKey::generate();
    let mut args = BTreeMap::new();
    args.insert("invitePk".to_string(), Value::Bytes(inv.public_key()));
    args.insert("instance".to_string(), Value::str(expect.clone()));
    args.insert("uses".to_string(), Value::Int(1));
    args.insert("expiresAt".to_string(), Value::Int(i64::MAX));
    args.insert("sponsorship".to_string(), Value::Nil);
    call(&http, &svc, &mut w, "invites.issue", args, &[]).await;
    let link = inv.link("https://games.f1r3fly.io", &expect, None);
    let parsed = invite::parse_link(&link).unwrap();
    let mut guest = wallet(&st.env_uri);
    let rsig = guest.redemption_signature(&parsed.invite_key).unwrap();
    assert!(invite::verify_redemption(&inv.public_key(), &guest.active_address().unwrap(), &rsig));
    let mut args = BTreeMap::new();
    args.insert("invitePk".to_string(), Value::Bytes(parsed.invite_key.public_key()));
    args.insert("sig".to_string(), Value::Bytes(rsig));
    let (_, r) = call(&http, &svc, &mut guest, "invites.redeem", args, &[]).await;
    assert!(r["deployId"].is_string());

    // 5. Tampering: a forged token, or bytes other than those prepared, are refused.
    let mut args = BTreeMap::new();
    args.insert("id".to_string(), Value::str(expect.clone()));
    let args_json: Json_ = Json_::Object(args.iter().map(|(k, v)| (k.clone(), v.to_typed_json())).collect());
    let p: Json_ = http.post(format!("{svc}/api/prepare"))
        .json(&json!({"template": "instances.join", "args": args_json, "deployer": guest.active_public_key_hex().unwrap()}))
        .send().await.unwrap().json().await.unwrap();
    let prepared = hex::decode(p["prepared"].as_str().unwrap()).unwrap();
    let mut data = DeployData::decode(&prepared).unwrap();
    data.phlo_limit += 1;
    let k = guest.active_key().unwrap();
    let forged = f1r3games_core::deploy::sign(&k, data);
    let r = http.post(format!("{svc}/api/send"))
        .json(&json!({"prepared": hex::encode(forged.data.signing_bytes()), "deployer": hex::encode(&forged.deployer), "signature": hex::encode(&forged.sig), "token": p["token"]}))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403);
    let honest = f1r3games_core::deploy::sign(&k, DeployData::decode(&prepared).unwrap());
    let r = http.post(format!("{svc}/api/send"))
        .json(&json!({"prepared": hex::encode(&prepared), "deployer": hex::encode(&honest.deployer), "signature": hex::encode(&honest.sig), "token": "ffffffffff.00"}))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403);
    // The service will not let a client choose another environment.
    let r = http.post(format!("{svc}/api/prepare"))
        .json(&json!({"template": "instances.join", "args": {"id": "x", "env_uri": {"uri": "rho:id:aaaa"}}, "deployer": guest.active_public_key_hex().unwrap()}))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 400);
    // Nor prepare the environment deploy for anyone.
    let r = http.post(format!("{svc}/api/prepare"))
        .json(&json!({"template": catalogue::ENV, "args": {}, "deployer": guest.active_public_key_hex().unwrap()}))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 400);

    // 6. Reads come back typed, with the block hash they reflect.
    let a = w.active_address().unwrap();
    let r: Json_ = http.get(format!("{svc}/api/profiles/{a}")).send().await.unwrap().json().await.unwrap();
    assert_eq!(r["ok"], true);
    assert_eq!(r["value"]["map"]["name"], "Ada");
    assert_eq!(r["blockHash"], "abc123");
    let r: Json_ = http.get(format!("{svc}/api/instances/{expect}")).send().await.unwrap().json().await.unwrap();
    assert_eq!(r["ok"], false);

    // 7. The faucet pays from the service key with the vault transfer template.
    let before = mock.deploys.lock().unwrap().len();
    let r: Json_ = http.post(format!("{svc}/api/testnet/fund")).json(&json!({"address": guest.active_address().unwrap()}))
        .send().await.unwrap().json().await.unwrap();
    assert!(r["deployId"].is_string(), "{r}");
    let f = mock.deploys.lock().unwrap()[before].clone();
    assert!(f.data.term.contains("@SystemVault!(\"deployerAuthKey\", *deployerId, *keyCh)"));
    assert!(f.data.term.contains(&format!("\"{}\", 1000", guest.active_address().unwrap())));
}
