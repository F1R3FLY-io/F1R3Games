//! Identifiers known before the deploy that creates the object.
//!
//! The node keys its preview of a deploy's unforgeable names on
//! `(deployer, timestamp)` (`POST /api/prepare-deploy`). The portal keys its
//! public identifiers on the same pair, without depending on the order in
//! which the runtime mints names: `hex(blake2b256(kind ‖ 0 ‖ pk ‖ ts_be))[..32]`.
//! The contract refuses an identifier already in use.

use crate::hash::blake2b256;

pub fn derive(kind: &str, deployer_pk: &[u8], timestamp: i64) -> String {
    let mut b = Vec::with_capacity(kind.len() + 1 + deployer_pk.len() + 8);
    b.extend_from_slice(kind.as_bytes());
    b.push(0);
    b.extend_from_slice(deployer_pk);
    b.extend_from_slice(&timestamp.to_be_bytes());
    hex::encode(&blake2b256(&b)[..16])
}

pub const MS_PER_DAY: i64 = 86_400_000;

/// The gallery's day bucket for a timestamp, as the contract computes it.
pub fn day(timestamp_ms: i64) -> i64 {
    timestamp_ms / MS_PER_DAY
}
