//! # f1r3games-service
//!
//! Stateless, in the sense of design Requirement 8: everything durable is on
//! the shard; the service holds only its configuration and keys.
//!
//! * `POST /api/prepare` renders a catalogue template with typed arguments,
//!   builds the `DeployData`, and returns its bytes with a token (HMAC over
//!   the bytes, the deployer and an expiry) — Embers' prepare/send protocol.
//! * `POST /api/send` checks the token and the signature and forwards the
//!   deploy to a validator. The service never proposes.
//! * `POST /api/explore` and the `GET` read routes run explore templates at an
//!   observer and return typed values with the block hash they reflect.
//! * At start-up (or `f1r3games-service bootstrap`) the `games` environment is
//!   installed or upgraded under the service's registry key.

pub mod bootstrap;
pub mod config;
pub mod routes;
pub mod token;

use f1r3games_core::{keyfile, registry, Address};
use f1r3games_node::Node;
use k256::ecdsa::SigningKey;
use std::sync::Arc;

pub struct State {
    pub config: config::Config,
    pub node: Node,
    /// Pays for the environment deploy and the testnet faucet.
    pub service_key: SigningKey,
    /// The registry key whose URI names the `games` environment.
    pub env_key: SigningKey,
    pub env_uri: String,
    pub token_secret: Vec<u8>,
}

pub type Shared = Arc<State>;

impl State {
    pub fn new(config: config::Config, service_key: SigningKey, env_key: SigningKey, token_secret: Vec<u8>) -> State {
        let env_uri = registry::uri_for_public_key(&keyfile::public_key_bytes(&env_key));
        let node = Node::new(&config.validator_url, &config.observer_url);
        State { config, node, service_key, env_key, env_uri, token_secret }
    }

    pub fn service_address(&self) -> Address {
        Address::from_public_key(self.service_key.verifying_key())
    }
}
