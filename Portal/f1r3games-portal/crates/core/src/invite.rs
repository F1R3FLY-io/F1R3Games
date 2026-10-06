//! Invitations.
//!
//! An invitation is a fresh secp256k1 key pair. Its public key is recorded on
//! the shard by `invites.issue`; its private key travels to the invitee in
//! the link's fragment, which browsers do not send to servers:
//!
//! ```text
//! https://games.example/i/<instance id>#i=<invite key, base64url>[&k=<funded key>]
//! ```
//!
//! To redeem, the invitee's wallet signs, with the invite key,
//! `"f1r3games:redeem:v1:" ++ hex(invite public key) ++ ":" ++ guest address`
//! (BLAKE2b-256 prehash), and deploys `invites.redeem` with that signature.
//! The contract recomputes the message with `toUtf8Bytes`, hashes it with
//! `rho:crypto:blake2b256Hash` and checks it with
//! `rho:crypto:secp256k1Verify`. A copy of a pending redeem deploy is useless
//! to any other address. The optional `k` parameter carries a key the inviter
//! generated and funded for a newcomer (design §11.5, route 2).

use crate::address::Address;
use crate::deploy::{sign_bytes, verify_bytes};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use k256::ecdsa::SigningKey;

pub struct InviteKey(pub SigningKey);

impl std::fmt::Debug for InviteKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InviteKey({})", hex::encode(self.public_key()))
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InviteError {
    #[error("not an invitation link")]
    NotALink,
    #[error("the invitation key in the link is malformed")]
    BadKey,
}

pub struct ParsedLink {
    pub instance_id: String,
    pub invite_key: InviteKey,
    pub funded_key: Option<SigningKey>,
}

pub fn redemption_message(invite_pk: &[u8], guest: &Address) -> String {
    format!("f1r3games:redeem:v1:{}:{}", hex::encode(invite_pk), guest)
}

impl InviteKey {
    pub fn generate() -> InviteKey {
        InviteKey(crate::keyfile::generate())
    }

    pub fn public_key(&self) -> Vec<u8> {
        crate::keyfile::public_key_bytes(&self.0)
    }

    pub fn sign_redemption(&self, guest: &Address) -> Vec<u8> {
        sign_bytes(&self.0, redemption_message(&self.public_key(), guest).as_bytes())
    }

    pub fn link(&self, base: &str, instance_id: &str, funded_key: Option<&SigningKey>) -> String {
        let mut s = format!(
            "{}/i/{}#i={}",
            base.trim_end_matches('/'),
            instance_id,
            B64.encode(self.0.to_bytes())
        );
        if let Some(k) = funded_key {
            s.push_str("&k=");
            s.push_str(&B64.encode(k.to_bytes()));
        }
        s
    }
}

pub fn verify_redemption(invite_pk: &[u8], guest: &Address, sig: &[u8]) -> bool {
    verify_bytes(invite_pk, redemption_message(invite_pk, guest).as_bytes(), sig)
}

fn key_from_b64(s: &str) -> Result<SigningKey, InviteError> {
    let b = B64.decode(s).map_err(|_| InviteError::BadKey)?;
    SigningKey::from_slice(&b).map_err(|_| InviteError::BadKey)
}

pub fn parse_link(link: &str) -> Result<ParsedLink, InviteError> {
    let (path, frag) = link.split_once('#').ok_or(InviteError::NotALink)?;
    let instance_id = path.rsplit_once("/i/").map(|(_, id)| id).ok_or(InviteError::NotALink)?;
    if instance_id.is_empty() || !instance_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(InviteError::NotALink);
    }
    let mut invite = None;
    let mut funded = None;
    for part in frag.split('&') {
        match part.split_once('=') {
            Some(("i", v)) => invite = Some(key_from_b64(v)?),
            Some(("k", v)) => funded = Some(key_from_b64(v)?),
            _ => {}
        }
    }
    Ok(ParsedLink {
        instance_id: instance_id.to_string(),
        invite_key: InviteKey(invite.ok_or(InviteError::NotALink)?),
        funded_key: funded,
    })
}
