//! Configuration (TOML).
//!
//! ```toml
//! listen = "127.0.0.1:8640"
//! shard_id = "root"
//! validator_url = "http://127.0.0.1:40413"   # a bonded validator
//! observer_url  = "http://127.0.0.1:40453"   # a read-only node
//! service_key_file = "service-key.json"      # pays env deploy and faucet
//! env_key_file = "env-key.json"              # registry key of the games environment
//! token_secret_file = "token-secret.hex"     # 32+ bytes, hex
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
//! ```

use serde::Deserialize;

fn d_listen() -> String { "127.0.0.1:8640".into() }
fn d_shard() -> String { "root".into() }
fn d_price() -> i64 { 1 }
fn d_limit() -> i64 { 500_000 }
fn d_max() -> i64 { 50_000_000 }
fn d_ttl() -> i64 { 600_000 }
fn d_token_ttl() -> i64 { 3600 }
fn d_version() -> i64 { 1 }
fn d_true() -> bool { true }

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

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    #[serde(default = "d_listen")]
    pub listen: String,
    #[serde(default = "d_shard")]
    pub shard_id: String,
    pub validator_url: String,
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
}

impl Config {
    pub fn from_toml(s: &str) -> anyhow::Result<Config> {
        let c: Config = toml::from_str(s)?;
        f1r3games_core::Address::parse(&c.coop_address)
            .map_err(|e| anyhow::anyhow!("coop_address: {e}"))?;
        Ok(c)
    }
}
