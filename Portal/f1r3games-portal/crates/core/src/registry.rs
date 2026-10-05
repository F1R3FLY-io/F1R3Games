//! `rho:registry:insertSigned:secp256k1` and registry URIs.
//!
//! The registry (`casper/src/main/resources/Registry.rho`) inserts a value
//! under the URI derived from a public key when the caller presents a
//! signature, by that key, over the tuple
//! `(deploy timestamp, deployer public key, nonce)`, serialised as a Rholang
//! `Par` and hashed with BLAKE2b-256 (`registry_sig_gen.rs`). The value
//! inserted is `(nonce, data)`; a later insert must carry a larger nonce, which
//! is how an environment is versioned.

use crate::deploy::varint;
use crate::hash::blake2b256;
use k256::ecdsa::SigningKey;

fn tag(field: u32, wire: u32, out: &mut Vec<u8>) {
    varint(((field << 3) | wire) as u64, out);
}

fn len_delimited(field: u32, body: &[u8], out: &mut Vec<u8>) {
    tag(field, 2, out);
    varint(body.len() as u64, out);
    out.extend_from_slice(body);
}

/// `Par { exprs: [Expr { g_int }] }` — `GInt` is `sint64` (zig-zag).
fn gint_par(v: i64) -> Vec<u8> {
    let mut expr = Vec::new();
    tag(2, 0, &mut expr);
    varint(((v << 1) ^ (v >> 63)) as u64, &mut expr);
    let mut par = Vec::new();
    len_delimited(5, &expr, &mut par);
    par
}

/// `Par { exprs: [Expr { g_byte_array }] }`.
fn bytes_par(b: &[u8]) -> Vec<u8> {
    let mut expr = Vec::new();
    len_delimited(25, b, &mut expr);
    let mut par = Vec::new();
    len_delimited(5, &expr, &mut par);
    par
}

/// The protobuf bytes of `(timestamp, deployerPubKey, nonce)` as a `Par`.
pub fn insert_signed_preimage(timestamp: i64, deployer_pk: &[u8], nonce: i64) -> Vec<u8> {
    let mut tuple = Vec::new();
    len_delimited(1, &gint_par(timestamp), &mut tuple);
    len_delimited(1, &bytes_par(deployer_pk), &mut tuple);
    len_delimited(1, &gint_par(nonce), &mut tuple);
    let mut expr = Vec::new();
    len_delimited(21, &tuple, &mut expr);
    let mut par = Vec::new();
    len_delimited(5, &expr, &mut par);
    par
}

/// The signature `insertSigned` expects, made with the URI key.
pub fn insert_signed_signature(uri_key: &SigningKey, timestamp: i64, deployer_pk: &[u8], nonce: i64) -> Vec<u8> {
    crate::deploy::sign_bytes(uri_key, &insert_signed_preimage(timestamp, deployer_pk, nonce))
}

/// CRC-14 as the node's `Registry::build_uri` computes it.
fn crc14(b: &[u8]) -> u16 {
    b.iter().fold(0u16, |rem, &byte| {
        let mut rem = rem ^ ((byte as u16) << 6);
        for _ in 0..8 {
            let shift = rem << 1;
            rem = if shift & 0x4000 != 0 { shift ^ 0x4805 } else { shift };
        }
        rem
    })
}

/// The URI the registry assigns to `public_key` (65-byte uncompressed).
pub fn uri_for_public_key(public_key: &[u8]) -> String {
    let hash = blake2b256(public_key);
    let mut full = [0u8; 34];
    full[..32].copy_from_slice(&hash);
    let crc = crc14(&hash);
    full[32] = (crc & 0xff) as u8;
    full[33] = ((crc & 0xff00) >> 6) as u8;
    format!("rho:id:{}", zbase32::encode(&full, 270))
}
