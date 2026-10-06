//! Installing the `games` environment.
//!
//! Embers' `insert_signed.rho` pattern: the environment deploy is signed by
//! the service key (which pays) and carries an `insertSigned` signature by
//! the environment key over `(deploy timestamp, service public key, version)`.
//! The registry stores `(version, bundle+{*env})` under the environment
//! key's URI; a later deploy with a higher version replaces it.
//! The service does not propose: validators propose by heartbeat.

use crate::State;
use f1r3games_core::deploy::{self, DeployData};
use f1r3games_core::{catalogue, keyfile, registry, Value};
use std::collections::BTreeMap;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// The version currently registered, if any (`env.probe` at the observer).
pub async fn registered_version(st: &State) -> anyhow::Result<Option<i64>> {
    let t = catalogue::get(catalogue::ENV_PROBE).unwrap();
    let mut args = BTreeMap::new();
    args.insert("env_uri".to_string(), Value::Uri(st.env_uri.clone()));
    let e = st.node.explore(&t.render(&args)?).await?;
    Ok(e.first().as_int())
}

/// Render and sign the environment deploy.
pub fn env_deploy(st: &State, timestamp: i64, valid_after: i64) -> anyhow::Result<f1r3games_core::SignedDeploy> {
    let service_pk = keyfile::public_key_bytes(&st.service_key);
    let env_pk = keyfile::public_key_bytes(&st.env_key);
    let version = st.config.env_version;
    let sig = registry::insert_signed_signature(&st.env_key, timestamp, &service_pk, version);
    let mut args = BTreeMap::new();
    args.insert("env_uri".to_string(), Value::Uri(st.env_uri.clone()));
    args.insert("version".to_string(), Value::Int(version));
    args.insert("public_key".to_string(), Value::Bytes(env_pk));
    args.insert("sig".to_string(), Value::Bytes(sig));
    args.insert("coop".to_string(), Value::str(st.config.coop_address.clone()));
    let term = catalogue::get(catalogue::ENV).unwrap().render(&args)?;
    Ok(deploy::sign(
        &st.service_key,
        DeployData {
            term,
            timestamp,
            phlo_price: st.config.phlo_price,
            phlo_limit: st.config.env_phlo_limit,
            valid_after_block_number: valid_after,
            shard_id: st.config.shard_id.clone(),
            expiration_timestamp: Some(timestamp + st.config.deploy_ttl_ms),
        },
    ))
}

/// Install or upgrade the environment if the registered version is lower.
/// Returns the deploy id when a deploy was made.
pub async fn ensure_env(st: &State) -> anyhow::Result<Option<String>> {
    match registered_version(st).await {
        Ok(Some(v)) if v >= st.config.env_version => {
            tracing::info!(uri = %st.env_uri, version = v, "games environment present");
            return Ok(None);
        }
        Ok(v) => tracing::info!(uri = %st.env_uri, registered = ?v, wanted = st.config.env_version, "installing games environment"),
        Err(e) => tracing::warn!(error = %e, "could not probe the environment; deploying"),
    }
    let valid_after = st.node.valid_after().await?;
    let d = env_deploy(st, now_ms(), valid_after)?;
    let id = st.node.deploy(&d).await?;
    tracing::info!(deploy = %id, "games environment deploy submitted");
    Ok(Some(id))
}

/// The version registered under any environment URI (the probe template).
pub async fn version_at(st: &State, uri: &str) -> anyhow::Result<Option<i64>> {
    let t = catalogue::get(catalogue::ENV_PROBE).unwrap();
    let mut args = BTreeMap::new();
    args.insert("env_uri".to_string(), Value::Uri(uri.to_string()));
    Ok(st.node.explore(&t.render(&args)?).await?.first().as_int())
}

/// Install or upgrade one game's environment under its key.
pub async fn ensure_game_env(st: &State, game: &f1r3games_games::GameSpec, key: &k256::ecdsa::SigningKey, version: i64) -> anyhow::Result<Option<String>> {
    let uri = f1r3games_games::env_uri(key);
    if let Ok(Some(v)) = version_at(st, &uri).await {
        if v >= version {
            tracing::info!(game = game.id, %uri, version = v, "game environment present");
            return Ok(None);
        }
    }
    let valid_after = st.node.valid_after().await?;
    let d = game.env_deploy(key, &st.service_key, &st.env_uri, version, now_ms(), valid_after, &st.config.shard_id, st.config.phlo_price, st.config.env_phlo_limit, st.config.deploy_ttl_ms);
    let id = st.node.deploy(&d).await?;
    tracing::info!(game = game.id, %uri, deploy = %id, "game environment deploy submitted");
    Ok(Some(id))
}
