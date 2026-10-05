//! Deploys exactly as F1R3Node-Rust verifies them.
//!
//! `crypto::signatures::Signed::from_signed_data` checks a DER ECDSA
//! secp256k1 signature over BLAKE2b-256 of the protobuf encoding of
//! `DeployDataProto` built by `DeployData::_to_proto`: term (2), timestamp (3),
//! phloPrice (7), phloLimit (8), validAfterBlockNumber (10), shardId (11) and
//! expirationTimestamp (13), proto3 defaults omitted. The signer fields are
//! not part of the preimage. The deploy id is the signature.
//!
//! The encoder below writes that encoding by hand (no protobuf runtime, so it
//! builds for wasm unchanged); the decoder is strict, so a wallet signing
//! prepared bytes knows exactly what it signs.

use crate::hash::blake2b256;
use k256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use k256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployData {
    pub term: String,
    pub timestamp: i64,
    pub phlo_price: i64,
    pub phlo_limit: i64,
    pub valid_after_block_number: i64,
    pub shard_id: String,
    /// Milliseconds; `None` (or `0`) means no expiry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiration_timestamp: Option<i64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DecodeError {
    #[error("truncated input")]
    Truncated,
    #[error("varint too long")]
    VarintTooLong,
    #[error("field {0} repeated or out of range")]
    Repeated(u32),
    #[error("unexpected field {0} (wire type {1})")]
    UnexpectedField(u32, u64),
    #[error("a string field is not UTF-8")]
    NotUtf8,
    #[error("not in canonical form")]
    NotCanonical,
}

pub(crate) fn varint(mut v: u64, out: &mut Vec<u8>) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn field_varint(n: u32, v: i64, out: &mut Vec<u8>) {
    if v != 0 {
        varint(((n << 3) | 0) as u64, out);
        varint(v as u64, out);
    }
}

fn field_bytes(n: u32, b: &[u8], out: &mut Vec<u8>) {
    if !b.is_empty() {
        varint(((n << 3) | 2) as u64, out);
        varint(b.len() as u64, out);
        out.extend_from_slice(b);
    }
}

fn read_varint(b: &[u8], i: &mut usize) -> Result<u64, DecodeError> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let x = *b.get(*i).ok_or(DecodeError::Truncated)?;
        *i += 1;
        v |= ((x & 0x7f) as u64) << shift;
        if x < 0x80 {
            return Ok(v);
        }
    }
    Err(DecodeError::VarintTooLong)
}

impl DeployData {
    /// The signature preimage: proto3 encoding of `DeployDataProto` without
    /// signer fields, in field-number order, defaults omitted.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(self.term.len() + 64);
        field_bytes(2, self.term.as_bytes(), &mut o);
        field_varint(3, self.timestamp, &mut o);
        field_varint(7, self.phlo_price, &mut o);
        field_varint(8, self.phlo_limit, &mut o);
        field_varint(10, self.valid_after_block_number, &mut o);
        field_bytes(11, self.shard_id.as_bytes(), &mut o);
        field_varint(13, self.expiration_timestamp.unwrap_or(0), &mut o);
        o
    }

    /// Decode prepared bytes strictly: only the fields [`Self::signing_bytes`]
    /// writes, each at most once, in canonical form.
    pub fn decode(b: &[u8]) -> Result<DeployData, DecodeError> {
        let mut d = DeployData {
            term: String::new(),
            timestamp: 0,
            phlo_price: 0,
            phlo_limit: 0,
            valid_after_block_number: 0,
            shard_id: String::new(),
            expiration_timestamp: None,
        };
        let mut seen = 0u32;
        let mut i = 0;
        while i < b.len() {
            let tag = read_varint(b, &mut i)?;
            let (n, wire) = ((tag >> 3) as u32, tag & 7);
            if n >= 32 || seen & (1 << n) != 0 {
                return Err(DecodeError::Repeated(n));
            }
            seen |= 1 << n;
            match (n, wire) {
                (2 | 11, 2) => {
                    let len = read_varint(b, &mut i)? as usize;
                    let end = i
                        .checked_add(len)
                        .filter(|e| *e <= b.len())
                        .ok_or(DecodeError::Truncated)?;
                    let t = std::str::from_utf8(&b[i..end])
                        .map_err(|_| DecodeError::NotUtf8)?
                        .to_string();
                    i = end;
                    if n == 2 {
                        d.term = t
                    } else {
                        d.shard_id = t
                    }
                }
                (3 | 7 | 8 | 10 | 13, 0) => {
                    let v = read_varint(b, &mut i)? as i64;
                    match n {
                        3 => d.timestamp = v,
                        7 => d.phlo_price = v,
                        8 => d.phlo_limit = v,
                        10 => d.valid_after_block_number = v,
                        _ => d.expiration_timestamp = Some(v),
                    }
                }
                _ => return Err(DecodeError::UnexpectedField(n, wire)),
            }
        }
        if d.signing_bytes() != b {
            return Err(DecodeError::NotCanonical);
        }
        Ok(d)
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        blake2b256(&self.signing_bytes())
    }

    /// The most this deploy can cost its deployer.
    pub fn max_fee(&self) -> i128 {
        self.phlo_price as i128 * self.phlo_limit as i128
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedDeploy {
    pub data: DeployData,
    /// 65-byte uncompressed public key.
    pub deployer: Vec<u8>,
    /// DER signature.
    pub sig: Vec<u8>,
}

/// Sign a 32-byte prehash as the node signs and verifies: secp256k1,
/// RFC 6979, low-S, DER.
pub fn sign_prehash(k: &SigningKey, prehash: &[u8; 32]) -> Vec<u8> {
    let sig: Signature = k.sign_prehash(prehash).expect("32-byte prehash");
    let sig = sig.normalize_s().unwrap_or(sig);
    sig.to_der().as_bytes().to_vec()
}

/// Sign arbitrary bytes by their BLAKE2b-256 prehash. For a `DeployDataProto`
/// encoding this is the deploy signature.
pub fn sign_bytes(k: &SigningKey, bytes: &[u8]) -> Vec<u8> {
    sign_prehash(k, &blake2b256(bytes))
}

pub fn verify_bytes(pk: &[u8], bytes: &[u8], sig: &[u8]) -> bool {
    let Ok(vk) = VerifyingKey::from_sec1_bytes(pk) else { return false };
    let Ok(sig) = Signature::from_der(sig) else { return false };
    vk.verify_prehash(&blake2b256(bytes), &sig).is_ok()
}

pub fn sign(k: &SigningKey, data: DeployData) -> SignedDeploy {
    SignedDeploy {
        deployer: crate::keyfile::public_key_bytes(k),
        sig: sign_prehash(k, &data.signing_hash()),
        data,
    }
}

impl SignedDeploy {
    /// The node's own check.
    pub fn verify(&self) -> bool {
        verify_bytes(&self.deployer, &self.data.signing_bytes(), &self.sig)
    }

    /// The body of `POST /api/deploy` (node `DeployRequest`; the node's
    /// `DeployData` serialises `expiration_timestamp` under that name).
    pub fn to_json(&self) -> serde_json::Value {
        let mut data = serde_json::json!({
            "term": self.data.term,
            "timestamp": self.data.timestamp,
            "phloPrice": self.data.phlo_price,
            "phloLimit": self.data.phlo_limit,
            "validAfterBlockNumber": self.data.valid_after_block_number,
            "shardId": self.data.shard_id,
        });
        if let Some(e) = self.data.expiration_timestamp.filter(|e| *e > 0) {
            data["expiration_timestamp"] = e.into();
        }
        serde_json::json!({
            "data": data,
            "deployer": hex::encode(&self.deployer),
            "signature": hex::encode(&self.sig),
            "sigAlgorithm": "secp256k1",
        })
    }

    /// The deploy id the node returns: the signature, hex.
    pub fn id(&self) -> String {
        hex::encode(&self.sig)
    }
}
