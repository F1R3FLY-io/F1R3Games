//! Readiness and status (F5).
//!
//! `GET /api/ready[?games=a,b]` answers 200 when the node is reachable, the
//! portal environment is registered at the configured version, and every
//! game named is registered and active; 503 with the reasons otherwise.
//! `f1r3games-service status --json` reports, in addition, each game
//! environment's registered version and each registration's entry and
//! template hashes, which is what a supervisor compares against what it
//! means to have installed.

use crate::State;
use f1r3games_core::Value;
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

fn hashes(m: &Value) -> Json {
    let mut o = serde_json::Map::new();
    if let Some(Value::List(ts)) = m.get("templates") {
        for t in ts {
            if let (Some(id), Some(h)) = (t.get("id").and_then(Value::as_str), t.get("hash").and_then(Value::as_str)) {
                o.insert(id.to_string(), json!(h));
            }
        }
    }
    Json::Object(o)
}

/// One registration as status reports it.
pub fn describe(m: &Value) -> Json {
    if *m == Value::Nil {
        return json!({ "registered": false });
    }
    json!({
        "registered": true,
        "status": m.get("status").and_then(Value::as_str),
        "entry": m.get("entry").and_then(Value::as_str),
        "envUri": m.get("envUri").and_then(Value::as_str),
        "templates": hashes(m),
    })
}

/// `(ready, report)`.
pub async fn ready(st: &State, games: &[String]) -> (bool, Json) {
    let mut reasons: Vec<String> = Vec::new();
    let registered = match crate::bootstrap::registered_version(st).await {
        Ok(v) => v,
        Err(e) => {
            reasons.push(format!("node: {e}"));
            None
        }
    };
    if reasons.is_empty() && registered != Some(st.config.env_version) {
        reasons.push(format!("portal environment registered at {registered:?}, configured {}", st.config.env_version));
    }
    let mut gs = serde_json::Map::new();
    if reasons.is_empty() {
        for g in games {
            match crate::register::registered(st, g).await {
                Ok(m) => {
                    if m.get("status").and_then(Value::as_str) != Some("active") {
                        reasons.push(format!("{g} is not registered and active"));
                    }
                    gs.insert(g.clone(), describe(&m));
                }
                Err(e) => reasons.push(format!("{g}: {e}")),
            }
        }
    }
    let ok = reasons.is_empty();
    (ok, json!({ "ready": ok, "envUri": st.env_uri, "envVersion": st.config.env_version, "registeredVersion": registered, "games": gs, "reasons": reasons }))
}

/// The full report. `game_uris` maps game ids to their environment URIs
/// (known from the game keys); every game in the crate is reported.
pub async fn status(st: &State, game_uris: &BTreeMap<String, String>) -> anyhow::Result<Json> {
    let registered = crate::bootstrap::registered_version(st).await?;
    let mut games = serde_json::Map::new();
    for g in f1r3games_games::GAMES {
        let env = match game_uris.get(g.id) {
            Some(uri) => json!({ "uri": uri, "version": crate::bootstrap::version_at(st, uri).await? }),
            None => Json::Null,
        };
        let reg = crate::register::registered(st, g.id).await?;
        games.insert(g.id.to_string(), json!({ "env": env, "registration": describe(&reg) }));
    }
    Ok(json!({
        "envUri": st.env_uri,
        "envVersion": st.config.env_version,
        "registeredVersion": registered,
        "coopAddress": st.config.coop_address,
        "serviceAddress": st.service_address().to_string(),
        "games": games,
    }))
}
