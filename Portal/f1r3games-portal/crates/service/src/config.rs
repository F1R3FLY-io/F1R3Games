//! Configuration (TOML).
//!
//! ```toml
//! listen = "127.0.0.1:8640"                  # or a list: ["127.0.0.1:40700", "[::1]:40700"]
//! public_host = "localhost:40700"            # optional: the only Host served (F4)
//! shard_id = "root"
//! validator_url = "http://127.0.0.1:40413"   # a bonded validator
//! validator_urls = ["http://127.0.0.1:40413", "http://127.0.0.1:40423"]  # optional (F7)
//! observer_url  = "http://127.0.0.1:40453"   # a read-only node
//! service_key_file = "service-key.json"      # pays env deploy and faucet (or F1R3GAMES_SERVICE_KEY)
//! env_key_file = "env-key.json"              # registry key of the games environment (or F1R3GAMES_ENV_KEY)
//! token_secret_file = "token-secret.hex"     # 32+ bytes, hex (or F1R3GAMES_TOKEN_SECRET)
//! coop_address = "1111..."                   # F1R3FLY.io Cooperative: game registry governance
//! env_version = 1
//! phlo_price = 1
//! default_phlo_limit = 500000
//! max_phlo_limit = 50000000
//! env_phlo_limit = 50000000
//! deploy_ttl_ms = 600000
//! token_ttl_secs = 3600
//! bootstrap_env = true
//! cors_origins = ["http://localhost:5173"]
//! portal_base_url = "http://localhost:5173"
//! [faucet]
//! enabled = true
//! amount = 100000000
//! [relay]                                    # F1R3Ink's relay (F1R3Ink design §8)
//! enabled = true
//! base_url = "http://localhost:40700/api/relay"  # the manifests' relay base (games-manifests --relay-base)
//! key_file = "relay-key.json"                # or F1R3GAMES_RELAY_KEY; named on chain with `f1r3games ink set-relay`
//! secret_file = "relay-secret.hex"           # 32+ bytes, hex (or F1R3GAMES_RELAY_SECRET): derives handles
//! window_blocks = 3
//! per_hour = 30
//! [[origins]]                                # a game client on an origin of its own (F2)
//! id = "f1r3pix"
//! listen = ["127.0.0.1:40701", "[::1]:40701"]
//! public_host = "localhost:40701"
//! dir = "games"                              # serves dir/f1r3pix at /f1r3pix/
//! ```

use serde::Deserialize;

fn d_listen() -> Listen { Listen::One("127.0.0.1:8640".into()) }
fn d_shard() -> String { "root".into() }
fn d_price() -> i64 { 1 }
fn d_limit() -> i64 { 500_000 }
fn d_max() -> i64 { 50_000_000 }
fn d_ttl() -> i64 { 600_000 }
fn d_token_ttl() -> i64 { 3600 }
fn d_version() -> i64 { 1 }
fn d_true() -> bool { true }

/// One listen address or several (F4: both loopback families).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Listen {
    One(String),
    Many(Vec<String>),
}

impl Listen {
    pub fn addrs(&self) -> Vec<String> {
        match self {
            Listen::One(s) => vec![s.clone()],
            Listen::Many(v) => v.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Faucet {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub amount: i64,
}

impl Default for Faucet {
    fn default() -> Self {
        Faucet { enabled: false, amount: 0 }
    }
}

fn d_window() -> i64 { 3 }
fn d_per_hour() -> usize { 30 }
fn d_relay_phlo() -> i64 { 5_000_000 }
fn d_poll() -> u64 { 2_000 }

/// F1R3Ink's relay (F1R3Ink design §8, D10): off unless enabled.
#[derive(Clone, Debug, Deserialize)]
pub struct RelayConfig {
    #[serde(default)]
    pub enabled: bool,
    /// The base the manifests name: requests must carry `<base_url>/<game>`.
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub key_file: String,
    #[serde(default)]
    pub secret_file: String,
    /// Blocks between batches.
    #[serde(default = "d_window")]
    pub window_blocks: i64,
    /// Relayed requests per player per hour.
    #[serde(default = "d_per_hour")]
    pub per_hour: usize,
    #[serde(default = "d_relay_phlo")]
    pub phlo_limit: i64,
    /// How often to look for a new block (ms).
    #[serde(default = "d_poll")]
    pub poll_ms: u64,
}

impl Default for RelayConfig {
    fn default() -> Self {
        RelayConfig { enabled: false, base_url: String::new(), key_file: String::new(), secret_file: String::new(), window_blocks: d_window(), per_hour: d_per_hour(), phlo_limit: d_relay_phlo(), poll_ms: d_poll() }
    }
}

/// A game client served from an origin of its own (F2).
#[derive(Clone, Debug, Deserialize)]
pub struct GameOrigin {
    /// The game id; the origin serves `<dir>/<id>/` at `/<id>/` and nothing else.
    pub id: String,
    pub listen: Listen,
    /// The only `Host` this origin answers (F4); loopback literals are redirected to it.
    #[serde(default)]
    pub public_host: Option<String>,
    /// The directory holding `<id>/` (a built client: `index.html`, `preview/…`).
    pub dir: String,
    /// The origins allowed to frame this game (`Content-Security-Policy:
    /// frame-ancestors`). Defaults to the origin of `portal_base_url`.
    #[serde(default)]
    pub frame_ancestors: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    #[serde(default = "d_listen")]
    pub listen: Listen,
    /// The only `Host` the portal answers (F4). Requests naming a loopback
    /// literal at the same port are redirected here; any other Host gets 421.
    #[serde(default)]
    pub public_host: Option<String>,
    #[serde(default = "d_shard")]
    pub shard_id: String,
    /// A bonded validator. Either this or `validator_urls` must be given.
    #[serde(default)]
    pub validator_url: String,
    /// Several validators (F7): one is drawn per deploy, and another is tried
    /// when one cannot be reached.
    #[serde(default)]
    pub validator_urls: Vec<String>,
    pub observer_url: String,
    #[serde(default)]
    pub service_key_file: String,
    #[serde(default)]
    pub env_key_file: String,
    #[serde(default)]
    pub token_secret_file: String,
    pub coop_address: String,
    #[serde(default = "d_version")]
    pub env_version: i64,
    #[serde(default = "d_price")]
    pub phlo_price: i64,
    #[serde(default = "d_limit")]
    pub default_phlo_limit: i64,
    #[serde(default = "d_max")]
    pub max_phlo_limit: i64,
    #[serde(default = "d_max")]
    pub env_phlo_limit: i64,
    #[serde(default = "d_ttl")]
    pub deploy_ttl_ms: i64,
    #[serde(default = "d_token_ttl")]
    pub token_ttl_secs: i64,
    #[serde(default = "d_true")]
    pub bootstrap_env: bool,
    #[serde(default)]
    pub cors_origins: Vec<String>,
    #[serde(default)]
    pub portal_base_url: String,
    /// Directory of the built portal shell to serve (default `web/dist`).
    #[serde(default)]
    pub static_dir: String,
    #[serde(default)]
    pub faucet: Faucet,
    /// Game clients served by this process, each on its own origin (F2).
    #[serde(default)]
    pub origins: Vec<GameOrigin>,
    #[serde(default)]
    pub relay: RelayConfig,
}

impl Config {
    pub fn from_toml(s: &str) -> anyhow::Result<Config> {
        let c: Config = toml::from_str(s)?;
        f1r3games_core::Address::parse(&c.coop_address)
            .map_err(|e| anyhow::anyhow!("coop_address: {e}"))?;
        anyhow::ensure!(!c.validators().is_empty(), "validator_url or validator_urls must be given");
        for o in &c.origins {
            anyhow::ensure!(
                !o.id.is_empty() && o.id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'),
                "origins: bad game id {:?}",
                o.id
            );
            anyhow::ensure!(!o.listen.addrs().is_empty(), "origins.{}: no listen address", o.id);
        }
        if c.relay.enabled {
            anyhow::ensure!(c.relay.base_url.starts_with("http"), "relay.base_url must be an http(s) URL");
            anyhow::ensure!(c.relay.window_blocks >= 1 && c.relay.per_hour >= 1, "relay: window_blocks and per_hour must be at least 1");
        }
        Ok(c)
    }

    /// Every configured validator, `validator_urls` first, without repeats.
    pub fn validators(&self) -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        for u in self.validator_urls.iter().chain(std::iter::once(&self.validator_url)) {
            let u = u.trim_end_matches('/').to_string();
            if !u.is_empty() && !v.contains(&u) {
                v.push(u);
            }
        }
        v
    }

    /// The scheme and authority of `portal_base_url` (for `frame-ancestors`).
    pub fn portal_origin(&self) -> Option<String> {
        let u = self.portal_base_url.trim();
        let (scheme, rest) = u.split_once("://")?;
        let host = rest.split('/').next()?;
        (!host.is_empty()).then(|| format!("{scheme}://{host}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COOP: &str = "1111sQDawGqQKzEQQ1zNKyqxDKBmzDiZTWURnPh2Ah3F2DdftKdNE";

    #[test]
    fn the_old_form_still_reads() {
        let c = Config::from_toml(&format!("listen = \"127.0.0.1:8640\"\nvalidator_url = \"http://v/\"\nobserver_url = \"http://o\"\ncoop_address = \"{COOP}\"\n")).unwrap();
        assert_eq!(c.listen.addrs(), vec!["127.0.0.1:8640"]);
        assert_eq!(c.validators(), vec!["http://v"]);
        assert!(c.origins.is_empty() && c.public_host.is_none());
        assert!(!c.relay.enabled && c.relay.window_blocks == 3 && c.relay.per_hour == 30);
    }

    #[test]
    fn lists_origins_and_validators() {
        let c = Config::from_toml(&format!(
            r#"listen = ["127.0.0.1:40700", "[::1]:40700"]
public_host = "localhost:40700"
validator_urls = ["http://a", "http://b"]
validator_url = "http://a"
observer_url = "http://o"
coop_address = "{COOP}"
portal_base_url = "http://localhost:40700"
[[origins]]
id = "f1r3pix"
listen = ["127.0.0.1:40701", "[::1]:40701"]
dir = "games"
"#
        ))
        .unwrap();
        assert_eq!(c.listen.addrs().len(), 2);
        assert_eq!(c.validators(), vec!["http://a", "http://b"]);
        assert_eq!(c.origins[0].id, "f1r3pix");
        assert_eq!(c.portal_origin().as_deref(), Some("http://localhost:40700"));
    }

    #[test]
    fn refuses_no_validator_and_bad_ids() {
        assert!(Config::from_toml(&format!("observer_url = \"http://o\"\ncoop_address = \"{COOP}\"\n")).is_err());
        let bad = format!("validator_url = \"http://v\"\nobserver_url = \"http://o\"\ncoop_address = \"{COOP}\"\n[[origins]]\nid = \"../x\"\nlisten = \"127.0.0.1:1\"\ndir = \"d\"\n");
        assert!(Config::from_toml(&bad).is_err());
    }
}
