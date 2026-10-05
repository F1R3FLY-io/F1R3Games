//! Prepare/send tokens.
//!
//! As in Embers, `/prepare` returns a token that `/send` requires, so the
//! service forwards only deploys it prepared, for the deployer it prepared
//! them for, within a validity window. Here the token is
//! `hex(exp) "." hex(HMAC-SHA256(secret, tag ‖ blake2b(prepared) ‖ deployer ‖ exp))`.

use f1r3games_core::hash::blake2b256;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const TAG: &[u8] = b"f1r3games/prepare/v1";

fn mac(secret: &[u8], prepared: &[u8], deployer: &[u8], exp: i64) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(secret).expect("any key length");
    m.update(TAG);
    m.update(&blake2b256(prepared));
    m.update(deployer);
    m.update(&exp.to_be_bytes());
    m.finalize().into_bytes().to_vec()
}

pub fn issue(secret: &[u8], prepared: &[u8], deployer: &[u8], exp_secs: i64) -> String {
    format!("{:x}.{}", exp_secs, hex::encode(mac(secret, prepared, deployer, exp_secs)))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TokenError {
    #[error("malformed token")]
    Malformed,
    #[error("token expired")]
    Expired,
    #[error("token does not match this deploy and deployer")]
    Mismatch,
}

pub fn verify(secret: &[u8], token: &str, prepared: &[u8], deployer: &[u8], now_secs: i64) -> Result<(), TokenError> {
    let (exp, tag) = token.split_once('.').ok_or(TokenError::Malformed)?;
    let exp = i64::from_str_radix(exp, 16).map_err(|_| TokenError::Malformed)?;
    let tag = hex::decode(tag).map_err(|_| TokenError::Malformed)?;
    if now_secs > exp {
        return Err(TokenError::Expired);
    }
    let mut m = Hmac::<Sha256>::new_from_slice(secret).expect("any key length");
    m.update(TAG);
    m.update(&blake2b256(prepared));
    m.update(deployer);
    m.update(&exp.to_be_bytes());
    m.verify_slice(&tag).map_err(|_| TokenError::Mismatch)
}
