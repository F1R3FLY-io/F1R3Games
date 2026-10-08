//! Requests a game's relay acts on (F1R3Ink design §8, R5).
//!
//! A game asks the Portal shell to relay a request. The shell — never the
//! game — writes the game id, the instance it is hosting and the relay URL
//! from the game's registered manifest into the message, and the wallet signs
//! it with the active key under a fixed domain:
//!
//! ```text
//! signature = ECDSA-secp256k1(BLAKE2b-256("f1r3games/relay/v1\n" ‖ message))
//! message   = JSON {"v": 1, "game", "instance", "relay", "op", "params", "address", "at"}
//! ```
//!
//! The domain keeps a relay signature from ever being taken for a deploy
//! signature (whose prehash is over `DeployDataProto` bytes), and the relay URL
//! inside the message keeps a signature for one relay from being replayed at
//! another. The relay checks the signature, that the key's address is the
//! message's `address`, and that the message is recent.

use crate::address::Address;
use crate::deploy;
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};

pub const DOMAIN: &[u8] = b"f1r3games/relay/v1\n";
/// How old (or how far in the future) a request may be.
pub const MAX_AGE_MS: i64 = 600_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelayMessage {
    pub v: u32,
    pub game: String,
    pub instance: String,
    pub relay: String,
    pub op: String,
    #[serde(default)]
    pub params: serde_json::Value,
    pub address: String,
    pub at: i64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RelayError {
    #[error("malformed relay request: {0}")]
    Malformed(String),
    #[error("the signature does not verify")]
    Signature,
    #[error("the key does not belong to the address in the request")]
    Address,
    #[error("the request is too old or from the future")]
    Stale,
}

/// The bytes signed for `message`.
pub fn signing_bytes(message: &str) -> Vec<u8> {
    let mut b = DOMAIN.to_vec();
    b.extend(message.as_bytes());
    b
}

/// Sign a relay message (DER, low-S), as the wallet does.
pub fn sign(k: &SigningKey, message: &str) -> Vec<u8> {
    deploy::sign_bytes(k, &signing_bytes(message))
}

/// Parse and check the shape of a message, without its signature.
pub fn parse(message: &str) -> Result<RelayMessage, RelayError> {
    let m: RelayMessage = serde_json::from_str(message).map_err(|e| RelayError::Malformed(e.to_string()))?;
    if m.v != 1 {
        return Err(RelayError::Malformed(format!("version {}", m.v)));
    }
    for (k, v) in [("game", &m.game), ("instance", &m.instance), ("relay", &m.relay), ("op", &m.op)] {
        if v.is_empty() || v.len() > 512 {
            return Err(RelayError::Malformed(format!("{k} must be 1 to 512 characters")));
        }
    }
    Address::parse(&m.address).map_err(|e| RelayError::Malformed(format!("address: {e}")))?;
    Ok(m)
}

/// Verify a signed request: the signature over the message, the key's
/// address, and its age against `now_ms`.
pub fn verify(message: &str, public_key: &[u8], signature: &[u8], now_ms: i64) -> Result<RelayMessage, RelayError> {
    let m = parse(message)?;
    if !deploy::verify_bytes(public_key, &signing_bytes(message), signature) {
        return Err(RelayError::Signature);
    }
    if Address::from_sec1_uncompressed(public_key).as_str() != m.address {
        return Err(RelayError::Address);
    }
    if (now_ms - m.at).abs() > MAX_AGE_MS {
        return Err(RelayError::Stale);
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyfile;

    fn msg(k: &SigningKey, at: i64) -> String {
        let a = Address::from_public_key(k.verifying_key());
        serde_json::json!({ "v": 1, "game": "f1r3ink", "instance": "i1", "relay": "https://r.example/api/relay/f1r3ink", "op": "ink",
                            "params": { "target": "x" }, "address": a.as_str(), "at": at })
        .to_string()
    }

    #[test]
    fn a_signed_request_verifies_and_nothing_else_does() {
        let k = keyfile::generate();
        let m = msg(&k, 1_000_000);
        let sig = sign(&k, &m);
        let pk = keyfile::public_key_bytes(&k);
        assert_eq!(verify(&m, &pk, &sig, 1_000_500).unwrap().op, "ink");
        assert_eq!(verify(&m, &pk, &sig, 1_000_000 + MAX_AGE_MS + 1), Err(RelayError::Stale));
        let other = keyfile::generate();
        assert_eq!(verify(&m, &keyfile::public_key_bytes(&other), &sig, 1_000_000), Err(RelayError::Signature));
        // Someone else's request, signed by them, is refused for the wrong address.
        let theirs = msg(&k, 1_000_000);
        let sig2 = sign(&other, &theirs);
        assert_eq!(verify(&theirs, &keyfile::public_key_bytes(&other), &sig2, 1_000_000), Err(RelayError::Address));
        // A deploy-style signature over the bare message does not verify.
        let bare = deploy::sign_bytes(&k, m.as_bytes());
        assert_eq!(verify(&m, &pk, &bare, 1_000_000), Err(RelayError::Signature));
        assert!(matches!(parse("{}"), Err(RelayError::Malformed(_))));
    }
}
