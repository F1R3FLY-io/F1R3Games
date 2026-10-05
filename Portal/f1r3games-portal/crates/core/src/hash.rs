//! The hashes the node uses: BLAKE2b-256 (deploy signatures, registry,
//! address checksums) and Keccak-256 (address derivation).

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use sha3::Keccak256;

pub fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut h = Blake2b::<U32>::new();
    h.update(data);
    h.finalize().into()
}

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

/// Fill `buf` from the operating system's (or, with the `wasm` feature, the
/// browser's) CSPRNG.
pub fn random_bytes(buf: &mut [u8]) {
    getrandom::getrandom(buf).expect("system random number generator unavailable");
}
