//! # f1r3games-wallet
//!
//! A wallet specific to F1R3Games. It is informed by the Embers and F1R3Gaze
//! wallets but shares no code with them: a healthy ecosystem has many wallet
//! implementations. What it shares is the key file format, so a person's key
//! moves freely between them.
//!
//! * [`keystore`] — keys encrypted at rest under one data key, which is
//!   wrapped separately by a passphrase (PBKDF2-HMAC-SHA-256) and by a passkey
//!   (the WebAuthn PRF extension's output through HKDF-SHA-256). Either
//!   unlocks it.
//! * [`policy`] — the signing rules of design §7.2: strict decoding, shard
//!   and fee checks, recognition of the term as a registered template filled
//!   with the named values, no deployer authority for game templates, and
//!   per-instance allowances within which play is signed without prompting.
//! * [`contacts`] — the contact book, encrypted under a key derived from the
//!   person's private key, kept on the client only or backed up on chain as
//!   ciphertext, at the person's choice.
//! * [`envelope`] — opening messages sealed to the active key (F1R3Pix
//!   design §6.2), with the game and instance bound in.
//! * [`wallet`] — the whole: keys, consent, signing.

pub mod contacts;
pub mod envelope;
pub mod keystore;
pub mod policy;
pub mod wallet;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use keystore::{Keystore, Unlocked};
pub use policy::{Decision, Origin, Policy, SignRequest};
pub use wallet::Wallet;
