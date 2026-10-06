//! F1R3Pix outside the shard: the board geometry, random seating, history
//! order and the play encodings (design §3.2, D2, §5.5, §10.2).
//!
//! The environment (`templates/games/f1r3pix.rho`) and the client
//! (`F1R3Pix/client/src/core`) implement the same rules; all three are held
//! to `F1R3Pix/vectors/pix-vectors.json`. The service and the CLI use this
//! module to check a published play against the chain: rebuild its body from
//! `f1r3pix.log` and compare.

use f1r3games_core::hash::blake2b256;
use std::collections::BTreeMap;

pub const MIN_CAPACITY: i64 = 7;
pub const MAX_CAPACITY: i64 = 469;

pub fn cells_for(radius: i64) -> i64 {
    3 * radius * (radius + 1) + 1
}

/// The smallest radius whose board seats `capacity`.
pub fn radius_for(capacity: i64) -> Option<i64> {
    if !(MIN_CAPACITY..=MAX_CAPACITY).contains(&capacity) {
        return None;
    }
    let mut r = 1;
    while cells_for(r) < capacity {
        r += 1;
    }
    Some(r)
}

pub fn ring_of(q: i64, r: i64) -> i64 {
    q.abs().max(r.abs()).max((q + r).abs())
}

/// Spiral index → (q, r): ring k starts at (−k, k) and walks k steps along
/// (+1,0), (+1,−1), (0,−1), (−1,0), (−1,+1), (0,+1).
pub fn idx_to_cell(i: i64) -> (i64, i64) {
    if i == 0 {
        return (0, 0);
    }
    let mut k = 1;
    while 3 * k * (k + 1) < i {
        k += 1;
    }
    let j = i - (3 * k * (k - 1) + 1);
    let s = j % k;
    match j / k {
        0 => (-k + s, k),
        1 => (s, k - s),
        2 => (k, -s),
        3 => (k - s, -k),
        4 => (-s, s - k),
        _ => (-k, s),
    }
}

/// (q, r) → spiral index.
pub fn cell_to_idx(q: i64, r: i64) -> i64 {
    let k = ring_of(q, r);
    if k == 0 {
        return 0;
    }
    let base = 3 * k * (k - 1) + 1;
    if r == k && q < 0 {
        base + q + k
    } else if q >= 0 && r > 0 && q + r == k {
        base + k + q
    } else if q == k && r <= 0 {
        base + 2 * k - r
    } else if r == -k && q > 0 {
        base + 3 * k + (k - q)
    } else if q + r == -k && q <= 0 {
        base + 4 * k - q
    } else {
        base + 5 * k + r
    }
}

/// blake2b-256(instance ‖ address), first four bytes big-endian.
pub fn seat_start(instance: &str, address: &str) -> u32 {
    let h = blake2b256(format!("{instance}{address}").as_bytes());
    u32::from_be_bytes([h[0], h[1], h[2], h[3]])
}

/// The cell random seating gives `address`, or None when the board is full.
pub fn random_seat(instance: &str, address: &str, radius: i64, taken: &std::collections::BTreeSet<(i64, i64)>) -> Option<(i64, i64)> {
    let n = cells_for(radius);
    let start = seat_start(instance, address) as i64 % n;
    (0..n).map(|t| idx_to_cell((start + t) % n)).find(|c| !taken.contains(c))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paint {
    pub h: i64,
    pub ts: i64,
    pub owner: String,
    pub q: i64,
    pub r: i64,
    /// `#RRGGBB`, or None for unpainted.
    pub colour: Option<String>,
}

/// History order (§5.5): height, then timestamp, then owner, keeping each
/// cell's own order (the order `log` lists it in).
pub fn order_paints(mut paints: Vec<Paint>) -> Vec<Paint> {
    paints.sort_by(|a, b| (a.h, a.ts, &a.owner).cmp(&(b.h, b.ts, &b.owner)));
    paints
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BodyError {
    #[error("not a F1R3Pix body")]
    Magic,
    #[error("unknown body version {0}")]
    Version(u8),
    #[error("truncated")]
    Truncated,
    #[error("trailing bytes")]
    Trailing,
    #[error("paints are not in history order")]
    Order,
    #[error("bad colour {0}")]
    Colour(String),
    #[error("bad value: {0}")]
    Value(&'static str),
}

const MAGIC: &[u8; 4] = b"F1PX";
const UNPAINTED: u8 = 255;
const SPILL: u8 = 254;

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

fn rgb(c: &str) -> Result<[u8; 3], BodyError> {
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit() && !x.is_ascii_lowercase());
    if !ok {
        return Err(BodyError::Colour(c.into()));
    }
    let n = u32::from_str_radix(&c[1..], 16).map_err(|_| BodyError::Colour(c.into()))?;
    Ok([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

/// Encode the history of a span; `paints` must be in history order.
pub fn encode_body(radius: i64, from: i64, to: i64, paints: &[Paint]) -> Result<Vec<u8>, BodyError> {
    let mut out = MAGIC.to_vec();
    out.push(1);
    out.push(u8::try_from(radius).map_err(|_| BodyError::Value("radius"))?);
    out.extend(u32::try_from(from).map_err(|_| BodyError::Value("from"))?.to_be_bytes());
    out.extend(u32::try_from(to).map_err(|_| BodyError::Value("to"))?.to_be_bytes());
    let mut palette: Vec<&str> = vec![];
    let mut index: BTreeMap<&str, usize> = BTreeMap::new();
    for p in paints {
        if let Some(c) = &p.colour {
            if !index.contains_key(c.as_str()) {
                index.insert(c, palette.len());
                palette.push(c);
            }
        }
    }
    varint(&mut out, palette.len() as u64);
    for c in &palette {
        out.extend(rgb(c)?);
    }
    varint(&mut out, paints.len() as u64);
    let mut prev = from;
    let mut owners: BTreeMap<i64, &str> = BTreeMap::new();
    for p in paints {
        if p.h < prev {
            return Err(BodyError::Order);
        }
        varint(&mut out, (p.h - prev) as u64);
        prev = p.h;
        let cell = cell_to_idx(p.q, p.r);
        out.extend((cell as u16).to_be_bytes());
        match &p.colour {
            None => out.push(UNPAINTED),
            Some(c) => {
                let i = index[c.as_str()];
                if i < SPILL as usize {
                    out.push(i as u8)
                } else {
                    out.push(SPILL);
                    out.extend((i as u16).to_be_bytes());
                }
            }
        }
        owners.entry(cell).or_insert(&p.owner);
    }
    varint(&mut out, owners.len() as u64);
    for (cell, owner) in owners {
        out.extend((cell as u16).to_be_bytes());
        out.push(u8::try_from(owner.len()).map_err(|_| BodyError::Value("address too long"))?);
        out.extend(owner.as_bytes());
    }
    Ok(out)
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
        let s = self.b.get(self.i..self.i + n).ok_or(BodyError::Truncated)?;
        self.i += n;
        Ok(s)
    }
    fn u16(&mut self) -> Result<u16, BodyError> {
        Ok(u16::from_be_bytes([self.u8()?, self.u8()?]))
    }
    fn u32(&mut self) -> Result<u32, BodyError> {
        Ok(u32::from_be_bytes([self.u8()?, self.u8()?, self.u8()?, self.u8()?]))
    }
    fn varint(&mut self) -> Result<u64, BodyError> {
        let (mut x, mut m) = (0u64, 1u64);
        loop {
            let b = self.u8()?;
            x += (b & 127) as u64 * m;
            if b & 128 == 0 {
                return Ok(x);
            }
            m = m.checked_mul(128).ok_or(BodyError::Value("varint"))?;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Body {
    pub radius: i64,
    pub from: i64,
    pub to: i64,
    pub palette: Vec<String>,
    /// Decoded paints carry no timestamp (the body records heights only); `ts` is 0.
    pub paints: Vec<Paint>,
}

pub fn decode_body(b: &[u8]) -> Result<Body, BodyError> {
    let mut r = Reader { b, i: 0 };
    if r.take(4)? != MAGIC {
        return Err(BodyError::Magic);
    }
    let v = r.u8()?;
    if v != 1 {
        return Err(BodyError::Version(v));
    }
    let radius = r.u8()? as i64;
    let (from, to) = (r.u32()? as i64, r.u32()? as i64);
    let np = r.varint()?;
    let mut palette = vec![];
    for _ in 0..np {
        let c = r.take(3)?;
        palette.push(format!("#{:02X}{:02X}{:02X}", c[0], c[1], c[2]));
    }
    let n = r.varint()?;
    let mut raw = vec![];
    let mut h = from;
    for _ in 0..n {
        h += r.varint()? as i64;
        let cell = r.u16()? as i64;
        let colour = match r.u8()? {
            UNPAINTED => None,
            SPILL => Some(palette.get(r.u16()? as usize).ok_or(BodyError::Value("palette index"))?.clone()),
            i => Some(palette.get(i as usize).ok_or(BodyError::Value("palette index"))?.clone()),
        };
        raw.push((h, cell, colour));
    }
    let mut owners = BTreeMap::new();
    for _ in 0..r.varint()? {
        let cell = r.u16()? as i64;
        let len = r.u8()? as usize;
        let a = String::from_utf8(r.take(len)?.to_vec()).map_err(|_| BodyError::Value("address"))?;
        owners.insert(cell, a);
    }
    if r.i != b.len() {
        return Err(BodyError::Trailing);
    }
    let paints = raw
        .into_iter()
        .map(|(h, cell, colour)| {
            let (q, rr) = idx_to_cell(cell);
            Ok(Paint { h, ts: 0, owner: owners.get(&cell).cloned().ok_or(BodyError::Value("owner"))?, q, r: rr, colour })
        })
        .collect::<Result<_, _>>()?;
    Ok(Body { radius, from, to, palette, paints })
}

/// The header's preview frame: one byte per cell in spiral order (255 void,
/// 254 seated and unpainted, otherwise a palette index), as lower-case hex.
/// `cells` maps (q, r) to Some(colour) or None (seated, unpainted).
pub fn encode_preview(radius: i64, cells: &BTreeMap<(i64, i64), Option<String>>) -> (Vec<String>, String) {
    let mut palette: Vec<String> = vec![];
    let mut frame = String::new();
    for i in 0..cells_for(radius) {
        let b = match cells.get(&idx_to_cell(i)) {
            None => 255u8,
            Some(None) => 254,
            Some(Some(c)) => match palette.iter().position(|p| p == c) {
                Some(j) => j as u8,
                None if palette.len() < 254 => {
                    palette.push(c.clone());
                    (palette.len() - 1) as u8
                }
                None => nearest(c, &palette),
            },
        };
        frame.push_str(&format!("{b:02x}"));
    }
    (palette, frame)
}

fn nearest(c: &str, palette: &[String]) -> u8 {
    let x = rgb(c).unwrap_or([0, 0, 0]);
    let d = |p: &String| {
        let y = rgb(p).unwrap_or([0, 0, 0]);
        (0..3).map(|i| (x[i] as i64 - y[i] as i64).pow(2)).sum::<i64>()
    };
    palette.iter().enumerate().min_by_key(|(_, p)| d(p)).map(|(i, _)| i as u8).unwrap_or(0)
}
