//! Sealed message envelopes (F1R3Pix design §6.2).
//!
//! Games seal with public keys only; the wallet opens with the active key.
//! The game id and instance are bound into the derivation, and the host —
//! not the game — supplies them (design R3), so a game frame cannot use
//! `open` to read envelopes made for another game or another instance.
//!
//! ```text
//! label  = utf8(game + "/msg/v1") ‖ utf8(instance)
//! C      = AES-256-GCM_K(n0, plaintext, aad = label ‖ utf8(sender))
//! Z_j    = x(e · P_j);  W_j = HKDF-SHA-256(ikm Z_j, salt E, info label, 32)
//! wrap_j = AES-256-GCM_{W_j}(n_j, K)
//! CBOR   {c: C, e: E (33 bytes), n: n0, s: sender, v: 1, w: [[address, n_j, wrap_j], ...]}
//! ```
//!
//! The identity key also serves ECDH here, as in ECIES; `label` keeps the
//! derived keys apart from every other use of it.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use k256::ecdh::diffie_hellman;
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{PublicKey, SecretKey};
use sha2::Sha256;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("the envelope is damaged or not an envelope")]
    Corrupt,
    #[error("unknown envelope version")]
    Version,
    #[error("the envelope is not addressed to this key")]
    NotAddressed,
    #[error("the envelope does not open under this game and instance")]
    WrongScope,
    #[error("bad public key for {0}")]
    BadKey(String),
}

pub fn label(game: &str, instance: &str) -> Vec<u8> {
    let mut l = format!("{game}/msg/v1").into_bytes();
    l.extend(instance.as_bytes());
    l
}

fn wrap_key(shared_x: &[u8], e: &[u8], label: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(e), shared_x).expand(label, &mut out).expect("32 bytes is a valid HKDF length");
    out
}

// ---------------------------------------------------------------- minimal canonical CBOR

#[derive(Clone, Debug, PartialEq, Eq)]
enum Cbor {
    Uint(u64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(String, Cbor)>),
}

fn head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=255 => out.extend([m | 24, n as u8]),
        256..=65535 => out.extend([m | 25, (n >> 8) as u8, n as u8]),
        _ => {
            out.push(m | 26);
            out.extend((n as u32).to_be_bytes());
        }
    }
}

fn encode(v: &Cbor, out: &mut Vec<u8>) {
    match v {
        Cbor::Uint(n) => head(out, 0, *n),
        Cbor::Bytes(b) => {
            head(out, 2, b.len() as u64);
            out.extend(b);
        }
        Cbor::Text(t) => {
            head(out, 3, t.len() as u64);
            out.extend(t.as_bytes());
        }
        Cbor::Array(xs) => {
            head(out, 4, xs.len() as u64);
            xs.iter().for_each(|x| encode(x, out));
        }
        Cbor::Map(kv) => {
            let mut kv = kv.clone();
            kv.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then(a.0.as_bytes().cmp(b.0.as_bytes())));
            head(out, 5, kv.len() as u64);
            for (k, x) in &kv {
                encode(&Cbor::Text(k.clone()), out);
                encode(x, out);
            }
        }
    }
}

struct Dec<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl Dec<'_> {
    fn u8(&mut self) -> Result<u8, EnvelopeError> {
        let x = *self.b.get(self.i).ok_or(EnvelopeError::Corrupt)?;
        self.i += 1;
        Ok(x)
    }
    fn arg(&mut self, ai: u8) -> Result<u64, EnvelopeError> {
        Ok(match ai {
            0..=23 => ai as u64,
            24 => self.u8()? as u64,
            25 => u16::from_be_bytes([self.u8()?, self.u8()?]) as u64,
            26 => u32::from_be_bytes([self.u8()?, self.u8()?, self.u8()?, self.u8()?]) as u64,
            _ => return Err(EnvelopeError::Corrupt),
        })
    }
    fn take(&mut self, n: u64) -> Result<Vec<u8>, EnvelopeError> {
        let n = usize::try_from(n).map_err(|_| EnvelopeError::Corrupt)?;
        let s = self.b.get(self.i..self.i.checked_add(n).ok_or(EnvelopeError::Corrupt)?).ok_or(EnvelopeError::Corrupt)?;
        self.i += n;
        Ok(s.to_vec())
    }
    fn item(&mut self) -> Result<Cbor, EnvelopeError> {
        self.depth += 1;
        if self.depth > 8 {
            return Err(EnvelopeError::Corrupt);
        }
        let b = self.u8()?;
        let n = self.arg(b & 31)?;
        let v = match b >> 5 {
            0 => Cbor::Uint(n),
            2 => Cbor::Bytes(self.take(n)?),
            3 => Cbor::Text(String::from_utf8(self.take(n)?).map_err(|_| EnvelopeError::Corrupt)?),
            4 => Cbor::Array((0..n.min(1024)).map(|_| self.item()).collect::<Result<_, _>>()?),
            5 => {
                let mut kv = vec![];
                for _ in 0..n.min(64) {
                    let Cbor::Text(k) = self.item()? else { return Err(EnvelopeError::Corrupt) };
                    kv.push((k, self.item()?));
                }
                Cbor::Map(kv)
            }
            _ => return Err(EnvelopeError::Corrupt),
        };
        self.depth -= 1;
        Ok(v)
    }
}

fn decode(b: &[u8]) -> Result<Cbor, EnvelopeError> {
    let mut d = Dec { b, i: 0, depth: 0 };
    let v = d.item()?;
    if d.i != b.len() {
        return Err(EnvelopeError::Corrupt);
    }
    Ok(v)
}

// ---------------------------------------------------------------- the envelope

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub sender: String,
    pub ephemeral: Vec<u8>,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
    /// (address, nonce, wrapped content key)
    pub wraps: Vec<(String, [u8; 12], Vec<u8>)>,
}

fn nonce12(b: &[u8]) -> Result<[u8; 12], EnvelopeError> {
    b.try_into().map_err(|_| EnvelopeError::Corrupt)
}

impl Envelope {
    pub fn to_bytes(&self) -> Vec<u8> {
        let w = self
            .wraps
            .iter()
            .map(|(a, n, k)| Cbor::Array(vec![Cbor::Text(a.clone()), Cbor::Bytes(n.to_vec()), Cbor::Bytes(k.clone())]))
            .collect();
        let m = Cbor::Map(vec![
            ("c".into(), Cbor::Bytes(self.ciphertext.clone())),
            ("e".into(), Cbor::Bytes(self.ephemeral.clone())),
            ("n".into(), Cbor::Bytes(self.nonce.to_vec())),
            ("s".into(), Cbor::Text(self.sender.clone())),
            ("v".into(), Cbor::Uint(1)),
            ("w".into(), Cbor::Array(w)),
        ]);
        let mut out = vec![];
        encode(&m, &mut out);
        out
    }

    pub fn from_bytes(b: &[u8]) -> Result<Envelope, EnvelopeError> {
        let Cbor::Map(kv) = decode(b)? else { return Err(EnvelopeError::Corrupt) };
        let get = |k: &str| kv.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone()).ok_or(EnvelopeError::Corrupt);
        if get("v")? != Cbor::Uint(1) {
            return Err(EnvelopeError::Version);
        }
        let (Cbor::Bytes(c), Cbor::Bytes(e), Cbor::Bytes(n), Cbor::Text(s), Cbor::Array(w)) = (get("c")?, get("e")?, get("n")?, get("s")?, get("w")?) else {
            return Err(EnvelopeError::Corrupt);
        };
        let wraps = w
            .into_iter()
            .map(|x| match x {
                Cbor::Array(t) => match t.as_slice() {
                    [Cbor::Text(a), Cbor::Bytes(n), Cbor::Bytes(k)] => Ok((a.clone(), nonce12(n)?, k.clone())),
                    _ => Err(EnvelopeError::Corrupt),
                },
                _ => Err(EnvelopeError::Corrupt),
            })
            .collect::<Result<_, _>>()?;
        Ok(Envelope { sender: s, ephemeral: e, nonce: nonce12(&n)?, ciphertext: c, wraps })
    }
}

/// Seal with explicit randomness (tests, and vectors shared with the client).
#[allow(clippy::too_many_arguments)]
pub fn seal_with(
    game: &str,
    instance: &str,
    sender: (&str, &[u8]),
    recipients: &[(&str, &[u8])],
    plaintext: &[u8],
    ephemeral: &SecretKey,
    content_key: [u8; 32],
    n0: [u8; 12],
    nonces: &[[u8; 12]],
) -> Result<Vec<u8>, EnvelopeError> {
    let l = label(game, instance);
    let e_pub = ephemeral.public_key().to_encoded_point(true).as_bytes().to_vec();
    let mut aad = l.clone();
    aad.extend(sender.0.as_bytes());
    let c = Aes256Gcm::new(&content_key.into())
        .encrypt(Nonce::from_slice(&n0), Payload { msg: plaintext, aad: &aad })
        .map_err(|_| EnvelopeError::Corrupt)?;
    let mut parties: Vec<(&str, &[u8])> = recipients.iter().filter(|r| r.0 != sender.0).copied().collect();
    parties.push(sender);
    if nonces.len() != parties.len() {
        return Err(EnvelopeError::Corrupt);
    }
    let mut wraps = vec![];
    for ((address, pk), n) in parties.iter().zip(nonces) {
        let p = PublicKey::from_sec1_bytes(pk).map_err(|_| EnvelopeError::BadKey(address.to_string()))?;
        let z = diffie_hellman(ephemeral.to_nonzero_scalar(), p.as_affine());
        let w = wrap_key(z.raw_secret_bytes(), &e_pub, &l);
        let k = Aes256Gcm::new(&w.into()).encrypt(Nonce::from_slice(n), content_key.as_slice()).map_err(|_| EnvelopeError::Corrupt)?;
        wraps.push((address.to_string(), *n, k));
    }
    Ok(Envelope { sender: sender.0.into(), ephemeral: e_pub, nonce: n0, ciphertext: c, wraps }.to_bytes())
}

/// Seal with fresh randomness.
pub fn seal(game: &str, instance: &str, sender: (&str, &[u8]), recipients: &[(&str, &[u8])], plaintext: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let rnd = |n: usize| {
        let mut b = vec![0u8; n];
        getrandom::getrandom(&mut b).expect("system randomness");
        b
    };
    let eph = loop {
        if let Ok(k) = SecretKey::from_slice(&rnd(32)) {
            break k;
        }
    };
    let ck: [u8; 32] = rnd(32).try_into().unwrap();
    let n0: [u8; 12] = rnd(12).try_into().unwrap();
    let count = recipients.iter().filter(|r| r.0 != sender.0).count() + 1;
    let nonces: Vec<[u8; 12]> = (0..count).map(|_| rnd(12).try_into().unwrap()).collect();
    seal_with(game, instance, sender, recipients, plaintext, &eph, ck, n0, &nonces)
}

/// Open an envelope addressed to `me` with `key`. Answers (sender, plaintext).
pub fn open(game: &str, instance: &str, me: &str, key: &SigningKey, bytes: &[u8]) -> Result<(String, Vec<u8>), EnvelopeError> {
    let env = Envelope::from_bytes(bytes)?;
    let (_, n, wrapped) = env.wraps.iter().find(|(a, _, _)| a == me).ok_or(EnvelopeError::NotAddressed)?;
    let e = PublicKey::from_sec1_bytes(&env.ephemeral).map_err(|_| EnvelopeError::Corrupt)?;
    let l = label(game, instance);
    let z = diffie_hellman(key.as_nonzero_scalar(), e.as_affine());
    let w = wrap_key(z.raw_secret_bytes(), &env.ephemeral, &l);
    let k = Aes256Gcm::new(&w.into()).decrypt(Nonce::from_slice(n), wrapped.as_slice()).map_err(|_| EnvelopeError::WrongScope)?;
    let k: [u8; 32] = k.try_into().map_err(|_| EnvelopeError::Corrupt)?;
    let mut aad = l;
    aad.extend(env.sender.as_bytes());
    let pt = Aes256Gcm::new(&k.into())
        .decrypt(Nonce::from_slice(&env.nonce), Payload { msg: &env.ciphertext, aad: &aad })
        .map_err(|_| EnvelopeError::WrongScope)?;
    Ok((env.sender, pt))
}

// ---------------------------------------------------------------- sealed inks (F1R3Ink design §7)
//
// A private flag's inks use the message envelope with two changes. The domain
// is `<game>/ink/v1` and the content key's aad binds the stripe and its next
// sequence number, so a sealed ink cannot be replayed onto another stripe or
// into another place in its own history. The two wraps (the target's and the
// inker's) carry no addresses and come in random order, so an anonymous
// stripe does not name its inker in its own envelope; readers try both.
//
// ```text
// label  = utf8(game + "/ink/v1") ‖ utf8(instance)
// aad    = label ‖ utf8(target) ‖ "|" ‖ utf8(sid) ‖ "|" ‖ decimal(seq)
// C      = AES-256-GCM_K(n0, colour byte ‖ 15 zero bytes, aad)
// CBOR   {c: C, d: sid, e: E, n: n0, q: seq, t: target, v: 2, w: [[n_j, wrap_j], [n_k, wrap_k]]}
// ```
// sid is the inker's address for an attributed stripe and "anon:<handle>" for
// an anonymous one.

pub const INK_VERSION: u64 = 2;
pub const INK_PLAINTEXT: usize = 16;

pub fn ink_label(game: &str, instance: &str) -> Vec<u8> {
    let mut l = format!("{game}/ink/v1").into_bytes();
    l.extend(instance.as_bytes());
    l
}

pub fn ink_aad(label: &[u8], target: &str, sid: &str, seq: u64) -> Vec<u8> {
    let mut a = label.to_vec();
    a.extend(format!("{target}|{sid}|{seq}").as_bytes());
    a
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InkEnvelope {
    pub target: String,
    pub sid: String,
    pub seq: u64,
    pub ephemeral: Vec<u8>,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
    /// (nonce, wrapped content key), unlabelled.
    pub wraps: Vec<([u8; 12], Vec<u8>)>,
}

impl InkEnvelope {
    pub fn to_bytes(&self) -> Vec<u8> {
        let w = self.wraps.iter().map(|(n, k)| Cbor::Array(vec![Cbor::Bytes(n.to_vec()), Cbor::Bytes(k.clone())])).collect();
        let m = Cbor::Map(vec![
            ("c".into(), Cbor::Bytes(self.ciphertext.clone())),
            ("d".into(), Cbor::Text(self.sid.clone())),
            ("e".into(), Cbor::Bytes(self.ephemeral.clone())),
            ("n".into(), Cbor::Bytes(self.nonce.to_vec())),
            ("q".into(), Cbor::Uint(self.seq)),
            ("t".into(), Cbor::Text(self.target.clone())),
            ("v".into(), Cbor::Uint(INK_VERSION)),
            ("w".into(), Cbor::Array(w)),
        ]);
        let mut out = vec![];
        encode(&m, &mut out);
        out
    }

    pub fn from_bytes(b: &[u8]) -> Result<InkEnvelope, EnvelopeError> {
        let Cbor::Map(kv) = decode(b)? else { return Err(EnvelopeError::Corrupt) };
        let get = |k: &str| kv.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone()).ok_or(EnvelopeError::Corrupt);
        if get("v")? != Cbor::Uint(INK_VERSION) {
            return Err(EnvelopeError::Version);
        }
        let (Cbor::Bytes(c), Cbor::Text(d), Cbor::Bytes(e), Cbor::Bytes(n), Cbor::Uint(q), Cbor::Text(t), Cbor::Array(w)) =
            (get("c")?, get("d")?, get("e")?, get("n")?, get("q")?, get("t")?, get("w")?)
        else {
            return Err(EnvelopeError::Corrupt);
        };
        let wraps = w
            .into_iter()
            .map(|x| match x {
                Cbor::Array(t) => match t.as_slice() {
                    [Cbor::Bytes(n), Cbor::Bytes(k)] => Ok((nonce12(n)?, k.clone())),
                    _ => Err(EnvelopeError::Corrupt),
                },
                _ => Err(EnvelopeError::Corrupt),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if wraps.is_empty() || wraps.len() > 4 {
            return Err(EnvelopeError::Corrupt);
        }
        Ok(InkEnvelope { target: t, sid: d, seq: q, ephemeral: e, nonce: nonce12(&n)?, ciphertext: c, wraps })
    }
}

/// The envelope's version (1: message, 2: ink), without opening it.
pub fn version(b: &[u8]) -> Result<u64, EnvelopeError> {
    let Cbor::Map(kv) = decode(b)? else { return Err(EnvelopeError::Corrupt) };
    match kv.iter().find(|(k, _)| k == "v").map(|(_, v)| v) {
        Some(Cbor::Uint(v)) => Ok(*v),
        _ => Err(EnvelopeError::Corrupt),
    }
}

/// Seal an ink with explicit randomness. `parties` are the public keys of the
/// target and the inker, in the order the wraps are to appear.
#[allow(clippy::too_many_arguments)]
pub fn seal_ink_with(
    game: &str,
    instance: &str,
    target: &str,
    sid: &str,
    seq: u64,
    parties: &[&[u8]],
    colour: u8,
    ephemeral: &SecretKey,
    content_key: [u8; 32],
    n0: [u8; 12],
    nonces: &[[u8; 12]],
) -> Result<Vec<u8>, EnvelopeError> {
    if parties.len() != nonces.len() || parties.is_empty() {
        return Err(EnvelopeError::Corrupt);
    }
    let l = ink_label(game, instance);
    let e_pub = ephemeral.public_key().to_encoded_point(true).as_bytes().to_vec();
    let mut pt = [0u8; INK_PLAINTEXT];
    pt[0] = colour;
    let c = Aes256Gcm::new(&content_key.into())
        .encrypt(Nonce::from_slice(&n0), Payload { msg: &pt, aad: &ink_aad(&l, target, sid, seq) })
        .map_err(|_| EnvelopeError::Corrupt)?;
    let mut wraps = vec![];
    for (pk, n) in parties.iter().zip(nonces) {
        let p = PublicKey::from_sec1_bytes(pk).map_err(|_| EnvelopeError::BadKey(hex::encode(pk)))?;
        let z = diffie_hellman(ephemeral.to_nonzero_scalar(), p.as_affine());
        let w = wrap_key(z.raw_secret_bytes(), &e_pub, &l);
        let k = Aes256Gcm::new(&w.into()).encrypt(Nonce::from_slice(n), content_key.as_slice()).map_err(|_| EnvelopeError::Corrupt)?;
        wraps.push((*n, k));
    }
    Ok(InkEnvelope { target: target.into(), sid: sid.into(), seq, ephemeral: e_pub, nonce: n0, ciphertext: c, wraps }.to_bytes())
}

/// An opened ink: where it says it belongs, its colour, and its content key
/// (which its owner discloses when going public).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenedInk {
    pub target: String,
    pub sid: String,
    pub seq: u64,
    pub colour: u8,
    pub key: [u8; 32],
}

fn ink_plaintext(env: &InkEnvelope, l: &[u8], k: &[u8; 32]) -> Result<u8, EnvelopeError> {
    let pt = Aes256Gcm::new(&(*k).into())
        .decrypt(Nonce::from_slice(&env.nonce), Payload { msg: &env.ciphertext, aad: &ink_aad(l, &env.target, &env.sid, env.seq) })
        .map_err(|_| EnvelopeError::WrongScope)?;
    if pt.len() != INK_PLAINTEXT || pt[1..].iter().any(|&b| b != 0) {
        return Err(EnvelopeError::Corrupt);
    }
    Ok(pt[0])
}

/// Open a sealed ink with `key`, trying each unlabelled wrap.
pub fn open_ink(game: &str, instance: &str, key: &SigningKey, bytes: &[u8]) -> Result<OpenedInk, EnvelopeError> {
    let env = InkEnvelope::from_bytes(bytes)?;
    let e = PublicKey::from_sec1_bytes(&env.ephemeral).map_err(|_| EnvelopeError::Corrupt)?;
    let l = ink_label(game, instance);
    let z = diffie_hellman(key.as_nonzero_scalar(), e.as_affine());
    let w = wrap_key(z.raw_secret_bytes(), &env.ephemeral, &l);
    let cipher = Aes256Gcm::new(&w.into());
    let k = env
        .wraps
        .iter()
        .find_map(|(n, wrapped)| cipher.decrypt(Nonce::from_slice(n), wrapped.as_slice()).ok())
        .ok_or(EnvelopeError::NotAddressed)?;
    let k: [u8; 32] = k.try_into().map_err(|_| EnvelopeError::Corrupt)?;
    let colour = ink_plaintext(&env, &l, &k)?;
    Ok(OpenedInk { target: env.target, sid: env.sid, seq: env.seq, colour, key: k })
}

/// Open a sealed ink with a disclosed content key (anyone can; design §7).
pub fn open_ink_with_key(game: &str, instance: &str, content_key: &[u8; 32], bytes: &[u8]) -> Result<OpenedInk, EnvelopeError> {
    let env = InkEnvelope::from_bytes(bytes)?;
    let colour = ink_plaintext(&env, &ink_label(game, instance), content_key)?;
    Ok(OpenedInk { target: env.target, sid: env.sid, seq: env.seq, colour, key: *content_key })
}
