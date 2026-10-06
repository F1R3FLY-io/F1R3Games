//! HTTP routes.

use crate::bootstrap::now_ms;
use crate::token;
use crate::Shared;
use axum::extract::{Path, Query, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use f1r3games_core::deploy::{DeployData, SignedDeploy};
use f1r3games_core::template::{Template, TemplateKind};
use f1r3games_core::{catalogue, deploy, ids, keyfile, Address, Value, PROTOCOL_VERSION};
use serde::Deserialize;
use serde_json::{json, Value as Json_};
use std::collections::BTreeMap;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad(m: impl ToString) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, m.to_string())
}

fn upstream(m: impl ToString) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, m.to_string())
}

type R<T> = Result<Json<T>, ApiError>;

pub fn router(st: Shared) -> Router {
    Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/env", get(env_info))
        .route("/api/templates", get(templates))
        .route("/api/prepare", post(prepare))
        .route("/api/send", post(send))
        .route("/api/explore", post(explore))
        .route("/api/deploys/{id}", get(deploy_status))
        .route("/api/balance/{address}", get(balance))
        .route("/api/testnet/fund", post(fund))
        .route("/api/profiles/{address}", get(profile))
        .route("/api/games", get(games))
        .route("/api/games/{id}", get(game))
        .route("/api/games/{id}/instances", get(public_instances))
        .route("/api/games/{id}/plays/{kind}/{day}", get(plays_by_day))
        .route("/api/instances/{id}", get(instance))
        .route("/api/plays/{id}", get(play))
        .route("/api/plays/{id}/body", get(play_body))
        .route("/api/invites/{pk}", get(invite))
        .route("/api/sponsorships", get(sponsorships))
        .route("/api/sponsorships/{id}", get(sponsorship))
        .route("/api/engagement/{play}", get(engagement))
        .route("/api/contacts/{address}", get(contacts))
        .with_state(st.clone())
        .fallback_service(static_files(&st))
}

async fn env_info(AxState(st): AxState<Shared>) -> Json<Json_> {
    Json(json!({
        "envUri": st.env_uri,
        "version": st.config.env_version,
        "shardId": st.config.shard_id,
        "coopAddress": st.config.coop_address,
        "protocol": PROTOCOL_VERSION,
        "phloPrice": st.config.phlo_price,
        "maxPhloLimit": st.config.max_phlo_limit,
        "portalBaseUrl": st.config.portal_base_url,
        "faucet": st.config.faucet.enabled,
    }))
}

async fn templates() -> Json<Json_> {
    Json(Json_::Array(
        catalogue::all()
            .iter()
            .map(|t| json!({ "id": t.id, "kind": t.kind, "hash": t.hash_hex(), "holes": t.holes().unwrap_or_default(), "source": t.source }))
            .collect(),
    ))
}

fn typed_args(j: &Json_) -> Result<BTreeMap<String, Value>, ApiError> {
    let mut out = BTreeMap::new();
    if let Some(o) = j.as_object() {
        for (k, v) in o {
            out.insert(k.clone(), Value::from_typed_json(v).map_err(|e| bad(format!("{k}: {e}")))?);
        }
    } else if !j.is_null() {
        return Err(bad("args must be an object"));
    }
    Ok(out)
}

fn args_json(args: &BTreeMap<String, Value>) -> Json_ {
    Json_::Object(args.iter().map(|(k, v)| (k.clone(), v.to_typed_json())).collect())
}

fn with_env(st: &Shared, t: &Template, args: &mut BTreeMap<String, Value>) -> Result<(), ApiError> {
    if !t.holes().map_err(bad)?.iter().any(|h| h == "env_uri") {
        return if args.contains_key("env_uri") { Err(bad("this template has no env_uri")) } else { Ok(()) };
    }
    match args.get("env_uri") {
        None => {
            args.insert("env_uri".into(), Value::Uri(st.env_uri.clone()));
            Ok(())
        }
        Some(Value::Uri(u)) if *u == st.env_uri => Ok(()),
        Some(_) => Err(bad("env_uri is set by the service")),
    }
}

/// Resolve a template: the portal catalogue, or — when `game` is given — the
/// template of that id in the game's on-chain manifest, whose source must
/// hash to the hash the manifest lists.
async fn resolve(st: &Shared, template: &str, game: Option<&str>, kind: TemplateKind) -> Result<Template, ApiError> {
    if let Some(g) = game {
        let t = catalogue::get("games.get").unwrap();
        let mut args = a1("game", Value::String(g.to_string()));
        args.insert("env_uri".into(), Value::Uri(st.env_uri.clone()));
        let e = st.node.explore(&t.render(&args).map_err(bad)?).await.map_err(upstream)?;
        let manifest = e.first().into_outcome().map_err(bad)?;
        if manifest.get("status").and_then(Value::as_str) != Some("active") {
            return Err(bad(format!("game {g} is not registered and active")));
        }
        let Some(Value::List(ts)) = manifest.get("templates") else { return Err(bad(format!("game {g} lists no templates"))) };
        for entry in ts {
            if entry.get("id").and_then(Value::as_str) == Some(template) {
                let source = entry.get("source").and_then(Value::as_str).ok_or_else(|| bad("template has no source"))?;
                let declared = match entry.get("kind").and_then(Value::as_str) {
                    Some("explore") => TemplateKind::Explore,
                    _ => TemplateKind::Deploy,
                };
                // The listed hash is the anchor. The node keeps string literals
                // verbatim, so a source read back may still carry the escapes it
                // was written with; accept the unescaped text only if it matches.
                let listed = entry.get("hash").and_then(Value::as_str);
                let mut t = Template::new(template, declared, source);
                if listed != Some(t.hash_hex().as_str()) {
                    t = Template::new(template, declared, f1r3games_core::rho::unescape(source));
                    if listed != Some(t.hash_hex().as_str()) {
                        return Err(bad(format!("{g}/{template}: source does not match its listed hash")));
                    }
                }
                if declared != kind {
                    return Err(bad(format!("{g}/{template} is not a {kind:?} template")));
                }
                return Ok(t);
            }
        }
        return Err(bad(format!("game {g} has no template {template}")));
    }
    let t = catalogue::get(template).ok_or_else(|| bad(format!("unknown template {template}")))?;
    if t.kind != kind {
        return Err(bad(format!("{template} is not a {kind:?} template")));
    }
    Ok(t.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareReq {
    pub template: String,
    /// A registered game whose manifest supplies the template.
    pub game: Option<String>,
    #[serde(default)]
    pub args: Json_,
    /// Hex, 65-byte uncompressed public key of the signer.
    pub deployer: String,
    pub phlo_limit: Option<i64>,
    /// Argument names to fill with identifiers derived from (deployer, timestamp).
    #[serde(default)]
    pub derive: Vec<String>,
}

async fn prepare(AxState(st): AxState<Shared>, Json(req): Json<PrepareReq>) -> R<Json_> {
    let t = resolve(&st, &req.template, req.game.as_deref(), TemplateKind::Deploy).await?;
    if req.game.is_none() && t.id == catalogue::ENV {
        return Err(bad("not a deploy template"));
    }
    let deployer = hex::decode(&req.deployer).map_err(|_| bad("deployer must be hex"))?;
    if k256::ecdsa::VerifyingKey::from_sec1_bytes(&deployer).is_err() || deployer.len() != 65 {
        return Err(bad("deployer must be a 65-byte uncompressed secp256k1 public key"));
    }
    let mut args = typed_args(&req.args)?;
    with_env(&st, &t, &mut args)?;
    let timestamp = now_ms();
    let mut derived = serde_json::Map::new();
    for name in &req.derive {
        let id = ids::derive(&format!("{}:{}", t.id, name), &deployer, timestamp);
        derived.insert(name.clone(), json!(id));
        args.insert(name.clone(), Value::String(id));
    }
    let term = t.render(&args).map_err(bad)?;
    let valid_after = st.node.valid_after().await.map_err(upstream)?;
    let limit = req.phlo_limit.unwrap_or(st.config.default_phlo_limit).clamp(1, st.config.max_phlo_limit);
    let data = DeployData {
        term,
        timestamp,
        phlo_price: st.config.phlo_price,
        phlo_limit: limit,
        valid_after_block_number: valid_after,
        shard_id: st.config.shard_id.clone(),
        expiration_timestamp: Some(timestamp + st.config.deploy_ttl_ms),
    };
    let prepared = data.signing_bytes();
    let estimate = st.node.estimate_cost(&data.term, &req.deployer).await.ok();
    let tok = token::issue(&st.token_secret, &prepared, &deployer, timestamp / 1000 + st.config.token_ttl_secs);
    Ok(Json(json!({
        "template": t.id,
        "templateHash": t.hash_hex(),
        "args": args_json(&args),
        "derived": derived,
        "deploy": data,
        "prepared": hex::encode(&prepared),
        "token": tok,
        "estimatedCost": estimate,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReq {
    pub prepared: String,
    pub deployer: String,
    pub signature: String,
    pub token: String,
}

async fn send(AxState(st): AxState<Shared>, Json(req): Json<SendReq>) -> R<Json_> {
    let prepared = hex::decode(&req.prepared).map_err(|_| bad("prepared must be hex"))?;
    let deployer = hex::decode(&req.deployer).map_err(|_| bad("deployer must be hex"))?;
    let sig = hex::decode(&req.signature).map_err(|_| bad("signature must be hex"))?;
    token::verify(&st.token_secret, &req.token, &prepared, &deployer, now_ms() / 1000)
        .map_err(|e| ApiError(StatusCode::FORBIDDEN, e.to_string()))?;
    let data = DeployData::decode(&prepared).map_err(bad)?;
    let signed = SignedDeploy { data, deployer, sig };
    if !signed.verify() {
        return Err(ApiError(StatusCode::FORBIDDEN, "signature does not verify".into()));
    }
    let id = st.node.deploy(&signed).await.map_err(upstream)?;
    Ok(Json(json!({ "deployId": id })))
}

#[derive(Deserialize)]
pub struct ExploreReq {
    pub template: String,
    pub game: Option<String>,
    #[serde(default)]
    pub args: Json_,
}

fn outcome_json(v: Value) -> Json_ {
    match v.clone().into_outcome() {
        Ok(x) => json!({ "ok": true, "value": x.to_typed_json() }),
        Err(e) => json!({ "ok": false, "error": e, "raw": v.to_typed_json() }),
    }
}

async fn run_explore(st: &Shared, template: &str, args: BTreeMap<String, Value>) -> R<Json_> {
    run_explore_in(st, template, None, args).await
}

async fn run_explore_in(st: &Shared, template: &str, game: Option<&str>, mut args: BTreeMap<String, Value>) -> R<Json_> {
    let t = resolve(st, template, game, TemplateKind::Explore).await?;
    with_env(st, &t, &mut args)?;
    let term = t.render(&args).map_err(bad)?;
    let e = st.node.explore(&term).await.map_err(upstream)?;
    let mut out = outcome_json(e.first());
    out["blockHash"] = json!(e.block_hash);
    out["blockNumber"] = json!(e.block_number);
    Ok(Json(out))
}

async fn explore(AxState(st): AxState<Shared>, Json(req): Json<ExploreReq>) -> R<Json_> {
    let args = typed_args(&req.args)?;
    run_explore_in(&st, &req.template, req.game.as_deref(), args).await
}

fn a1(k: &str, v: Value) -> BTreeMap<String, Value> {
    [(k.to_string(), v)].into_iter().collect()
}

async fn profile(AxState(st): AxState<Shared>, Path(address): Path<String>) -> R<Json_> {
    Address::parse(&address).map_err(bad)?;
    run_explore(&st, "profiles.get", a1("address", Value::String(address))).await
}

async fn games(AxState(st): AxState<Shared>) -> R<Json_> {
    run_explore(&st, "games.list", BTreeMap::new()).await
}

async fn game(AxState(st): AxState<Shared>, Path(id): Path<String>) -> R<Json_> {
    run_explore(&st, "games.get", a1("game", Value::String(id))).await
}

async fn public_instances(AxState(st): AxState<Shared>, Path(id): Path<String>) -> R<Json_> {
    run_explore(&st, "instances.listPublic", a1("game", Value::String(id))).await
}

async fn instance(AxState(st): AxState<Shared>, Path(id): Path<String>) -> R<Json_> {
    run_explore(&st, "instances.get", a1("id", Value::String(id))).await
}

async fn play(AxState(st): AxState<Shared>, Path(id): Path<String>) -> R<Json_> {
    run_explore(&st, "plays.get", a1("id", Value::String(id))).await
}

#[derive(Deserialize)]
pub struct VersionQ {
    pub version: Option<i64>,
}

async fn play_body(AxState(st): AxState<Shared>, Path(id): Path<String>, Query(q): Query<VersionQ>) -> R<Json_> {
    let mut args = a1("id", Value::String(id));
    args.insert("version".into(), Value::Int(q.version.unwrap_or(-1)));
    run_explore(&st, "plays.body", args).await
}

async fn plays_by_day(AxState(st): AxState<Shared>, Path((game, kind, day)): Path<(String, String, i64)>) -> R<Json_> {
    let mut args = a1("game", Value::String(game));
    args.insert("kind".into(), Value::String(kind));
    args.insert("day".into(), Value::Int(day));
    run_explore(&st, "plays.list", args).await
}

async fn invite(AxState(st): AxState<Shared>, Path(pk): Path<String>) -> R<Json_> {
    let b = hex::decode(&pk).map_err(|_| bad("invite key must be hex"))?;
    run_explore(&st, "invites.get", a1("invitePk", Value::Bytes(b))).await
}

async fn sponsorships(AxState(st): AxState<Shared>) -> R<Json_> {
    run_explore(&st, "sponsors.list", BTreeMap::new()).await
}

async fn sponsorship(AxState(st): AxState<Shared>, Path(id): Path<String>) -> R<Json_> {
    run_explore(&st, "sponsors.get", a1("id", Value::String(id))).await
}

async fn engagement(AxState(st): AxState<Shared>, Path(p): Path<String>) -> R<Json_> {
    run_explore(&st, "engagement.counts", a1("play", Value::String(p))).await
}

async fn contacts(AxState(st): AxState<Shared>, Path(address): Path<String>) -> R<Json_> {
    Address::parse(&address).map_err(bad)?;
    run_explore(&st, "contacts.get", a1("address", Value::String(address))).await
}

async fn deploy_status(AxState(st): AxState<Shared>, Path(id): Path<String>) -> R<Json_> {
    match st.node.find_deploy(&id).await.map_err(upstream)? {
        Some(j) => Ok(Json(json!({ "found": true, "deploy": j }))),
        None => Ok(Json(json!({ "found": false }))),
    }
}

async fn balance(AxState(st): AxState<Shared>, Path(address): Path<String>) -> R<Json_> {
    Address::parse(&address).map_err(bad)?;
    Ok(Json(st.node.balance(&address).await.map_err(upstream)?))
}

#[derive(Deserialize)]
pub struct FundReq {
    pub address: String,
}

/// Testnets and local shards only: fund a new address from the service key
/// (design §11.5, route 1).
async fn fund(AxState(st): AxState<Shared>, Json(req): Json<FundReq>) -> R<Json_> {
    if !st.config.faucet.enabled {
        return Err(ApiError(StatusCode::NOT_FOUND, "the faucet is disabled".into()));
    }
    let to = Address::parse(&req.address).map_err(bad)?;
    let mut args = BTreeMap::new();
    args.insert("from".to_string(), Value::String(st.service_address().to_string()));
    args.insert("to".to_string(), Value::String(to.to_string()));
    args.insert("amount".to_string(), Value::Int(st.config.faucet.amount));
    let term = catalogue::get(catalogue::TRANSFER).unwrap().render(&args).map_err(bad)?;
    let timestamp = now_ms();
    let valid_after = st.node.valid_after().await.map_err(upstream)?;
    let d = deploy::sign(
        &st.service_key,
        DeployData {
            term,
            timestamp,
            phlo_price: st.config.phlo_price,
            phlo_limit: st.config.default_phlo_limit,
            valid_after_block_number: valid_after,
            shard_id: st.config.shard_id.clone(),
            expiration_timestamp: Some(timestamp + st.config.deploy_ttl_ms),
        },
    );
    let _ = keyfile::public_key_bytes(&st.service_key);
    let id = st.node.deploy(&d).await.map_err(upstream)?;
    Ok(Json(json!({ "deployId": id, "amount": st.config.faucet.amount, "to": to })))
}

/// Serve the built portal shell (`web/dist`) when `static_dir` is configured,
/// with `index.html` for client-side routes.
fn static_files(st: &Shared) -> tower_http::services::ServeDir<tower_http::services::ServeFile> {
    let dir = if st.config.static_dir.is_empty() { "web/dist".to_string() } else { st.config.static_dir.clone() };
    tower_http::services::ServeDir::new(&dir).fallback(tower_http::services::ServeFile::new(format!("{dir}/index.html")))
}
