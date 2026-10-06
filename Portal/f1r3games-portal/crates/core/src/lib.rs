//! # f1r3games-core
//!
//! What every part of the F1R3Games Portal shares, written to conform to
//! F1R3Node-Rust `master` first:
//!
//! * [`address`] — F1R3Cap addresses, derived as the node's `VaultAddress`
//!   derives them from a secp256k1 public key.
//! * [`keyfile`] — the portable secp256k1 key file (the format F1R3Sky and
//!   F1R3Gaze also read), so a key is not captive to one wallet.
//! * [`deploy`] — `DeployData`, its canonical protobuf encoding, strict
//!   decoding, signing and verification as the node checks `POST /api/deploy`.
//! * [`registry`] — `rho:registry:insertSigned:secp256k1` signatures and
//!   registry URIs, byte-compatible with the node.
//! * [`rho`] — typed Rholang values, their literal rendering, and decoding of
//!   the node's `RhoExpr` JSON.
//! * [`template`] / [`catalogue`] — the portal's Rholang templates, their
//!   hashes, rendering and recognition.
//! * [`invite`] — invitation keys, links and redemption signatures.
//! * [`ids`] — identifiers known before the deploy that creates the object.

pub mod address;
pub mod catalogue;
pub mod deploy;
pub mod hash;
pub mod ids;
pub mod invite;
pub mod keyfile;
pub mod registry;
pub mod rho;
pub mod template;

pub use address::Address;
pub use deploy::{DeployData, SignedDeploy};
pub use rho::Value;
pub use template::{Template, TemplateError, TemplateKind};

/// Version of the `games` environment's method surface and of the portal ↔
/// game host protocol.
/// 2: `pay`, `open`, `balance`, `payments`, `profiles` and manifest `capabilities` (F1R3Pix design §8).
pub const PROTOCOL_VERSION: u32 = 2;
