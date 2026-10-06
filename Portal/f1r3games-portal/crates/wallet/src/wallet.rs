//! The wallet: keystore + policy + consent.
//!
//! A caller (the web shell, the CLI, a test) asks [`Wallet::review`] what a
//! request would sign. For [`Decision::Prompt`] it shows the person the
//! summary and calls [`Wallet::sign`] only on approval; for
//! [`Decision::Within`] it may call [`Wallet::sign`] directly. `sign` repeats
//! every check, so a caller cannot skip them.

use crate::keystore::{Keystore, KeystoreError, Unlocked};
use crate::policy::{Decision, Policy, PolicyError, SignRequest};
use f1r3games_core::deploy::{sign_prehash, SignedDeploy};
use f1r3games_core::invite::InviteKey;
use f1r3games_core::{keyfile, Address};
use k256::ecdsa::SigningKey;

#[derive(Debug, thiserror::Error)]
pub enum WalletError {
    #[error("the wallet is locked")]
    Locked,
    #[error("no active key")]
    NoActiveKey,
    #[error(transparent)]
    Keystore(#[from] KeystoreError),
    #[error(transparent)]
    Policy(#[from] PolicyError),
    #[error("the person did not approve this signature")]
    NotApproved,
    #[error(transparent)]
    Envelope(#[from] crate::envelope::EnvelopeError),
}

pub struct Wallet {
    pub keystore: Keystore,
    pub policy: Policy,
    unlocked: Option<Unlocked>,
}

/// How the person answered a prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Consent {
    Approved,
    Refused,
}

impl Wallet {
    pub fn new(keystore: Keystore, policy: Policy) -> Wallet {
        Wallet { keystore, policy, unlocked: None }
    }

    pub fn unlock_with_passphrase(&mut self, passphrase: &str) -> Result<(), WalletError> {
        self.unlocked = Some(self.keystore.unlock_with_passphrase(passphrase)?);
        Ok(())
    }

    pub fn unlock_with_passkey(&mut self, credential_id: &str, prf_output: &[u8]) -> Result<(), WalletError> {
        self.unlocked = Some(self.keystore.unlock_with_passkey(credential_id, prf_output)?);
        Ok(())
    }

    pub fn adopt_unlocked(&mut self, u: Unlocked) {
        self.unlocked = Some(u);
    }

    pub fn lock(&mut self) {
        self.unlocked = None;
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    fn unlocked(&self) -> Result<&Unlocked, WalletError> {
        self.unlocked.as_ref().ok_or(WalletError::Locked)
    }

    pub fn create_key(&mut self, label: &str) -> Result<(Address, String), WalletError> {
        let k = keyfile::generate();
        let u = self.unlocked.as_ref().ok_or(WalletError::Locked)?;
        let a = self.keystore.add_key(u, &k, label)?;
        // The key file is returned so the shell can offer it for download at
        // once, as F1R3Sky does on creation.
        Ok((a, keyfile::serialize(&k)))
    }

    pub fn import_key_file(&mut self, text: &str, label: &str) -> Result<Address, WalletError> {
        let u = self.unlocked.as_ref().ok_or(WalletError::Locked)?;
        Ok(self.keystore.import_key_file(u, text, label)?)
    }

    pub fn active_address(&self) -> Result<Address, WalletError> {
        let a = self.keystore.active.clone().ok_or(WalletError::NoActiveKey)?;
        Ok(Address::parse(&a).map_err(|_| WalletError::NoActiveKey)?)
    }

    pub fn active_key(&self) -> Result<SigningKey, WalletError> {
        let a = self.keystore.active.clone().ok_or(WalletError::NoActiveKey)?;
        Ok(self.keystore.key(self.unlocked()?, &a)?)
    }

    /// Open a message envelope addressed to the active key. `game` and
    /// `instance` come from the host, never from the game (F1R3Pix design R3).
    pub fn open_envelope(&self, game: &str, instance: &str, envelope: &[u8]) -> Result<(String, Vec<u8>), WalletError> {
        let me = self.active_address()?.to_string();
        Ok(crate::envelope::open(game, instance, &me, &self.active_key()?, envelope)?)
    }

    pub fn active_public_key_hex(&self) -> Result<String, WalletError> {
        Ok(hex::encode(keyfile::public_key_bytes(&self.active_key()?)))
    }

    pub fn review(&self, req: &SignRequest, now_ms: i64) -> Result<Decision, WalletError> {
        Ok(self.policy.check(req, now_ms)?.1)
    }

    /// Sign after review. `consent` is the person's answer to the prompt; it
    /// is ignored only for requests within an allowance.
    pub fn sign(&mut self, req: &SignRequest, consent: Consent, now_ms: i64) -> Result<SignedDeploy, WalletError> {
        let (data, decision) = self.policy.check(req, now_ms)?;
        match decision {
            Decision::Prompt { .. } if consent != Consent::Approved => return Err(WalletError::NotApproved),
            Decision::Within { max_fee, .. } => self.policy.record(req, max_fee),
            Decision::Prompt { .. } => {}
        }
        let k = self.active_key()?;
        Ok(SignedDeploy {
            deployer: keyfile::public_key_bytes(&k),
            sig: sign_prehash(&k, &data.signing_hash()),
            data,
        })
    }

    /// Sign the redemption of an invitation for the active address.
    pub fn redemption_signature(&self, invite: &InviteKey) -> Result<Vec<u8>, WalletError> {
        Ok(invite.sign_redemption(&self.active_address()?))
    }
}
