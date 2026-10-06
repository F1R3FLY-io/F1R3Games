//! The encrypted keystore.
//!
//! ```text
//! data key (random, 32 bytes)
//!   ├─ wrapped by KEK_passphrase = PBKDF2-HMAC-SHA256(passphrase, salt, iterations)
//!   └─ wrapped by KEK_passkey    = HKDF-SHA256(prf_output, salt, "f1r3games/keystore/passkey/v1")
//! each key file encrypted by the data key (AES-256-GCM, address as AAD)
//! ```
//!
//! The serialised keystore (JSON) is what the web shell keeps in IndexedDB
//! and what the CLI keeps in a file. It contains no secret in the clear.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use f1r3games_core::{hash::random_bytes, keyfile, Address};
use hkdf::Hkdf;
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

pub const DEFAULT_PBKDF2_ITERATIONS: u32 = 600_000;
const PASSKEY_INFO: &[u8] = b"f1r3games/keystore/passkey/v1";
const DEK_AAD: &[u8] = b"f1r3games/keystore/dek/v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeystoreError {
    #[error("wrong passphrase or passkey")]
    BadSecret,
    #[error("no passkey is enrolled with credential {0}")]
    NoSuchPasskey(String),
    #[error("no passphrase is enrolled")]
    NoPassphrase,
    #[error("no key with address {0}")]
    NoSuchKey(String),
    #[error("a key with address {0} is already held")]
    Duplicate(String),
    #[error("corrupt keystore: {0}")]
    Corrupt(String),
    #[error("{0}")]
    KeyFile(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum Wrap {
    Passphrase {
        salt: String,
        iterations: u32,
        nonce: String,
        wrapped: String,
    },
    Passkey {
        credential_id: String,
        salt: String,
        nonce: String,
        wrapped: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub address: String,
    pub label: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Keystore {
    pub version: u32,
    pub wraps: Vec<Wrap>,
    pub entries: Vec<Entry>,
    pub active: Option<String>,
}

/// An unlocked keystore: the data key is held in memory until dropped.
pub struct Unlocked {
    dek: Zeroizing<[u8; 32]>,
}

fn rand<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    random_bytes(&mut b);
    b
}

fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> (String, String) {
    let nonce = rand::<12>();
    let ct = Aes256Gcm::new_from_slice(key)
        .unwrap()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .expect("AES-GCM encryption");
    (hex::encode(nonce), hex::encode(ct))
}

fn open(key: &[u8; 32], aad: &[u8], nonce: &str, ct: &str) -> Result<Zeroizing<Vec<u8>>, KeystoreError> {
    let nonce = hex::decode(nonce).map_err(|e| KeystoreError::Corrupt(e.to_string()))?;
    let ct = hex::decode(ct).map_err(|e| KeystoreError::Corrupt(e.to_string()))?;
    if nonce.len() != 12 {
        return Err(KeystoreError::Corrupt("nonce length".into()));
    }
    Aes256Gcm::new_from_slice(key)
        .unwrap()
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| KeystoreError::BadSecret)
}

fn passphrase_kek(passphrase: &str, salt: &[u8], iterations: u32) -> Zeroizing<[u8; 32]> {
    let mut k = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, iterations, &mut *k);
    k
}

fn passkey_kek(prf_output: &[u8], salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut k = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), prf_output)
        .expand(PASSKEY_INFO, &mut *k)
        .expect("32-byte HKDF output");
    k
}

fn unwrap_dek(kek: &[u8; 32], nonce: &str, wrapped: &str) -> Result<Unlocked, KeystoreError> {
    let dek = open(kek, DEK_AAD, nonce, wrapped)?;
    if dek.len() != 32 {
        return Err(KeystoreError::Corrupt("data key length".into()));
    }
    let mut k = Zeroizing::new([0u8; 32]);
    k.copy_from_slice(&dek);
    Ok(Unlocked { dek: k })
}

impl Keystore {
    /// A new, empty keystore protected by a passphrase.
    pub fn create(passphrase: &str, iterations: u32) -> (Keystore, Unlocked) {
        let dek = Zeroizing::new(rand::<32>());
        let salt = rand::<16>();
        let kek = passphrase_kek(passphrase, &salt, iterations);
        let (nonce, wrapped) = seal(&kek, DEK_AAD, &*dek);
        let ks = Keystore {
            version: 1,
            wraps: vec![Wrap::Passphrase { salt: hex::encode(salt), iterations, nonce, wrapped }],
            entries: vec![],
            active: None,
        };
        (ks, Unlocked { dek })
    }

    /// Enrol a passkey: `prf_output` is the WebAuthn PRF extension's result
    /// for this credential with the keystore's PRF salt.
    pub fn add_passkey(&mut self, unlocked: &Unlocked, credential_id: &str, prf_output: &[u8]) {
        let salt = rand::<16>();
        let kek = passkey_kek(prf_output, &salt);
        let (nonce, wrapped) = seal(&kek, DEK_AAD, &*unlocked.dek);
        self.wraps.retain(|w| !matches!(w, Wrap::Passkey { credential_id: c, .. } if c == credential_id));
        self.wraps.push(Wrap::Passkey { credential_id: credential_id.to_string(), salt: hex::encode(salt), nonce, wrapped });
    }

    pub fn remove_passkey(&mut self, credential_id: &str) {
        self.wraps.retain(|w| !matches!(w, Wrap::Passkey { credential_id: c, .. } if c == credential_id));
    }

    pub fn passkeys(&self) -> Vec<String> {
        self.wraps
            .iter()
            .filter_map(|w| match w {
                Wrap::Passkey { credential_id, .. } => Some(credential_id.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn unlock_with_passphrase(&self, passphrase: &str) -> Result<Unlocked, KeystoreError> {
        for w in &self.wraps {
            if let Wrap::Passphrase { salt, iterations, nonce, wrapped } = w {
                let salt = hex::decode(salt).map_err(|e| KeystoreError::Corrupt(e.to_string()))?;
                return unwrap_dek(&passphrase_kek(passphrase, &salt, *iterations), nonce, wrapped);
            }
        }
        Err(KeystoreError::NoPassphrase)
    }

    pub fn unlock_with_passkey(&self, credential_id: &str, prf_output: &[u8]) -> Result<Unlocked, KeystoreError> {
        for w in &self.wraps {
            if let Wrap::Passkey { credential_id: c, salt, nonce, wrapped } = w {
                if c == credential_id {
                    let salt = hex::decode(salt).map_err(|e| KeystoreError::Corrupt(e.to_string()))?;
                    return unwrap_dek(&passkey_kek(prf_output, &salt), nonce, wrapped);
                }
            }
        }
        Err(KeystoreError::NoSuchPasskey(credential_id.to_string()))
    }

    /// Change the passphrase (requires the keystore unlocked by any method).
    pub fn set_passphrase(&mut self, unlocked: &Unlocked, passphrase: &str, iterations: u32) {
        let salt = rand::<16>();
        let kek = passphrase_kek(passphrase, &salt, iterations);
        let (nonce, wrapped) = seal(&kek, DEK_AAD, &*unlocked.dek);
        self.wraps.retain(|w| !matches!(w, Wrap::Passphrase { .. }));
        self.wraps.insert(0, Wrap::Passphrase { salt: hex::encode(salt), iterations, nonce, wrapped });
    }

    pub fn add_key(&mut self, unlocked: &Unlocked, key: &SigningKey, label: &str) -> Result<Address, KeystoreError> {
        let address = Address::from_public_key(key.verifying_key());
        if self.entries.iter().any(|e| e.address == address.as_str()) {
            return Err(KeystoreError::Duplicate(address.to_string()));
        }
        let file = Zeroizing::new(keyfile::serialize(key));
        let (nonce, ciphertext) = seal(&unlocked.dek, address.as_str().as_bytes(), file.as_bytes());
        self.entries.push(Entry { address: address.to_string(), label: label.to_string(), nonce, ciphertext });
        if self.active.is_none() {
            self.active = Some(address.to_string());
        }
        Ok(address)
    }

    pub fn import_key_file(&mut self, unlocked: &Unlocked, text: &str, label: &str) -> Result<Address, KeystoreError> {
        let k = keyfile::deserialize(text).map_err(|e| KeystoreError::KeyFile(e.to_string()))?;
        self.add_key(unlocked, &k, label)
    }

    pub fn key(&self, unlocked: &Unlocked, address: &str) -> Result<SigningKey, KeystoreError> {
        let e = self
            .entries
            .iter()
            .find(|e| e.address == address)
            .ok_or_else(|| KeystoreError::NoSuchKey(address.to_string()))?;
        let plain = open(&unlocked.dek, e.address.as_bytes(), &e.nonce, &e.ciphertext)?;
        let text = std::str::from_utf8(&plain).map_err(|e| KeystoreError::Corrupt(e.to_string()))?;
        keyfile::deserialize(text).map_err(|e| KeystoreError::KeyFile(e.to_string()))
    }

    /// The key file, for export to F1R3Sky, F1R3Gaze or another wallet.
    pub fn export_key_file(&self, unlocked: &Unlocked, address: &str) -> Result<Zeroizing<String>, KeystoreError> {
        Ok(Zeroizing::new(keyfile::serialize(&self.key(unlocked, address)?)))
    }

    pub fn remove_key(&mut self, address: &str) {
        self.entries.retain(|e| e.address != address);
        if self.active.as_deref() == Some(address) {
            self.active = self.entries.first().map(|e| e.address.clone());
        }
    }

    pub fn set_active(&mut self, address: &str) -> Result<(), KeystoreError> {
        if !self.entries.iter().any(|e| e.address == address) {
            return Err(KeystoreError::NoSuchKey(address.to_string()));
        }
        self.active = Some(address.to_string());
        Ok(())
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("keystore serialises")
    }

    pub fn from_json(s: &str) -> Result<Keystore, KeystoreError> {
        serde_json::from_str(s).map_err(|e| KeystoreError::Corrupt(e.to_string()))
    }
}

impl Unlocked {
    /// The key the contact book is encrypted under is derived from the
    /// private key, not from the data key, so the same contacts open on any
    /// device that holds the key (see [`crate::contacts`]).
    pub(crate) fn _dek(&self) -> &[u8; 32] {
        &self.dek
    }
}
