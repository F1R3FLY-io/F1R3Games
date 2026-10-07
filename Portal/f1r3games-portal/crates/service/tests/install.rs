//! What a supervisor (ign1t10n) relies on: installing and registering
//! without a keystore (F3), readiness (F5), several validators with one
//! unreachable (F7), the Host allow-list (F4) and game origins (F2).

use axum::extract::State as AxState;
use axum::routing::{get, post};
use axum::{Json, Router};
use f1r3games_core::deploy::{DeployData, SignedDeploy};
use f1r3games_core::{keyfile, Address, Value};
use f1r3games_service::config::{Config, GameOrigin, Listen};
use f1r3games_service::{bootstrap, hosts, origins, register, routes, status, State};
use serde_json::{json, Value as J};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// A node that verifies signatures, installs environments (any deploy
/// carrying `insertSigned` registers the first `rho:id:` URI in its term at
/// version 1), and keeps a game registry.
#[derive(Default)]
struct Node {
    versions: Mutex<BTreeMap<String, i64>>,
    /// What a registration of each game should store (set by the test).
    wanted: Mutex<BTreeMap<String, Value>>,
    registry: Mutex<BTreeMap<String, Value>>,
    deploys: Mutex<Vec<SignedDeploy>>,
}

fn first_uri(term: &str) -> Option<String> {
    let i = term.find("rho:id:")?;
    Some(term[i..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == ':').collect())
}

async fn deploy(AxState(n): AxState<Arc<Node>>, Json(b): Json<J>) -> Result<Json<J>, (axum::http::StatusCode, String)> {
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
    if !sd.verify() {
        return Err((axum::http::StatusCode::BAD_REQUEST, "invalid signature".into()));
    }
    let term = sd.data.term.clone();
    if term.contains("insertSigned") {
        if let Some(u) = first_uri(&term) {
            n.versions.lock().unwrap().insert(u, 1);
        }
    }
    if term.contains("\"games\", \"register\"") {
        let wanted = n.wanted.lock().unwrap().clone();
        for (id, m) in wanted {
            if term.contains(&format!("\"{id}\"")) {
                let Value::Map(mut x) = m else { panic!() };
                x.insert("status".into(), Value::str("active"));
                x.insert("registeredAt".into(), Value::Int(1));
                n.registry.lock().unwrap().insert(id, Value::Map(x));
            }
        }
    }
    let id = sd.id();
    n.deploys.lock().unwrap().push(sd);
    Ok(Json(json!(format!("Success!\nDeployId is: {id}"))))
}

async fn explore(AxState(n): AxState<Arc<Node>>, Json(b): Json<J>) -> Json<J> {
    let term = b["term"].as_str().unwrap();
    let v = if !term.contains("@env!") {
        // env.probe
        first_uri(term).and_then(|u| n.versions.lock().unwrap().get(&u).copied()).map(Value::Int).unwrap_or(Value::Nil)
    } else if let Some(i) = term.find("\"games\", \"get\", \"") {
        let id: String = term[i + 17..].chars().take_while(|c| *c != '"').collect();
        Value::Tuple(vec![Value::Bool(true), n.registry.lock().unwrap().get(&id).cloned().unwrap_or(Value::Nil)])
    } else {
        Value::Tuple(vec![Value::Bool(false), Value::str("unknown")])
    };
    Json(json!({"expr": [rho(&v)], "block": {"blockHash": "h", "blockNumber": 9}}))
}

async fn node() -> (String, Arc<Node>) {
    let n = Arc::new(Node::default());
    let app = Router::new()
        .route("/api/blocks/1", get(|| async { Json(json!([{ "blockInfo": { "blockNumber": 9 } }])) }))
        .route("/api/deploy", post(deploy))
        .route("/api/explore-deploy", post(explore))
        .with_state(n.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, n)
}

async fn dead_url() -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let u = format!("http://{}", l.local_addr().unwrap());
    drop(l);
    u
}

async fn serve(app: Router) -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    port
}

#[tokio::test]
async fn install_register_and_ready_without_a_keystore() {
    let (url, n) = node().await;
    let dead = dead_url().await;
    let coop = keyfile::generate();
    let coop_addr = Address::from_public_key(coop.verifying_key());
    // The unreachable validator is listed first; F7 moves on to the live one.
    let cfg = Config::from_toml(&format!(
        "validator_urls = [\"{dead}\", \"{url}\"]\nobserver_url = \"{url}\"\ncoop_address = \"{coop_addr}\"\n"
    ))
    .unwrap();
    let st = State::new(cfg, keyfile::generate(), keyfile::generate(), vec![7u8; 32]);

    let (ok, report) = status::ready(&st, &["f1r3pix".into()]).await;
    assert!(!ok, "{report}");

    // The portal environment, then a game's.
    for _ in 0..4 {
        // Several attempts: each draws a random rotation; every one must reach the live node.
        assert!(bootstrap::ensure_env(&st).await.unwrap().is_some() || n.versions.lock().unwrap().contains_key(&st.env_uri));
    }
    bootstrap::wait_env(&st, Duration::from_secs(5)).await.unwrap();
    assert!(bootstrap::ensure_env(&st).await.unwrap().is_none(), "a current environment is not deployed again");
    let pix = f1r3games_games::get("f1r3pix").unwrap();
    let pix_key = keyfile::generate();
    let pix_uri = f1r3games_games::env_uri(&pix_key);
    bootstrap::ensure_game_env(&st, pix, &pix_key, 1).await.unwrap();
    bootstrap::wait_version_at(&st, &pix_uri, 1, Duration::from_secs(5)).await.unwrap();

    // Registration with the Cooperative's key: once, then current.
    let manifest = pix.manifest(&pix_uri, "http://localhost:40701");
    n.wanted.lock().unwrap().insert("f1r3pix".into(), manifest.clone());
    let entries = vec![("f1r3pix".to_string(), manifest.clone())];
    let wrong = keyfile::generate();
    assert!(register::register_all(&st, &wrong, &entries, Duration::from_secs(5)).await.is_err(), "only the Cooperative may register");
    let r = register::register_all(&st, &coop, &entries, Duration::from_secs(5)).await.unwrap();
    assert!(matches!(r[0].1, register::Outcome::Registered(_)));
    let r = register::register_all(&st, &coop, &entries, Duration::from_secs(5)).await.unwrap();
    assert_eq!(r[0].1, register::Outcome::Current);

    let (ok, report) = status::ready(&st, &["f1r3pix".into()]).await;
    assert!(ok, "{report}");
    let (ok, _) = status::ready(&st, &["f1r3beat".into()]).await;
    assert!(!ok, "an unregistered game is not ready");

    let s = status::status(&st, &[("f1r3pix".to_string(), pix_uri.clone())].into_iter().collect()).await.unwrap();
    assert_eq!(s["registeredVersion"], 1);
    assert_eq!(s["games"]["f1r3pix"]["env"]["version"], 1);
    assert_eq!(s["games"]["f1r3pix"]["registration"]["entry"], "http://localhost:40701/f1r3pix/");
    assert_eq!(s["games"]["f1r3beat"]["registration"]["registered"], false);
    assert!(n.deploys.lock().unwrap().iter().all(|d| d.verify()));

    // /api/ready over HTTP.
    let st = Arc::new(st);
    let port = serve(routes::router(st.clone())).await;
    let http = reqwest::Client::new();
    let r = http.get(format!("http://127.0.0.1:{port}/api/ready?games=f1r3pix")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let r = http.get(format!("http://127.0.0.1:{port}/api/ready?games=f1r3pix,f1r3beat")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 503);
}

#[tokio::test]
async fn the_portal_answers_only_its_public_host() {
    let (url, _) = node().await;
    let coop = Address::from_public_key(keyfile::generate().verifying_key());
    let cfg = Config::from_toml(&format!("validator_url = \"{url}\"\nobserver_url = \"{url}\"\ncoop_address = \"{coop}\"\n")).unwrap();
    let st = Arc::new(State::new(cfg, keyfile::generate(), keyfile::generate(), vec![7u8; 32]));
    // Bind first to learn the port, then name it as the public host.
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let app = hosts::guard(routes::router(st), Some(&format!("localhost:{port}")));
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let get = |host: String| http.get(format!("http://127.0.0.1:{port}/api/health?x=1")).header("host", host).send();
    assert_eq!(get(format!("localhost:{port}")).await.unwrap().status().as_u16(), 200);
    let r = get(format!("127.0.0.1:{port}")).await.unwrap();
    assert_eq!(r.status().as_u16(), 308);
    assert_eq!(r.headers()["location"], format!("http://localhost:{port}/api/health?x=1").as_str());
    assert_eq!(get(format!("[::1]:{port}")).await.unwrap().status().as_u16(), 308);
    assert_eq!(get("evil.example".into()).await.unwrap().status().as_u16(), 421);
    assert_eq!(get(format!("evil.example:{port}")).await.unwrap().status().as_u16(), 421);
}

#[tokio::test]
async fn each_game_origin_serves_only_its_own_client() {
    let dir = std::env::temp_dir().join(format!("f1r3games-origins-{}", std::process::id()));
    for (p, body) in [("f1r3pix/index.html", "pix"), ("f1r3pix/preview/canvas.html", "canvas"), ("f1r3beat/index.html", "beat"), ("secret.txt", "no")] {
        let f = dir.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, body).unwrap();
    }
    let o = GameOrigin { id: "f1r3pix".into(), listen: Listen::One("127.0.0.1:0".into()), public_host: None, dir: dir.display().to_string(), frame_ancestors: vec![] };
    let port = serve(origins::router(&o, Some("http://localhost:40700"))).await;
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let r = http.get(format!("{base}/f1r3pix/")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.headers()["content-security-policy"], "frame-ancestors http://localhost:40700");
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(r.text().await.unwrap(), "pix");
    assert_eq!(http.get(format!("{base}/f1r3pix/preview/canvas.html")).send().await.unwrap().text().await.unwrap(), "canvas");
    assert_eq!(http.get(format!("{base}/f1r3beat/")).send().await.unwrap().status().as_u16(), 404);
    assert_eq!(http.get(format!("{base}/secret.txt")).send().await.unwrap().status().as_u16(), 404);
    assert_eq!(http.get(format!("{base}/f1r3pix/../secret.txt")).send().await.unwrap().status().as_u16() / 100, 4);
    assert_eq!(http.get(format!("{base}/f1r3pix/%2e%2e/secret.txt")).send().await.unwrap().status().as_u16() / 100, 4);
    let r = http.get(format!("{base}/")).send().await.unwrap();
    assert_eq!(r.status().as_u16() / 100, 3);
    assert_eq!(r.headers()["location"], "/f1r3pix/");
    std::fs::remove_dir_all(dir).ok();
}
