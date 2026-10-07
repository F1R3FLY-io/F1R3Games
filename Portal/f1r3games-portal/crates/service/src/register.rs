//! Headless registration of games (F3).
//!
//! `games.register` is accepted only from the `coop_address` rendered into
//! the environment. Here the Cooperative's key signs the deploy directly (it
//! comes from `F1R3GAMES_COOP_KEY` or a key file), so registering needs no
//! keystore or passphrase. A game already registered with the same manifest
//! is skipped, and every registration is waited for by reading the registry
//! back, so the command is idempotent and can be re-run after interruption.

use crate::bootstrap::now_ms;
use crate::State;
use f1r3games_core::deploy::{self, DeployData};
use f1r3games_core::{catalogue, Address, Value};
use k256::ecdsa::SigningKey;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

/// Phlo for one registration (the CLI uses the same).
pub const REGISTER_PHLO: i64 = 5_000_000;

/// The registry entry for `game` (`games.get`); `Nil` when absent.
pub async fn registered(st: &State, game: &str) -> anyhow::Result<Value> {
    let t = catalogue::get("games.get").expect("games.get is in the catalogue");
    let mut args = BTreeMap::new();
    args.insert("game".to_string(), Value::str(game));
    args.insert("env_uri".to_string(), Value::Uri(st.env_uri.clone()));
    let e = st.node.explore(&t.render(&args)?).await?;
    e.first().into_outcome().map_err(|m| anyhow::anyhow!("games.get {game}: {m}"))
}

fn template_hashes(m: &Value) -> BTreeSet<(String, String)> {
    let mut s = BTreeSet::new();
    if let Some(Value::List(ts)) = m.get("templates") {
        for t in ts {
            let id = t.get("id").and_then(Value::as_str).unwrap_or_default();
            let h = t.get("hash").and_then(Value::as_str).unwrap_or_default();
            s.insert((id.to_string(), h.to_string()));
        }
    }
    s
}

fn renderers(m: &Value) -> BTreeSet<(String, String)> {
    let mut s = BTreeSet::new();
    if let Some(Value::List(gs)) = m.get("galleries") {
        for g in gs {
            let k = g.get("kind").and_then(Value::as_str).unwrap_or_default();
            let r = g.get("renderer").and_then(Value::as_str).unwrap_or_default();
            s.insert((k.to_string(), r.to_string()));
        }
    }
    s
}

/// Whether the registry entry `chain` is an active registration of `wanted`.
/// Compared by what decides behaviour: id, entry, environment URI, gallery
/// renderers, capabilities and every template's id and hash. (Sources are
/// not compared byte for byte: the node returns them with its own escaping;
/// the hash is what the service checks before rendering.)
pub fn matches(chain: &Value, wanted: &Value) -> bool {
    let s = |m: &Value, k: &str| m.get(k).and_then(Value::as_str).map(str::to_string);
    chain.get("status").and_then(Value::as_str) == Some("active")
        && s(chain, "id") == s(wanted, "id")
        && s(chain, "entry") == s(wanted, "entry")
        && s(chain, "envUri") == s(wanted, "envUri")
        && chain.get("capabilities") == wanted.get("capabilities")
        && renderers(chain) == renderers(wanted)
        && template_hashes(chain) == template_hashes(wanted)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Current,
    Registered(String),
}

/// Register each `(id, manifest)` that is not already registered as given,
/// signing with `coop`; wait up to `wait` for each to read back.
pub async fn register_all(st: &State, coop: &SigningKey, entries: &[(String, Value)], wait: Duration) -> anyhow::Result<Vec<(String, Outcome)>> {
    let me = Address::from_public_key(coop.verifying_key()).to_string();
    anyhow::ensure!(
        me == st.config.coop_address,
        "the key given is {me}, not the Cooperative's ({}); games.register would refuse it",
        st.config.coop_address
    );
    let t = catalogue::get("games.register").expect("games.register is in the catalogue");
    let mut out = Vec::new();
    for (id, manifest) in entries {
        anyhow::ensure!(manifest.get("id").and_then(Value::as_str) == Some(id.as_str()), "{id}: the manifest names another game");
        if matches(&registered(st, id).await?, manifest) {
            tracing::info!(game = %id, "registered and current");
            out.push((id.clone(), Outcome::Current));
            continue;
        }
        let mut args = BTreeMap::new();
        args.insert("manifest".to_string(), manifest.clone());
        args.insert("env_uri".to_string(), Value::Uri(st.env_uri.clone()));
        let timestamp = now_ms();
        let d = deploy::sign(
            coop,
            DeployData {
                term: t.render(&args)?,
                timestamp,
                phlo_price: st.config.phlo_price,
                phlo_limit: REGISTER_PHLO,
                valid_after_block_number: st.node.valid_after().await?,
                shard_id: st.config.shard_id.clone(),
                expiration_timestamp: Some(timestamp + st.config.deploy_ttl_ms),
            },
        );
        let deploy_id = st.node.deploy(&d).await?;
        tracing::info!(game = %id, deploy = %deploy_id, "games.register submitted");
        let t0 = Instant::now();
        loop {
            match registered(st, id).await {
                Ok(v) if matches(&v, manifest) => break,
                Ok(_) | Err(_) if t0.elapsed() < wait => tokio::time::sleep(Duration::from_secs(2)).await,
                Ok(_) => anyhow::bail!("{id}: not registered after {}s (deploy {deploy_id}); see the validator's log", wait.as_secs()),
                Err(e) => return Err(e),
            }
        }
        out.push((id.clone(), Outcome::Registered(deploy_id)));
    }
    Ok(out)
}

/// Read a manifests file as `games-manifests` writes it.
pub fn read_manifests(text: &str, only: &[String]) -> anyhow::Result<Vec<(String, Value)>> {
    let list: Vec<serde_json::Value> = serde_json::from_str(text)?;
    let mut out = Vec::new();
    for e in list {
        let id = e["id"].as_str().ok_or_else(|| anyhow::anyhow!("a manifest entry has no id"))?.to_string();
        if !only.is_empty() && !only.contains(&id) {
            continue;
        }
        out.push((id, Value::from_typed_json(&e["manifest"])?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pix(entry: &str) -> Value {
        let key = f1r3games_core::keyfile::generate();
        f1r3games_games::get("f1r3pix").unwrap().manifest(&f1r3games_games::env_uri(&key), entry)
    }

    fn registered_as(m: &Value) -> Value {
        let Value::Map(mut x) = m.clone() else { panic!() };
        x.insert("status".into(), Value::str("active"));
        x.insert("registeredAt".into(), Value::Int(7));
        // The node hands sources back with its own escaping.
        if let Some(Value::List(ts)) = x.get_mut("templates") {
            for t in ts {
                if let Value::Map(t) = t {
                    let s = t.get("source").and_then(Value::as_str).unwrap().replace('"', "\\\"");
                    t.insert("source".into(), Value::str(s));
                }
            }
        }
        Value::Map(x)
    }

    #[test]
    fn a_registration_matches_its_manifest_and_nothing_else() {
        let m = pix("http://localhost:40701");
        assert!(matches(&registered_as(&m), &m));
        assert!(!matches(&Value::Nil, &m));
        assert!(!matches(&m, &m), "not active");
        let Value::Map(mut retired) = registered_as(&m) else { panic!() };
        retired.insert("status".into(), Value::str("retired"));
        assert!(!matches(&Value::Map(retired), &m));
        let moved = pix("http://localhost:40711");
        assert!(!matches(&registered_as(&m), &moved), "another entry or key");
    }

    #[test]
    fn reads_the_manifests_file() {
        let m = pix("http://localhost:40701");
        let text = serde_json::to_string(&serde_json::json!([{ "id": "f1r3pix", "manifest": m.to_typed_json() }, { "id": "f1r3beat", "manifest": m.to_typed_json() }])).unwrap();
        let all = read_manifests(&text, &[]).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].1, m);
        assert_eq!(read_manifests(&text, &["f1r3beat".into()]).unwrap().len(), 1);
    }
}
