//! F1R3Cap addresses.
//!
//! F1R3Node-Rust (`rholang/src/rust/interpreter/util/vault_address.rs`)
//! derives a vault address from the 65-byte uncompressed public key `pk` as
//!
//! ```text
//! base58( 000000 ‖ 00 ‖ keccak256(keccak256(pk[1..])[12..]) ‖ c )
//! ```
//!
//! where `c` is the first four bytes of BLAKE2b-256 of everything before it.

use crate::hash::{blake2b256, keccak256};
use k256::ecdsa::VerifyingKey;
use serde::{Deserialize, Serialize};
use std::fmt;

const PREFIX: [u8; 4] = [0, 0, 0, 0];

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Address(String);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AddressError {
    #[error("not base58")]
    NotBase58,
    #[error("not a F1R3Cap address (length or prefix)")]
    NotF1r3Cap,
    #[error("checksum mismatch")]
    Checksum,
}

impl Address {
    pub fn from_public_key(pk: &VerifyingKey) -> Address {
        Self::from_sec1_uncompressed(pk.to_encoded_point(false).as_bytes())
    }

    /// From the 65-byte uncompressed encoding (`04 ‖ x ‖ y`).
    pub fn from_sec1_uncompressed(pk: &[u8]) -> Address {
        let key_hash = keccak256(&pk[1..]);
        let eth = keccak256(&key_hash[12..]);
        let mut payload = PREFIX.to_vec();
        payload.extend_from_slice(&eth);
        let c = blake2b256(&payload);
        payload.extend_from_slice(&c[..4]);
        Address(bs58::encode(payload).into_string())
    }

    pub fn parse(s: &str) -> Result<Address, AddressError> {
        let s = s.trim();
        let b = bs58::decode(s).into_vec().map_err(|_| AddressError::NotBase58)?;
        if b.len() != 40 || b[..4] != PREFIX {
            return Err(AddressError::NotF1r3Cap);
        }
        if blake2b256(&b[..36])[..4] != b[36..] {
            return Err(AddressError::Checksum);
        }
        Ok(Address(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Address {
    type Error = AddressError;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        Address::parse(&s)
    }
}

impl From<Address> for String {
    fn from(a: Address) -> String {
        a.0
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
