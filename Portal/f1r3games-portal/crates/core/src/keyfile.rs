//! The portable key file:
//! `{"keyType":"secp256k1","value":"<64 upper-case hex>","valueFormat":"hex"}`.
//!
//! F1R3Sky saves this file on wallet creation and loads it on "add wallet";
//! F1R3Gaze imports and exports it. The F1R3Games wallet is its own
//! implementation and shares only this format, so keys move between wallets.

use k256::ecdsa::SigningKey;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyFileError {
    #[error("not a key file: {0}")]
    Malformed(String),
    #[error("unsupported key type (expected secp256k1)")]
    KeyType,
    #[error("unsupported value format (expected hex)")]
    ValueFormat,
    #[error("the key must be 32 bytes of hex")]
    Length,
    #[error("not a valid secp256k1 private key")]
    Invalid,
}

pub fn serialize(k: &SigningKey) -> String {
    let hex = hex::encode_upper(k.to_bytes());
    format!(r#"{{"keyType":"secp256k1","value":"{hex}","valueFormat":"hex"}}"#)
}

/// Read a key file. A bare 64-digit hex key (optionally `0x`-prefixed) is
/// accepted too.
pub fn deserialize(text: &str) -> Result<SigningKey, KeyFileError> {
    let t = text.trim();
    let hex_str = if t.starts_with('{') {
        let v: serde_json::Value =
            serde_json::from_str(t).map_err(|e| KeyFileError::Malformed(e.to_string()))?;
        if v.get("keyType").and_then(|x| x.as_str()) != Some("secp256k1") {
            return Err(KeyFileError::KeyType);
        }
        if v.get("valueFormat").and_then(|x| x.as_str()) != Some("hex") {
            return Err(KeyFileError::ValueFormat);
        }
        v.get("value")
            .and_then(|x| x.as_str())
            .ok_or_else(|| KeyFileError::Malformed("no value".into()))?
            .to_string()
    } else {
        t.trim_start_matches("0x").to_string()
    };
    let b = hex::decode(hex_str.to_ascii_lowercase()).map_err(|_| KeyFileError::Length)?;
    if b.len() != 32 {
        return Err(KeyFileError::Length);
    }
    SigningKey::from_slice(&b).map_err(|_| KeyFileError::Invalid)
}

/// A fresh key from the system CSPRNG.
pub fn generate() -> SigningKey {
    loop {
        let mut b = [0u8; 32];
        crate::hash::random_bytes(&mut b);
        if let Ok(k) = SigningKey::from_slice(&b) {
            return k;
        }
    }
}

/// The 65-byte uncompressed public key, as the node's `deployer` field.
pub fn public_key_bytes(k: &SigningKey) -> Vec<u8> {
    k.verifying_key().to_encoded_point(false).as_bytes().to_vec()
}
