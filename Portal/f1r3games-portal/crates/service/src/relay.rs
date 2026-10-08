//! F1R3Ink's relay (design §8, D2, D10): the one way to make an ink anonymous
//! on a public chain is for someone other than the inker to deploy it.
//!
//! * `POST /api/relay/{game}` takes `{message, publicKey, signature}`: a
//!   request the Portal shell signed with the player's key under the domain
//!   `f1r3games/relay/v1` (`f1r3games_core::relay`). The relay checks the
//!   signature, that the message names this relay and game, and that the
//!   signer plays the round, then:
//!   * `ink {target, ink}` queues an anonymous ink on the signer's stripe on
//!     `target` and answers `{queued, handle}`;
//!   * `reveal {target}` deploys `relayReveal` at once (one way, D2);
//!   * `handles {}` lists the signer's handles on every other player.
//! * Once per window (three blocks by default) the queue is submitted as one
//!   `f1r3ink.relayInk` per instance, in random order, signed by the relay key.
//!
//! Handles are `HMAC-SHA256(secret, "f1r3ink/handle/v1" ‖ instance ‖ 0 ‖ target ‖ 0 ‖ inker)[..16]`,
//! so the relay keeps no table. It keeps nothing durable: the queue and the
//! rate limits are in memory, and a restart loses at most one window of inks,
//! which the inkers' clients report as never landed. The relay is trusted
//! (D10): it learns who inks whom; it cannot read a sealed colour or forge an ink.

use crate::bootstrap::now_ms;
use crate::routes::{resolve, with_env, ApiError};
use crate::Shared;
use axum::http::StatusCode;
use f1r3games_core::deploy::{self, DeployData};
use f1r3games_core::relay as wire;
use f1r3games_core::template::TemplateKind;
use f1r3games_core::{Address, Value};
use f1r3games_games::ink;
use k256::ecdsa::SigningKey;
use serde::Deserialize;
use serde_json::{json, Value as J};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

/// The game the relay serves (the only one declaring the capability today).
pub const GAME: &str = "f1r3ink";
const HOUR_MS: i64 = 3_600_000;
const BATCH: usize = 64;

#[derive(Clone, Debug)]
struct Entry {
    target: String,
    handle: String,
    ink: Value,
}

pub struct Relay {
    pub key: SigningKey,
    pub secret: Vec<u8>,
    pub config: crate::config::RelayConfig,
    /// instance → entries waiting for the next window.
    queue: Mutex<BTreeMap<String, Vec<Entry>>>,
    /// inker → times of their relayed requests in the last hour.
    recent: Mutex<HashMap<String, VecDeque<i64>>>,
    /// (instance, handle) → when its last ink was accepted.
    last: Mutex<HashMap<(String, String), i64>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayReq {
    pub message: String,
    pub public_key: String,
    pub signature: String,
}

fn err(code: StatusCode, m: impl ToString) -> ApiError {
    ApiError(code, m.to_string())
}

fn bad(m: impl ToString) -> ApiError {
    err(StatusCode::BAD_REQUEST, m)
}

impl Relay {
    pub fn new(key: SigningKey, secret: Vec<u8>, config: crate::config::RelayConfig) -> Relay {
        Relay { key, secret, config, queue: Default::default(), recent: Default::default(), last: Default::default() }
    }

    pub fn address(&self) -> Address {
        Address::from_public_key(self.key.verifying_key())
    }

    /// The URL a manifest names for `game`, which every request must carry.
    pub fn url_for(&self, game: &str) -> String {
        format!("{}/{game}", self.config.base_url.trim_end_matches('/'))
    }

    pub fn handle(&self, instance: &str, target: &str, inker: &str) -> String {
        ink::handle(&self.secret, instance, target, inker)
    }

    /// How many entries wait, over all instances.
    pub fn queued(&self) -> usize {
        self.queue.lock().unwrap().values().map(Vec::len).sum()
    }

    /// Count a request against the inker's hourly cap (so the Cooperative's
    /// phlo cannot be drained through the relay).
    fn charge(&self, inker: &str, now: i64) -> Result<(), ApiError> {
        let mut recent = self.recent.lock().unwrap();
        let q = recent.entry(inker.to_string()).or_default();
        while q.front().is_some_and(|t| *t <= now - HOUR_MS) {
            q.pop_front();
        }
        if q.len() >= self.config.per_hour {
            return Err(err(StatusCode::TOO_MANY_REQUESTS, format!("at most {} relayed requests an hour", self.config.per_hour)));
        }
        q.push_back(now);
        Ok(())
    }

    /// Queue an entry, replacing one already waiting on the same stripe.
    fn enqueue(&self, instance: &str, e: Entry) {
        let mut q = self.queue.lock().unwrap();
        let v = q.entry(instance.to_string()).or_default();
        v.retain(|x| !(x.target == e.target && x.handle == e.handle));
        v.push(e);
    }

    fn take(&self) -> BTreeMap<String, Vec<Entry>> {
        std::mem::take(&mut *self.queue.lock().unwrap())
    }

    /// Put back entries a failed deploy did not write, unless newer ones wait.
    fn requeue(&self, instance: &str, entries: Vec<Entry>) {
        let mut q = self.queue.lock().unwrap();
        let v = q.entry(instance.to_string()).or_default();
        for e in entries {
            if !v.iter().any(|x| x.target == e.target && x.handle == e.handle) {
                v.push(e);
            }
        }
    }
}

/// The plain JSON ink a client sends, as the environment takes it:
/// `{"c": n}` on a public flag, `{"sealed": hex}` on a private one, `null` to lift.
pub fn ink_value(j: &J) -> Result<Value, String> {
    match j {
        J::Null => Ok(Value::Nil),
        J::Object(o) if o.len() == 1 && o.contains_key("c") => {
            let c = o["c"].as_i64().filter(|c| (0..ink::MAX_PALETTE as i64).contains(c)).ok_or("a colour is a palette index")?;
            Ok(Value::map([("c", Value::Int(c))]))
        }
        J::Object(o) if o.len() == 1 && o.contains_key("sealed") => {
            let b = o["sealed"].as_str().and_then(|s| hex::decode(s).ok()).ok_or("a sealed ink is hex")?;
            if b.is_empty() || b.len() > ink::MAX_SEALED {
                return Err("sealed ink too long".into());
            }
            Ok(Value::map([("sealed", Value::Bytes(b))]))
        }
        _ => Err("an ink is {\"c\": n}, {\"sealed\": hex} or null".into()),
    }
}

/// The round as `f1r3ink.players` reads it.
async fn players(st: &Shared, instance: &str) -> Result<Value, ApiError> {
    let t = resolve(st, &format!("{GAME}.players"), Some(GAME), TemplateKind::Explore).await?;
    let mut args = BTreeMap::from([("instance".to_string(), Value::str(instance))]);
    with_env(st, &t, &mut args)?;
    let e = st.node.explore(&t.render(&args).map_err(bad)?).await.map_err(|e| err(StatusCode::BAD_GATEWAY, e))?;
    e.first().into_outcome().map_err(bad)
}

/// Sign `template` with the relay key and send it to a validator.
async fn deploy_as_relay(st: &Shared, relay: &Relay, template: &str, args: BTreeMap<String, Value>) -> Result<String, ApiError> {
    let t = resolve(st, template, Some(GAME), TemplateKind::Deploy).await?;
    let mut args = args;
    with_env(st, &t, &mut args)?;
    let term = t.render(&args).map_err(bad)?;
    let timestamp = now_ms();
    let valid_after = st.node.valid_after().await.map_err(|e| err(StatusCode::BAD_GATEWAY, e))?;
    let d = deploy::sign(
        &relay.key,
        DeployData {
            term,
            timestamp,
            phlo_price: st.config.phlo_price,
            phlo_limit: relay.config.phlo_limit,
            valid_after_block_number: valid_after,
            shard_id: st.config.shard_id.clone(),
            expiration_timestamp: Some(timestamp + st.config.deploy_ttl_ms),
        },
    );
    st.node.deploy(&d).await.map_err(|e| err(StatusCode::BAD_GATEWAY, e))
}

/// One signed request (design §8, Figure 7).
pub async fn serve(st: &Shared, game: &str, req: RelayReq) -> Result<J, ApiError> {
    let Some(relay) = st.relay.as_ref() else { return Err(err(StatusCode::NOT_FOUND, "this portal runs no relay")) };
    let pk = hex::decode(&req.public_key).map_err(|_| bad("publicKey must be hex"))?;
    let sig = hex::decode(&req.signature).map_err(|_| bad("signature must be hex"))?;
    let now = now_ms();
    let m = wire::verify(&req.message, &pk, &sig, now).map_err(|e| err(StatusCode::FORBIDDEN, e))?;
    if m.game != game || game != GAME {
        return Err(bad(format!("the relay serves {GAME} only")));
    }
    if m.relay != relay.url_for(game) {
        return Err(err(StatusCode::FORBIDDEN, "the request names another relay"));
    }
    let round = players(st, &m.instance).await?;
    let roster = match round.get("players") {
        Some(Value::Map(p)) => p.clone(),
        _ => BTreeMap::new(),
    };
    let me = &m.address;
    if !roster.get(me).is_some_and(|p| p.get("left").and_then(Value::as_bool) != Some(true)) {
        return Err(err(StatusCode::FORBIDDEN, "the relay serves only players of the round"));
    }
    if m.op == "handles" {
        let hs: serde_json::Map<String, J> = roster.keys().filter(|t| *t != me).map(|t| (t.clone(), json!(relay.handle(&m.instance, t, me)))).collect();
        return Ok(json!({ "handles": hs }));
    }
    if round.get("status").and_then(Value::as_str) != Some("active") {
        return Err(bad("the round is not active"));
    }
    let target = m.params.get("target").and_then(J::as_str).ok_or_else(|| bad("a target is required"))?.to_string();
    if target == *me {
        return Err(bad("a target other than yourself"));
    }
    let Some(them) = roster.get(&target) else { return Err(bad("they have not entered the round")) };
    let h = relay.handle(&m.instance, &target, me);
    match m.op.as_str() {
        "reveal" => {
            relay.charge(me, now)?;
            let args = BTreeMap::from([
                ("instance".to_string(), Value::str(m.instance.clone())),
                ("target".to_string(), Value::str(target.clone())),
                ("handle".to_string(), Value::str(h.clone())),
                ("address".to_string(), Value::str(me.clone())),
            ]);
            let id = deploy_as_relay(st, relay, &format!("{GAME}.relayReveal"), args).await?;
            Ok(json!({ "handle": h, "revealed": true, "deployId": id }))
        }
        "ink" => {
            if round.get("anonymous").and_then(Value::as_bool) != Some(true) {
                return Err(bad("this round does not allow anonymous ink"));
            }
            let present = roster.values().filter(|p| p.get("left").and_then(Value::as_bool) != Some(true)).count() as i64;
            let min = round.get("anonMin").and_then(Value::as_int).unwrap_or(5);
            if present < min {
                return Err(bad(format!("anonymous ink needs {min} players in the round")));
            }
            let ink = ink_value(m.params.get("ink").unwrap_or(&J::Null)).map_err(bad)?;
            // The form must suit the target's flag now; the environment checks again.
            let public = them.get("flag").and_then(Value::as_str) == Some("public");
            match ink.get("c").or(ink.get("sealed")) {
                Some(Value::Int(_)) if !public => return Err(err(StatusCode::CONFLICT, "their flag is private: seal the ink")),
                Some(Value::Bytes(_)) if public => return Err(err(StatusCode::CONFLICT, "their flag is public: ink in the clear")),
                _ => {}
            }
            let gap = round.get("minInterval").and_then(Value::as_int).unwrap_or(0);
            let key = (m.instance.clone(), h.clone());
            if let Some(t) = relay.last.lock().unwrap().get(&key) {
                if now < t + gap {
                    return Err(bad("too soon"));
                }
            }
            relay.charge(me, now)?;
            relay.last.lock().unwrap().insert(key, now);
            relay.enqueue(&m.instance, Entry { target, handle: h.clone(), ink });
            Ok(json!({ "queued": true, "handle": h }))
        }
        other => Err(bad(format!("unknown op {other}"))),
    }
}

/// A uniformly shuffled copy (Fisher–Yates on fresh random bytes).
fn shuffle<T>(mut v: Vec<T>) -> Vec<T> {
    for i in (1..v.len()).rev() {
        let mut b = [0u8; 8];
        f1r3games_core::hash::random_bytes(&mut b);
        let j = (u64::from_le_bytes(b) % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
    v
}

/// Submit everything queued: one `relayInk` per instance and 64 entries, in random order.
pub async fn flush(st: &Shared) -> Vec<String> {
    let Some(relay) = st.relay.as_ref() else { return vec![] };
    let mut ids = vec![];
    for (instance, entries) in relay.take() {
        for chunk in shuffle(entries).chunks(BATCH) {
            let batch = Value::List(chunk.iter().map(|e| Value::List(vec![Value::str(e.target.clone()), Value::str(e.handle.clone()), e.ink.clone()])).collect());
            let args = BTreeMap::from([("instance".to_string(), Value::str(instance.clone())), ("batch".to_string(), batch)]);
            match deploy_as_relay(st, relay, &format!("{GAME}.relayInk"), args).await {
                Ok(id) => {
                    tracing::info!(instance = %instance, inks = chunk.len(), deploy = %id, "relayed a batch");
                    ids.push(id);
                }
                Err(ApiError(code, e)) => {
                    tracing::warn!(instance = %instance, %code, error = %e, "relay batch failed; kept for the next window");
                    if code == StatusCode::BAD_GATEWAY {
                        relay.requeue(&instance, chunk.to_vec());
                    }
                }
            }
        }
    }
    ids
}

/// The relay's clock: flush when `window_blocks` blocks have passed since
/// the last batch and something waits.
pub async fn run(st: Shared) {
    let Some(relay) = st.relay.as_ref() else { return };
    let poll = Duration::from_millis(relay.config.poll_ms.max(200));
    let mut last: Option<i64> = None;
    tracing::info!(address = %relay.address(), url = %relay.url_for(GAME), "relay ready");
    loop {
        tokio::time::sleep(poll).await;
        let n = match st.node.valid_after().await {
            Ok(n) => n,
            Err(e) => {
                tracing::debug!(error = %e, "relay: no block number");
                continue;
            }
        };
        let since = *last.get_or_insert(n);
        if relay.queued() > 0 && n - since >= relay.config.window_blocks {
            flush(&st).await;
            last = Some(n);
        } else if relay.queued() == 0 {
            last = Some(n);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inks_take_the_environment_forms() {
        assert_eq!(ink_value(&J::Null), Ok(Value::Nil));
        assert_eq!(ink_value(&json!({"c": 3})), Ok(Value::map([("c", Value::Int(3))])));
        assert_eq!(ink_value(&json!({"sealed": "a1b2"})), Ok(Value::map([("sealed", Value::Bytes(vec![0xa1, 0xb2]))])));
        assert!(ink_value(&json!({"c": 32})).is_err());
        assert!(ink_value(&json!({"c": 1, "sealed": "00"})).is_err());
        assert!(ink_value(&json!({"sealed": "00".repeat(513)})).is_err());
        assert!(ink_value(&json!("red")).is_err());
    }

    #[test]
    fn shuffling_keeps_every_entry() {
        let mut v = shuffle((0..100).collect::<Vec<_>>());
        v.sort();
        assert_eq!(v, (0..100).collect::<Vec<_>>());
    }
}
