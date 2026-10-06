//! The contact book.
//!
//! Contacts are other people's personal data. They are kept on the person's
//! device, encrypted, and never appear in a deploy except as the ciphertext
//! of an optional backup (`contacts.save`). The person chooses
//! [`StorageMode::ClientOnly`] or [`StorageMode::OnChainBackup`].
//!
//! The encryption key is derived from the private key
//! (HKDF-SHA-256, info `f1r3games/contacts/v1`), so a backup opens on any
//! device that holds the key and on no other. Ciphertexts are padded to
//! 4 KiB buckets so their length says little about the number of contacts.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use f1r3games_core::hash::random_bytes;
use hkdf::Hkdf;
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

const INFO: &[u8] = b"f1r3games/contacts/v1";
const BUCKET: usize = 4096;
const FORMAT: u8 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageMode {
    #[default]
    ClientOnly,
    OnChainBackup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    /// email, discord, slack, mattermost, telegram, f1r3cap, phone, other
    pub kind: String,
    pub handle: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    pub name: String,
    pub channels: Vec<Channel>,
    #[serde(default)]
    pub note: String,
    pub added_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactBook {
    pub mode: StorageMode,
    pub contacts: Vec<Contact>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ContactsError {
    #[error("not a contact backup")]
    Format,
    #[error("this backup was not made with this key")]
    WrongKey,
    #[error("malformed contact data: {0}")]
    Malformed(String),
}

fn key_for(sk: &SigningKey) -> Zeroizing<[u8; 32]> {
    let mut k = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(b"f1r3games"), &sk.to_bytes())
        .expand(INFO, &mut *k)
        .expect("32-byte HKDF output");
    k
}

impl ContactBook {
    pub fn add(&mut self, name: &str, channels: Vec<Channel>, now_ms: i64) -> &Contact {
        let mut id = [0u8; 8];
        random_bytes(&mut id);
        self.contacts.push(Contact {
            id: hex::encode(id),
            name: name.to_string(),
            channels,
            note: String::new(),
            added_at: now_ms,
        });
        self.contacts.last().unwrap()
    }

    pub fn remove(&mut self, id: &str) {
        self.contacts.retain(|c| c.id != id);
    }

    /// Import `name,kind,handle` lines (a CSV export reduced to what the
    /// dialogue needs). Lines that do not parse are returned.
    pub fn import_csv(&mut self, text: &str, now_ms: i64) -> Vec<String> {
        let mut rejected = vec![];
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let f: Vec<&str> = line.split(',').map(str::trim).collect();
            match f.as_slice() {
                [name, kind, handle] if !name.is_empty() && !handle.is_empty() => {
                    self.add(name, vec![Channel { kind: kind.to_lowercase(), handle: handle.to_string() }], now_ms);
                }
                _ => rejected.push(line.to_string()),
            }
        }
        rejected
    }

    /// Import a vCard file: FN, EMAIL and TEL lines of each card.
    pub fn import_vcard(&mut self, text: &str, now_ms: i64) -> usize {
        let mut n = 0;
        let mut name = String::new();
        let mut channels = vec![];
        for raw in text.lines() {
            let line = raw.trim();
            let upper = line.to_ascii_uppercase();
            if upper == "BEGIN:VCARD" {
                name.clear();
                channels.clear();
            } else if upper == "END:VCARD" {
                if !name.is_empty() && !channels.is_empty() {
                    self.add(&name, std::mem::take(&mut channels), now_ms);
                    n += 1;
                }
            } else if let Some((key, value)) = line.split_once(':') {
                let k = key.split(';').next().unwrap_or("").to_ascii_uppercase();
                match k.as_str() {
                    "FN" => name = value.trim().to_string(),
                    "EMAIL" => channels.push(Channel { kind: "email".into(), handle: value.trim().to_string() }),
                    "TEL" => channels.push(Channel { kind: "phone".into(), handle: value.trim().to_string() }),
                    _ => {}
                }
            }
        }
        n
    }

    /// The backup ciphertext: `format ‖ nonce(12) ‖ AES-256-GCM(padded JSON)`.
    pub fn encrypt(&self, sk: &SigningKey) -> Vec<u8> {
        let key = key_for(sk);
        let json = serde_json::to_vec(self).expect("contacts serialise");
        let mut plain = Zeroizing::new(Vec::with_capacity(json.len() + BUCKET));
        plain.extend_from_slice(&(json.len() as u32).to_be_bytes());
        plain.extend_from_slice(&json);
        let padded = (plain.len() + BUCKET - 1) / BUCKET * BUCKET;
        plain.resize(padded, 0);
        let mut nonce = [0u8; 12];
        random_bytes(&mut nonce);
        let ct = Aes256Gcm::new_from_slice(&*key)
            .unwrap()
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &[FORMAT] })
            .expect("AES-GCM");
        let mut out = vec![FORMAT];
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    pub fn decrypt(sk: &SigningKey, bytes: &[u8]) -> Result<ContactBook, ContactsError> {
        if bytes.len() < 13 || bytes[0] != FORMAT {
            return Err(ContactsError::Format);
        }
        let key = key_for(sk);
        let plain = Zeroizing::new(
            Aes256Gcm::new_from_slice(&*key)
                .unwrap()
                .decrypt(Nonce::from_slice(&bytes[1..13]), Payload { msg: &bytes[13..], aad: &[FORMAT] })
                .map_err(|_| ContactsError::WrongKey)?,
        );
        if plain.len() < 4 {
            return Err(ContactsError::Format);
        }
        let n = u32::from_be_bytes(plain[..4].try_into().unwrap()) as usize;
        let json = plain.get(4..4 + n).ok_or(ContactsError::Format)?;
        serde_json::from_slice(json).map_err(|e| ContactsError::Malformed(e.to_string()))
    }
}
