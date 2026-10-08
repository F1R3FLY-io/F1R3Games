//! F1R3Ink outside the shard (design v1, 8 October 2026): the round's
//! configuration, decay, the relay's stripe handles, history order and the
//! two play encodings (a `round` and a `flag` portrait).
//!
//! The environment (`templates/games/f1r3ink.rho`) and the client
//! (`F1R3Ink/client/src/core`) implement the same rules; all three are held
//! to `F1R3Ink/vectors/ink-vectors.json`. The service's relay uses
//! [`handle`]; anyone can use the decoders to check a published play against
//! `f1r3ink.log`.

use f1r3games_core::Value;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::BTreeMap;

pub const MIN_CAPACITY: i64 = 3;
pub const MAX_CAPACITY: i64 = 64;
pub const MAX_PALETTE: usize = 32;
pub const MAX_SEALED: usize = 512;

/// The default palette (D4): sixteen colours far apart in hue and lightness,
/// identified by number and hex value, never by name.
pub const DEFAULT_PALETTE: [&str; 16] = [
    "#E6194B", "#F58231", "#FFE119", "#BFEF45", "#3CB44B", "#42D4F4", "#4363D8", "#911EB4",
    "#F032E6", "#FABED4", "#DCBEFF", "#9A6324", "#800000", "#000075", "#A9A9A9", "#FFFFFF",
];

/// Decay presets (D5): (name, unit in ms, steps).
pub const DECAY_PRESETS: [(&str, i64, i64); 4] =
    [("evening", 600_000, 12), ("day", 3_600_000, 24), ("week", 21_600_000, 28), ("season", 86_400_000, 90)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decay {
    pub unit: i64,
    pub steps: i64,
}

/// Steps of opacity left to a stripe last inked at block time `last` when the
/// clock reads `now` (D5): `k − ⌊(now − last)/u⌋`, at least 0. `None` without
/// decay. A `now` before `last` counts as no time at all.
pub fn remaining(decay: Option<Decay>, last: i64, now: i64) -> Option<i64> {
    let d = decay?;
    let elapsed = (now - last).max(0);
    Some((d.steps - elapsed / d.unit).max(0))
}

/// The opacity α ∈ [0, 1] of that stripe.
pub fn opacity(decay: Option<Decay>, last: i64, now: i64) -> f64 {
    match (decay, remaining(decay, last, now)) {
        (Some(d), Some(r)) => r as f64 / d.steps as f64,
        _ => 1.0,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub capacity: i64,
    pub palette: Vec<String>,
    pub decay: Option<Decay>,
    pub min_interval: i64,
    pub anonymous: bool,
    pub anon_min: i64,
    pub reciprocity: bool,
    pub message_limit: i64,
}

fn colour_ok(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit() && !x.is_ascii_lowercase())
}

/// The configuration as the environment validates it (R1): exactly these
/// keys, in range, with no defaults.
pub fn config(v: &Value) -> Option<Config> {
    let Value::Map(m) = v else { return None };
    let keys = ["anonMin", "anonymous", "capacity", "decay", "messageLimit", "minInterval", "palette", "reciprocity"];
    if m.len() != keys.len() || !keys.iter().all(|k| m.contains_key(*k)) {
        return None;
    }
    let int = |k: &str| m.get(k).and_then(Value::as_int);
    let boolean = |k: &str| match m.get(k) {
        Some(Value::Bool(b)) => Some(*b),
        _ => None,
    };
    let (cap, gap, amin, limit) = (int("capacity")?, int("minInterval")?, int("anonMin")?, int("messageLimit")?);
    if !(MIN_CAPACITY..=MAX_CAPACITY).contains(&cap) || !(0..=86_400_000).contains(&gap) || !(3..=64).contains(&amin) || !(1..=65536).contains(&limit) {
        return None;
    }
    let Some(Value::List(p)) = m.get("palette") else { return None };
    let palette: Vec<String> = p.iter().map(|x| x.as_str().map(String::from)).collect::<Option<_>>()?;
    let distinct: std::collections::BTreeSet<&String> = palette.iter().collect();
    if palette.len() < 2 || palette.len() > MAX_PALETTE || distinct.len() != palette.len() || !palette.iter().all(|c| colour_ok(c)) {
        return None;
    }
    let decay = match m.get("decay") {
        Some(Value::Nil) => None,
        Some(Value::Map(d)) => {
            if d.len() != 2 {
                return None;
            }
            let (u, k) = (d.get("unit")?.as_int()?, d.get("steps")?.as_int()?);
            if u < 1000 || !(1..=1000).contains(&k) {
                return None;
            }
            Some(Decay { unit: u, steps: k })
        }
        _ => return None,
    };
    Some(Config {
        capacity: cap,
        palette,
        decay,
        min_interval: gap,
        anonymous: boolean("anonymous")?,
        anon_min: amin,
        reciprocity: boolean("reciprocity")?,
        message_limit: limit,
    })
}

// ------------------------------------------------------------------ the relay's handles

/// The handle of the anonymous stripe `inker` holds on `target` (design §8):
/// HMAC-SHA-256(secret, "f1r3ink/handle/v1" ‖ instance ‖ 0 ‖ target ‖ 0 ‖ inker),
/// first 16 bytes, as lower-case hex. The relay keeps no table.
pub fn handle(secret: &[u8], instance: &str, target: &str, inker: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(b"f1r3ink/handle/v1");
    mac.update(instance.as_bytes());
    mac.update(&[0]);
    mac.update(target.as_bytes());
    mac.update(&[0]);
    mac.update(inker.as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..16])
}

// ------------------------------------------------------------------ history

/// A stripe id: the inker's address, or an anonymous handle (hex).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Sid {
    By(String),
    Anon(String),
}

impl Sid {
    /// "address" or "anon:<handle>", as envelopes and clients write it.
    pub fn key(&self) -> String {
        match self {
            Sid::By(a) => a.clone(),
            Sid::Anon(h) => format!("anon:{h}"),
        }
    }
    pub fn parse(key: &str) -> Sid {
        match key.strip_prefix("anon:") {
            Some(h) => Sid::Anon(h.to_string()),
            None => Sid::By(key.to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ink {
    /// A palette index, in the clear.
    Colour(u8),
    Lifted,
    /// Sealed: the colour if disclosed, and BLAKE2b-256 of the envelope.
    Sealed { colour: Option<u8>, hash: [u8; 32] },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Visibility { player: String, public: bool },
    Tags { player: String, tags: Vec<String> },
    Veil { player: String, sids: Vec<Sid> },
    Ink { target: String, sid: Sid, ink: Ink },
    Reveal { target: String, handle: String, player: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub h: i64,
    pub t: i64,
    pub kind: Kind,
}

impl Event {
    /// (rank, subject, detail) within a block (design §6.5).
    fn key(&self) -> (u8, String, String) {
        match &self.kind {
            Kind::Visibility { player, .. } => (0, player.clone(), String::new()),
            Kind::Tags { player, .. } => (1, player.clone(), String::new()),
            Kind::Veil { player, .. } => (2, player.clone(), String::new()),
            Kind::Ink { target, sid, .. } => (3, target.clone(), sid.key()),
            Kind::Reveal { target, handle, .. } => (4, target.clone(), format!("anon:{handle}")),
        }
    }
}

/// History order: block number, block time, then visibility, tags, veils,
/// inks and reveals, each by subject and stripe. The sort is stable, so each
/// stripe's own history keeps the order `log` lists it in.
pub fn order_events(mut events: Vec<Event>) -> Vec<Event> {
    events.sort_by(|a, b| (a.h, a.t, a.key()).cmp(&(b.h, b.t, b.key())));
    events
}

// ------------------------------------------------------------------ encodings

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BodyError {
    #[error("not a F1R3Ink body")]
    Magic,
    #[error("unknown body version {0}")]
    Version(u8),
    #[error("truncated")]
    Truncated,
    #[error("trailing bytes")]
    Trailing,
    #[error("events are not in history order")]
    Order,
    #[error("bad value: {0}")]
    Value(&'static str),
}

const ROUND: &[u8; 4] = b"F1NK";
const FLAG: &[u8; 4] = b"F1NF";
const UNKNOWN: u8 = 255;
const SEP: char = '\u{1f}';

fn varint(out: &mut Vec<u8>, mut x: u64) {
    loop {
        let mut b = (x % 128) as u8;
        x /= 128;
        if x > 0 {
            b |= 128;
        }
        out.push(b);
        if x == 0 {
            break;
        }
    }
}

fn zigzag(x: i64) -> u64 {
    ((x << 1) ^ (x >> 63)) as u64
}

fn unzigzag(x: u64) -> i64 {
    ((x >> 1) as i64) ^ -((x & 1) as i64)
}

fn rgb(c: &str) -> Result<[u8; 3], BodyError> {
    if !colour_ok(c) {
        return Err(BodyError::Value("colour"));
    }
    let n = u32::from_str_radix(&c[1..], 16).map_err(|_| BodyError::Value("colour"))?;
    Ok([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

/// A span of a round's history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Round {
    pub from: i64,
    pub to: i64,
    pub palette: Vec<String>,
    pub decay: Option<Decay>,
    /// In history order.
    pub events: Vec<Event>,
}

struct Tables {
    players: Vec<String>,
    pi: BTreeMap<String, usize>,
    handles: Vec<String>,
    hi: BTreeMap<String, usize>,
}

impl Tables {
    fn player(&mut self, a: &str) {
        if !self.pi.contains_key(a) {
            self.pi.insert(a.to_string(), self.players.len());
            self.players.push(a.to_string());
        }
    }
    fn handle(&mut self, h: &str) {
        if !self.hi.contains_key(h) {
            self.hi.insert(h.to_string(), self.handles.len());
            self.handles.push(h.to_string());
        }
    }
    fn sid(&mut self, s: &Sid) {
        match s {
            Sid::By(a) => self.player(a),
            Sid::Anon(h) => self.handle(h),
        }
    }
}

fn write_sid(out: &mut Vec<u8>, t: &Tables, s: &Sid) {
    match s {
        Sid::By(a) => {
            out.push(0);
            varint(out, t.pi[a] as u64);
        }
        Sid::Anon(h) => {
            out.push(1);
            varint(out, t.hi[h] as u64);
        }
    }
}

/// `first` players take the first places in the player table (a portrait's owner).
fn encode_round_parts(r: &Round, out: &mut Vec<u8>, first: &[&str]) -> Result<Tables, BodyError> {
    let mut t = Tables { players: vec![], pi: BTreeMap::new(), handles: vec![], hi: BTreeMap::new() };
    first.iter().for_each(|a| t.player(a));
    for e in &r.events {
        match &e.kind {
            Kind::Visibility { player, .. } | Kind::Tags { player, .. } => t.player(player),
            Kind::Veil { player, sids } => {
                t.player(player);
                sids.iter().for_each(|s| t.sid(s));
            }
            Kind::Ink { target, sid, .. } => {
                t.player(target);
                t.sid(sid);
            }
            Kind::Reveal { target, handle, player } => {
                t.player(target);
                t.handle(handle);
                t.player(player);
            }
        }
    }
    out.extend(u32::try_from(r.from).map_err(|_| BodyError::Value("from"))?.to_be_bytes());
    out.extend(u32::try_from(r.to).map_err(|_| BodyError::Value("to"))?.to_be_bytes());
    let t0 = r.events.first().map(|e| e.t).unwrap_or(0);
    out.extend(u64::try_from(t0).map_err(|_| BodyError::Value("time"))?.to_be_bytes());
    let (steps, unit) = r.decay.map(|d| (d.steps, d.unit)).unwrap_or((0, 0));
    out.extend(u16::try_from(steps).map_err(|_| BodyError::Value("steps"))?.to_be_bytes());
    out.extend(u32::try_from(unit).map_err(|_| BodyError::Value("unit"))?.to_be_bytes());
    if r.palette.len() > MAX_PALETTE {
        return Err(BodyError::Value("palette"));
    }
    varint(out, r.palette.len() as u64);
    for c in &r.palette {
        out.extend(rgb(c)?);
    }
    varint(out, t.players.len() as u64);
    for a in &t.players {
        varint(out, a.len() as u64);
        out.extend(a.as_bytes());
    }
    varint(out, t.handles.len() as u64);
    for h in &t.handles {
        let b = hex::decode(h).map_err(|_| BodyError::Value("handle"))?;
        if b.len() != 16 {
            return Err(BodyError::Value("handle"));
        }
        out.extend(b);
    }
    varint(out, r.events.len() as u64);
    let (mut ph, mut pt) = (r.from, t0);
    let mut prev_key = None;
    for e in &r.events {
        let k = (e.h, e.t, e.key());
        if e.h < ph || prev_key.as_ref().is_some_and(|p| *p > k) {
            return Err(BodyError::Order);
        }
        prev_key = Some(k);
        varint(out, (e.h - ph) as u64);
        varint(out, zigzag(e.t - pt));
        (ph, pt) = (e.h, e.t);
        match &e.kind {
            Kind::Visibility { player, public } => {
                out.push(0);
                varint(out, t.pi[player] as u64);
                out.push(*public as u8);
            }
            Kind::Tags { player, tags } => {
                out.push(1);
                varint(out, t.pi[player] as u64);
                let s = tags.join(&SEP.to_string());
                varint(out, s.len() as u64);
                out.extend(s.as_bytes());
            }
            Kind::Ink { target, sid, ink } => {
                out.push(2);
                varint(out, t.pi[target] as u64);
                write_sid(out, &t, sid);
                match ink {
                    Ink::Colour(c) => out.extend([0, *c]),
                    Ink::Lifted => out.push(1),
                    Ink::Sealed { colour, hash } => {
                        out.extend([2, colour.unwrap_or(UNKNOWN)]);
                        out.extend(hash);
                    }
                }
            }
            Kind::Veil { player, sids } => {
                out.push(3);
                varint(out, t.pi[player] as u64);
                varint(out, sids.len() as u64);
                for s in sids {
                    write_sid(out, &t, s);
                }
            }
            Kind::Reveal { target, handle, player } => {
                out.push(4);
                varint(out, t.pi[target] as u64);
                varint(out, t.hi[handle] as u64);
                varint(out, t.pi[player] as u64);
            }
        }
    }
    Ok(t)
}

/// Encode a `round` play's body. Events must be in history order.
pub fn encode_round(r: &Round) -> Result<Vec<u8>, BodyError> {
    let mut out = ROUND.to_vec();
    out.push(1);
    encode_round_parts(r, &mut out, &[])?;
    Ok(out)
}

/// A portrait: one person's flag over a span, with the content keys of the
/// sealed inks it discloses (event index → key).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Portrait {
    pub owner: String,
    pub round: Round,
    pub keys: Vec<(usize, [u8; 32])>,
}

/// Encode a `flag` play's body. Every event must concern the owner, who is
/// first in its player table.
pub fn encode_flag(p: &Portrait) -> Result<Vec<u8>, BodyError> {
    let mut out = FLAG.to_vec();
    out.push(1);
    if !p.round.events.iter().all(|e| concerns(&e.kind, &p.owner)) {
        return Err(BodyError::Value("an event that does not concern the owner"));
    }
    let t = encode_round_parts(&p.round, &mut out, &[&p.owner])?;
    let owner = t.pi[&p.owner];
    varint(&mut out, owner as u64);
    varint(&mut out, p.keys.len() as u64);
    for (i, k) in &p.keys {
        if *i >= p.round.events.len() {
            return Err(BodyError::Value("key index"));
        }
        varint(&mut out, *i as u64);
        out.extend(k);
    }
    Ok(out)
}

fn concerns(k: &Kind, owner: &str) -> bool {
    match k {
        Kind::Visibility { player, .. } | Kind::Tags { player, .. } | Kind::Veil { player, .. } => player == owner,
        Kind::Ink { target, .. } | Kind::Reveal { target, .. } => target == owner,
    }
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Result<u8, BodyError> {
        let x = *self.b.get(self.i).ok_or(BodyError::Truncated)?;
        self.i += 1;
        Ok(x)
    }
    fn take(&mut self, n: usize) -> Result<&[u8], BodyError> {
        let s = self.b.get(self.i..self.i.checked_add(n).ok_or(BodyError::Truncated)?).ok_or(BodyError::Truncated)?;
        self.i += n;
        Ok(s)
    }
    fn be(&mut self, n: usize) -> Result<u64, BodyError> {
        Ok(self.take(n)?.iter().fold(0u64, |a, &b| a * 256 + b as u64))
    }
    fn varint(&mut self) -> Result<u64, BodyError> {
        let (mut x, mut m) = (0u64, 1u64);
        loop {
            let b = self.u8()?;
            x = x.checked_add((b & 127) as u64 * m).ok_or(BodyError::Value("varint"))?;
            if b & 128 == 0 {
                return Ok(x);
            }
            m = m.checked_mul(128).ok_or(BodyError::Value("varint"))?;
        }
    }
    fn index<'t, T>(&mut self, table: &'t [T]) -> Result<&'t T, BodyError> {
        let i = self.varint()? as usize;
        table.get(i).ok_or(BodyError::Value("index"))
    }
}

fn read_sid(r: &mut Reader, players: &[String], handles: &[String]) -> Result<Sid, BodyError> {
    match r.u8()? {
        0 => Ok(Sid::By(r.index(players)?.clone())),
        1 => Ok(Sid::Anon(r.index(handles)?.clone())),
        _ => Err(BodyError::Value("stripe")),
    }
}

fn decode_round_parts(r: &mut Reader) -> Result<(Round, Vec<String>), BodyError> {
    let (from, to) = (r.be(4)? as i64, r.be(4)? as i64);
    let t0 = r.be(8)? as i64;
    let (steps, unit) = (r.be(2)? as i64, r.be(4)? as i64);
    let decay = if steps == 0 { None } else { Some(Decay { unit, steps }) };
    let np = r.varint()? as usize;
    if np > MAX_PALETTE {
        return Err(BodyError::Value("palette"));
    }
    let mut palette = vec![];
    for _ in 0..np {
        let c = r.take(3)?;
        palette.push(format!("#{:02X}{:02X}{:02X}", c[0], c[1], c[2]));
    }
    let mut players = vec![];
    for _ in 0..r.varint()? {
        let n = r.varint()? as usize;
        players.push(String::from_utf8(r.take(n)?.to_vec()).map_err(|_| BodyError::Value("address"))?);
    }
    let mut handles = vec![];
    for _ in 0..r.varint()? {
        handles.push(hex::encode(r.take(16)?));
    }
    let n = r.varint()?;
    let mut events = vec![];
    let (mut h, mut t) = (from, t0);
    for _ in 0..n {
        h += r.varint()? as i64;
        t += unzigzag(r.varint()?);
        let kind = match r.u8()? {
            0 => Kind::Visibility { player: r.index(&players)?.clone(), public: r.u8()? == 1 },
            1 => {
                let player = r.index(&players)?.clone();
                let len = r.varint()? as usize;
                let s = String::from_utf8(r.take(len)?.to_vec()).map_err(|_| BodyError::Value("tags"))?;
                Kind::Tags { player, tags: if s.is_empty() { vec![] } else { s.split(SEP).map(String::from).collect() } }
            }
            2 => {
                let target = r.index(&players)?.clone();
                let sid = read_sid(r, &players, &handles)?;
                let ink = match r.u8()? {
                    0 => Ink::Colour(r.u8()?),
                    1 => Ink::Lifted,
                    2 => {
                        let c = r.u8()?;
                        let hash: [u8; 32] = r.take(32)?.try_into().unwrap();
                        Ink::Sealed { colour: (c != UNKNOWN).then_some(c), hash }
                    }
                    _ => return Err(BodyError::Value("ink")),
                };
                Kind::Ink { target, sid, ink }
            }
            3 => {
                let player = r.index(&players)?.clone();
                let n = r.varint()?;
                let mut sids = vec![];
                for _ in 0..n.min(4096) {
                    sids.push(read_sid(r, &players, &handles)?);
                }
                Kind::Veil { player, sids }
            }
            4 => Kind::Reveal { target: r.index(&players)?.clone(), handle: r.index(&handles)?.clone(), player: r.index(&players)?.clone() },
            _ => return Err(BodyError::Value("event type")),
        };
        events.push(Event { h, t, kind });
    }
    Ok((Round { from, to, palette, decay, events }, players))
}

pub fn decode_round(b: &[u8]) -> Result<Round, BodyError> {
    let mut r = Reader { b, i: 0 };
    if r.take(4)? != ROUND {
        return Err(BodyError::Magic);
    }
    let v = r.u8()?;
    if v != 1 {
        return Err(BodyError::Version(v));
    }
    let (round, _) = decode_round_parts(&mut r)?;
    if r.i != b.len() {
        return Err(BodyError::Trailing);
    }
    Ok(round)
}

pub fn decode_flag(b: &[u8]) -> Result<Portrait, BodyError> {
    let mut r = Reader { b, i: 0 };
    if r.take(4)? != FLAG {
        return Err(BodyError::Magic);
    }
    let v = r.u8()?;
    if v != 1 {
        return Err(BodyError::Version(v));
    }
    let (round, players) = decode_round_parts(&mut r)?;
    let owner = r.index(&players)?.clone();
    let mut keys = vec![];
    for _ in 0..r.varint()? {
        let i = r.varint()? as usize;
        if i >= round.events.len() {
            return Err(BodyError::Value("key index"));
        }
        keys.push((i, r.take(32)?.try_into().unwrap()));
    }
    if r.i != b.len() {
        return Err(BodyError::Trailing);
    }
    Ok(Portrait { owner, round, keys })
}
