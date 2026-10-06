//! F1R3Beat outside the shard (design v2, 6 October 2026): the grid's shape
//! and palettes, random and row seating, the score bridge (grid → canonical
//! F1R3Score score), the play encodings, and reproduction.
//!
//! The environment (`templates/games/f1r3beat.rho`) and the client
//! (`F1R3Beat/client/src/core`) implement the same rules; all three are held
//! to `F1R3Beat/vectors/beat-vectors.json`. The CLI's breeder uses this module
//! to run an epoch, and anyone can use it to verify one (design §10.7).

use f1r3games_core::hash::blake2b256;
use std::collections::BTreeMap;

// ------------------------------------------------------------------ shape

pub const ROWS: [&str; 5] = ["drums", "bass", "guitar", "keys", "sax"];
pub const MAX_STEPS: i64 = 64;
/// The columns a host may choose (D5), as k in u = 1/k.
pub const COLUMNS: [i64; 7] = [4, 8, 16, 32, 6, 12, 24];
pub const DENOMINATORS: [i64; 4] = [2, 4, 8, 16];

/// The timbre declarations of the canonical score, in row order.
pub const TIMBRES: [(&str, i64, i64); 5] = [("drums", 0, 10), ("bass", 33, 2), ("guitar", 29, 3), ("keys", 0, 4), ("sax", 66, 5)];

/// The kit (Table 1), in increasing MIDI order.
pub const KIT: [(&str, i64); 12] = [
    ("kick", 36), ("rim", 37), ("snare", 38), ("clap", 39), ("chh", 42), ("phh", 44),
    ("ltom", 45), ("ohh", 46), ("mtom", 47), ("crash", 49), ("htom", 50), ("ride", 51),
];

/// MIDI ranges of the pitched rows (bass, guitar, keys, sax).
pub const RANGES: [(i64, i64); 5] = [(0, 0), (28, 55), (40, 76), (36, 84), (44, 75)];

pub const PITCH_CLASSES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/// A pattern's shape: meter n/d, bars, and the column 1/k.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Shape {
    pub n: i64,
    pub d: i64,
    pub bars: i64,
    pub k: i64,
}

impl Shape {
    /// Validates the shape (D1, D5): d in {2,4,8,16}, k a listed column,
    /// a whole number of columns per bar, 1 ≤ S ≤ 64.
    pub fn new(n: i64, d: i64, bars: i64, k: i64) -> Option<Shape> {
        let s = Shape { n, d, bars, k };
        let ok = (1..=32).contains(&n) && DENOMINATORS.contains(&d) && COLUMNS.contains(&k) && bars >= 1 && (n * k) % d == 0 && (1..=MAX_STEPS).contains(&s.steps_raw());
        ok.then_some(s)
    }
    fn steps_raw(&self) -> i64 {
        self.bars * self.n * self.k / self.d
    }
    pub fn per_bar(&self) -> i64 {
        self.n * self.k / self.d
    }
    /// S, the number of columns.
    pub fn steps(&self) -> i64 {
        self.steps_raw()
    }
    pub fn cells(&self) -> i64 {
        5 * self.steps()
    }
    /// Patterns breed only within a species: same meter and column (D13).
    pub fn species(&self) -> (i64, i64, i64) {
        (self.n, self.d, self.k)
    }
}

pub fn cell_index(step: i64, row: i64) -> i64 {
    5 * step + row
}
pub fn step_of(cell: i64) -> i64 {
    cell / 5
}
pub fn row_of(cell: i64) -> i64 {
    cell % 5
}

/// Grid distance on the loop as a cylinder (D10).
pub fn distance(a: i64, b: i64, steps: i64) -> i64 {
    let dt = (step_of(a) - step_of(b)).abs();
    dt.min(steps - dt) + (row_of(a) - row_of(b)).abs()
}

// ------------------------------------------------------------------ pitch

pub fn scale_steps(kind: &str) -> Option<&'static [i64]> {
    Some(match kind {
        "major" => &[0, 2, 4, 5, 7, 9, 11],
        "minor" => &[0, 2, 3, 5, 7, 8, 10],
        "dorian" => &[0, 2, 3, 5, 7, 9, 10],
        "pentatonic" => &[0, 2, 4, 7, 9],
        "minor-pentatonic" => &[0, 3, 5, 7, 10],
        "blues" => &[0, 3, 5, 6, 7, 10],
        "chromatic" => &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        _ => return None,
    })
}

pub fn pitch_class(name: &str) -> Option<i64> {
    PITCH_CLASSES.iter().position(|p| *p == name).map(|i| i as i64)
}

/// Scientific name with sharps: 60 → "C4".
pub fn midi_name(m: i64) -> String {
    format!("{}{}", PITCH_CLASSES[(m % 12) as usize], m / 12 - 1)
}

/// MIDI number of a pitched note name, or of a kit piece.
pub fn midi_of(note: &str) -> Option<i64> {
    if let Some((_, m)) = KIT.iter().find(|(k, _)| *k == note) {
        return Some(*m);
    }
    let (pc, oct) = note.split_at(note.len().checked_sub(1)?);
    let o: i64 = oct.parse().ok()?;
    Some(12 * (o + 1) + pitch_class(pc)?)
}

/// A host scale: (kind, tonic pitch class name), or None for every pitch.
pub type Scale = Option<(String, String)>;

/// Is `note` in the palette of `row` (D4)?
pub fn note_ok(row: i64, note: &str, scale: &Scale) -> bool {
    if row == 0 {
        return KIT.iter().any(|(k, _)| *k == note);
    }
    if KIT.iter().any(|(k, _)| *k == note) || note.len() < 2 || note.len() > 4 {
        return false;
    }
    let Some(m) = midi_of(note) else { return false };
    if midi_name(m) != note {
        return false; // sharps only, canonical spelling
    }
    let (lo, hi) = RANGES[row as usize];
    if m < lo || m > hi {
        return false;
    }
    match scale {
        None => true,
        Some((kind, tonic)) => match (scale_steps(kind), pitch_class(tonic)) {
            (Some(steps), Some(t)) => steps.contains(&((m + 12 - t) % 12)),
            _ => false,
        },
    }
}

/// The palette of a row, in increasing MIDI order.
pub fn palette(row: i64, scale: &Scale) -> Vec<String> {
    if row == 0 {
        return KIT.iter().map(|(k, _)| k.to_string()).collect();
    }
    let (lo, hi) = RANGES[row as usize];
    (lo..=hi).map(midi_name).filter(|n| note_ok(row, n, scale)).collect()
}

// ------------------------------------------------------------------ seating

/// blake2b-256(instance ‖ address), first four bytes big-endian (as F1R3Pix).
pub fn seat_start(instance: &str, address: &str) -> u32 {
    let h = blake2b256(format!("{instance}{address}").as_bytes());
    u32::from_be_bytes([h[0], h[1], h[2], h[3]])
}

/// Random seating (D2): the first free cell from `start mod 5S`, in index order, wrapping.
pub fn random_seat(instance: &str, address: &str, shape: &Shape, taken: &std::collections::BTreeSet<i64>) -> Option<i64> {
    let n = shape.cells();
    let start = seat_start(instance, address) as i64 % n;
    (0..n).map(|t| (start + t) % n).find(|c| !taken.contains(c))
}

/// Row seating (D2): the first free cell of `row` from step `start mod S`, wrapping.
pub fn row_seat(instance: &str, address: &str, shape: &Shape, row: i64, taken: &std::collections::BTreeSet<i64>) -> Option<i64> {
    let s = shape.steps();
    let start = seat_start(instance, address) as i64 % s;
    (0..s).map(|t| cell_index((start + t) % s, row)).find(|c| !taken.contains(c))
}

// ------------------------------------------------------------------ patterns and the score bridge

/// A pattern: its shape and one note (or nothing) per cell, cells in index order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    pub shape: Shape,
    pub cells: Vec<Option<String>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PatternError {
    #[error("bad shape")]
    Shape,
    #[error("expected {0} cells")]
    Cells(i64),
    #[error("cell {0}: {1} is not in its row's palette")]
    Note(i64, String),
    #[error("not a canonical F1R3Beat score: {0}")]
    Score(String),
}

fn gcd(a: i64, b: i64) -> i64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

fn frac(num: i64, den: i64) -> String {
    let g = gcd(num, den);
    if den / g == 1 { format!("{}", num / g) } else { format!("{}/{}", num / g, den / g) }
}

impl Pattern {
    pub fn new(shape: Shape, cells: Vec<Option<String>>) -> Result<Pattern, PatternError> {
        if cells.len() as i64 != shape.cells() {
            return Err(PatternError::Cells(shape.cells()));
        }
        for (c, v) in cells.iter().enumerate() {
            if let Some(n) = v {
                if !note_ok(row_of(c as i64), n, &None) {
                    return Err(PatternError::Note(c as i64, n.clone()));
                }
            }
        }
        Ok(Pattern { shape, cells })
    }

    pub fn silent(shape: Shape) -> Pattern {
        Pattern { shape, cells: vec![None; shape.cells() as usize] }
    }

    pub fn row(&self, row: i64) -> Vec<Option<String>> {
        (0..self.shape.steps()).map(|t| self.cells[cell_index(t, row) as usize].clone()).collect()
    }

    /// The line of a row: (pitch or "r", length in columns), rests merged (§7.2 rule 1).
    pub fn line(&self, row: i64) -> Vec<(String, i64)> {
        let mut out = vec![];
        let mut gap = 0;
        for v in self.row(row) {
            match v {
                Some(p) => {
                    if gap > 0 {
                        out.push(("r".to_string(), gap));
                        gap = 0;
                    }
                    out.push((p, 1));
                }
                None => gap += 1,
            }
        }
        if gap > 0 {
            out.push(("r".to_string(), gap));
        }
        out
    }

    /// The canonical F1R3Score text (design §7.2, form v2).
    pub fn score(&self) -> String {
        let s = self.shape;
        let lines: Vec<Vec<(String, i64)>> = (0..5).map(|r| self.line(r)).collect();
        let mut used: Vec<&str> = lines.iter().flatten().map(|(p, _)| p.as_str()).filter(|p| *p != "r").collect();
        used.sort();
        used.dedup();
        let mut kit: Vec<&str> = used.iter().copied().filter(|p| KIT.iter().any(|(k, _)| k == p)).collect();
        kit.sort_by_key(|p| midi_of(p));
        let mut pit: Vec<&str> = used.iter().copied().filter(|p| !KIT.iter().any(|(k, _)| k == p)).collect();
        pit.sort_by_key(|p| midi_of(p));
        let mut lens: Vec<i64> = lines.iter().flatten().map(|(_, k)| *k).collect();
        lens.sort();
        lens.dedup();
        let mut pd = vec!["r".to_string()];
        pd.extend(kit.iter().map(|p| format!("{p} = {}", midi_of(p).unwrap())));
        pd.extend(pit.iter().map(|p| p.to_string()));
        let dd: Vec<String> = lens.iter().map(|k| format!("c{k} = {}", frac(*k, s.k))).collect();
        let mut out = format!(
            "// F1R3Beat pattern, canonical form v2 · meter {}/{} · bars {} · column 1/{} · columns {}\nscore F1R3Beat\nimport std\npitches   {{ {} }}\ndurations {{ {} }}\n",
            s.n, s.d, s.bars, s.k, s.steps(), pd.join(", "), dd.join(", ")
        );
        out.push_str("timbres   { drums = gm(0) on 10, bass = gm(33) on 2, guitar = gm(29) on 3,\n            keys = gm(0) on 4, sax = gm(66) on 5 }\n");
        for (i, r) in ROWS.iter().enumerate() {
            let notes: Vec<String> = lines[i].iter().map(|(p, k)| format!("{p} c{k}")).collect();
            let chunks: Vec<String> = notes.chunks(8).map(|c| c.join(", ")).collect();
            let lead = if i == 0 { "play " } else { "   | " };
            let head = format!("line(base \"{r}\", {r})");
            let pad = " ".repeat(lead.len() + 32);
            out.push_str(&format!("{lead}{head:<30}  [ {} ]\n", chunks.join(&format!(",\n{pad}"))));
        }
        out
    }

    /// A pattern's identity: blake2b-256 of its canonical score, as hex.
    pub fn digest(&self) -> String {
        hex::encode(blake2b256(self.score().as_bytes()))
    }

    /// Parse a canonical score back into a pattern; refuses anything that does
    /// not re-render to exactly the same text.
    pub fn parse(text: &str) -> Result<Pattern, PatternError> {
        let e = |m: &str| PatternError::Score(m.to_string());
        let first = text.lines().next().ok_or_else(|| e("empty"))?;
        let rest = first.strip_prefix("// F1R3Beat pattern, canonical form v2 · meter ").ok_or_else(|| e("header"))?;
        let nums: Vec<i64> = rest
            .replace(" · bars ", " ")
            .replace(" · column 1/", " ")
            .replace(" · columns ", " ")
            .replace('/', " ")
            .split_whitespace()
            .map(|x| x.parse().map_err(|_| e("header numbers")))
            .collect::<Result<_, _>>()?;
        let [n, d, bars, k, _] = nums[..] else { return Err(e("header numbers")) };
        let shape = Shape::new(n, d, bars, k).ok_or(PatternError::Shape)?;
        let mut cells = vec![None; shape.cells() as usize];
        for (i, r) in ROWS.iter().enumerate() {
            let marker = format!("line(base \"{r}\", {r})");
            let at = text.find(&marker).ok_or_else(|| e("missing line"))?;
            let open = at + text[at..].find("[ ").ok_or_else(|| e("line"))? + 2;
            let close = open + text[open..].find(" ]").ok_or_else(|| e("line"))?;
            let mut t = 0i64;
            for item in text[open..close].split(',') {
                let mut w = item.split_whitespace();
                let (p, c) = (w.next().ok_or_else(|| e("note"))?, w.next().ok_or_else(|| e("note"))?);
                let len: i64 = c.strip_prefix('c').and_then(|x| x.parse().ok()).ok_or_else(|| e("length"))?;
                if p != "r" {
                    if t >= shape.steps() {
                        return Err(e("line too long"));
                    }
                    cells[cell_index(t, i as i64) as usize] = Some(p.to_string());
                }
                t += len;
            }
            if t != shape.steps() {
                return Err(e("line length"));
            }
        }
        let p = Pattern::new(shape, cells)?;
        if p.score() != text {
            return Err(e("not in canonical form"));
        }
        Ok(p)
    }

    /// The notes the score denotes, rests excluded: (onset as (num, den) whole notes, row, pitch).
    pub fn notes(&self) -> Vec<((i64, i64), &'static str, String)> {
        let mut out = vec![];
        for t in 0..self.shape.steps() {
            for r in 0..5 {
                if let Some(p) = &self.cells[cell_index(t, r) as usize] {
                    let g = gcd(t, self.shape.k).max(1);
                    out.push(((t / g, self.shape.k / g), ROWS[r as usize], p.clone()));
                }
            }
        }
        out
    }
}

// ------------------------------------------------------------------ CBOR (canonical, the subset used)

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cbor {
    Uint(u64),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(String, Cbor)>),
}

fn cbor_head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8)
    } else if n < 256 {
        out.extend([m | 24, n as u8])
    } else if n < 65536 {
        out.push(m | 25);
        out.extend((n as u16).to_be_bytes())
    } else if n < 1 << 32 {
        out.push(m | 26);
        out.extend((n as u32).to_be_bytes())
    } else {
        out.push(m | 27);
        out.extend(n.to_be_bytes())
    }
}

impl Cbor {
    /// Canonical encoding: map keys sorted by encoded length, then bytewise.
    pub fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Cbor::Uint(n) => cbor_head(out, 0, *n),
            Cbor::Text(s) => {
                cbor_head(out, 3, s.len() as u64);
                out.extend(s.as_bytes())
            }
            Cbor::Array(a) => {
                cbor_head(out, 4, a.len() as u64);
                a.iter().for_each(|x| x.encode(out))
            }
            Cbor::Map(m) => {
                let mut es: Vec<(Vec<u8>, &Cbor)> = m
                    .iter()
                    .map(|(k, v)| {
                        let mut kb = vec![];
                        Cbor::Text(k.clone()).encode(&mut kb);
                        (kb, v)
                    })
                    .collect();
                es.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then(a.0.cmp(&b.0)));
                cbor_head(out, 5, es.len() as u64);
                for (k, v) in es {
                    out.extend(k);
                    v.encode(out);
                }
            }
        }
    }
    pub fn decode(b: &[u8]) -> Result<Cbor, BodyError> {
        let mut r = Reader { b, i: 0 };
        let v = r.cbor(0)?;
        if r.i != b.len() {
            return Err(BodyError::Trailing);
        }
        Ok(v)
    }
}

// ------------------------------------------------------------------ bodies

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BodyError {
    #[error("not a F1R3Beat body")]
    Magic,
    #[error("unknown body version {0}")]
    Version(u8),
    #[error("truncated")]
    Truncated,
    #[error("trailing bytes")]
    Trailing,
    #[error("sets are not in history order")]
    Order,
    #[error("bad value: {0}")]
    Value(&'static str),
    #[error("{0}")]
    Pattern(#[from] PatternError),
}

/// A pattern play's body: CBOR {score, credits: [[cell, address], ...]} (§9.1).
pub fn encode_pattern_body(p: &Pattern, credits: &BTreeMap<i64, String>) -> Vec<u8> {
    let credits = Cbor::Array(credits.iter().map(|(c, a)| Cbor::Array(vec![Cbor::Uint(*c as u64), Cbor::Text(a.clone())])).collect());
    let mut out = vec![];
    Cbor::Map(vec![("score".into(), Cbor::Text(p.score())), ("credits".into(), credits)]).encode(&mut out);
    out
}

pub fn decode_pattern_body(b: &[u8]) -> Result<(Pattern, BTreeMap<i64, String>), BodyError> {
    let Cbor::Map(m) = Cbor::decode(b)? else { return Err(BodyError::Value("pattern body is a map")) };
    let get = |k: &str| m.iter().find(|(x, _)| x == k).map(|(_, v)| v);
    let Some(Cbor::Text(score)) = get("score") else { return Err(BodyError::Value("score")) };
    let p = Pattern::parse(score)?;
    let mut credits = BTreeMap::new();
    if let Some(Cbor::Array(cs)) = get("credits") {
        for c in cs {
            match c {
                Cbor::Array(v) => match &v[..] {
                    [Cbor::Uint(cell), Cbor::Text(a)] => {
                        credits.insert(*cell as i64, a.clone());
                    }
                    _ => return Err(BodyError::Value("credit")),
                },
                _ => return Err(BodyError::Value("credit")),
            }
        }
    }
    Ok((p, credits))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Set {
    pub h: i64,
    pub ts: i64,
    pub owner: String,
    pub cell: i64,
    /// The note, or None for nothing.
    pub note: Option<String>,
}

/// History order (as F1R3Pix §5.5): height, then timestamp, then owner, keeping each cell's order.
pub fn order_sets(mut sets: Vec<Set>) -> Vec<Set> {
    sets.sort_by(|a, b| (a.h, a.ts, &a.owner).cmp(&(b.h, b.ts, &b.owner)));
    sets
}

const MAGIC: &[u8; 4] = b"F1BT";
const NOTHING: u8 = 255;

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

/// Encode a session (§9.2); `sets` must be in history order.
pub fn encode_session(shape: &Shape, from: i64, to: i64, sets: &[Set]) -> Result<Vec<u8>, BodyError> {
    let mut out = MAGIC.to_vec();
    out.extend([1, shape.n as u8, shape.d as u8, shape.k as u8, shape.bars as u8]);
    out.extend(u32::try_from(from).map_err(|_| BodyError::Value("from"))?.to_be_bytes());
    out.extend(u32::try_from(to).map_err(|_| BodyError::Value("to"))?.to_be_bytes());
    let mut table: Vec<(i64, i64)> = vec![]; // (row, midi)
    for s in sets {
        if let Some(n) = &s.note {
            let e = (row_of(s.cell), midi_of(n).ok_or(BodyError::Value("note"))?);
            if !table.contains(&e) {
                table.push(e);
            }
        }
    }
    if table.len() > 254 {
        return Err(BodyError::Value("too many notes"));
    }
    varint(&mut out, table.len() as u64);
    for (r, m) in &table {
        out.extend([*r as u8, *m as u8]);
    }
    varint(&mut out, sets.len() as u64);
    let mut prev = from;
    let mut owners: BTreeMap<i64, &str> = BTreeMap::new();
    for s in sets {
        if s.h < prev {
            return Err(BodyError::Order);
        }
        varint(&mut out, (s.h - prev) as u64);
        prev = s.h;
        out.extend((s.cell as u16).to_be_bytes());
        match &s.note {
            None => out.push(NOTHING),
            Some(n) => out.push(table.iter().position(|e| *e == (row_of(s.cell), midi_of(n).unwrap())).unwrap() as u8),
        }
        owners.entry(s.cell).or_insert(&s.owner);
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
    fn arg(&mut self, info: u8) -> Result<u64, BodyError> {
        Ok(match info {
            0..=23 => info as u64,
            24 => self.u8()? as u64,
            25 => self.u16()? as u64,
            26 => self.u32()? as u64,
            27 => u64::from_be_bytes(self.take(8)?.try_into().unwrap()),
            _ => return Err(BodyError::Value("cbor length")),
        })
    }
    fn cbor(&mut self, depth: usize) -> Result<Cbor, BodyError> {
        if depth > 16 {
            return Err(BodyError::Value("cbor depth"));
        }
        let h = self.u8()?;
        let n = self.arg(h & 31)?;
        Ok(match h >> 5 {
            0 => Cbor::Uint(n),
            3 => Cbor::Text(String::from_utf8(self.take(n as usize)?.to_vec()).map_err(|_| BodyError::Value("utf-8"))?),
            4 => Cbor::Array((0..n).map(|_| self.cbor(depth + 1)).collect::<Result<_, _>>()?),
            5 => Cbor::Map(
                (0..n)
                    .map(|_| match self.cbor(depth + 1)? {
                        Cbor::Text(k) => Ok((k, self.cbor(depth + 1)?)),
                        _ => Err(BodyError::Value("cbor key")),
                    })
                    .collect::<Result<_, _>>()?,
            ),
            _ => return Err(BodyError::Value("cbor type")),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub shape: Shape,
    pub from: i64,
    pub to: i64,
    /// Decoded sets carry no timestamp; `ts` is 0.
    pub sets: Vec<Set>,
}

fn note_from(row: i64, midi: i64) -> String {
    if row == 0 {
        KIT.iter().find(|(_, m)| *m == midi).map(|(k, _)| k.to_string()).unwrap_or_default()
    } else {
        midi_name(midi)
    }
}

pub fn decode_session(b: &[u8]) -> Result<Session, BodyError> {
    let mut r = Reader { b, i: 0 };
    if r.take(4)? != MAGIC {
        return Err(BodyError::Magic);
    }
    let v = r.u8()?;
    if v != 1 {
        return Err(BodyError::Version(v));
    }
    let (n, d, k, bars) = (r.u8()? as i64, r.u8()? as i64, r.u8()? as i64, r.u8()? as i64);
    let shape = Shape::new(n, d, bars, k).ok_or(BodyError::Value("shape"))?;
    let (from, to) = (r.u32()? as i64, r.u32()? as i64);
    let table: Vec<(i64, i64)> = (0..r.varint()?).map(|_| Ok((r.u8()? as i64, r.u8()? as i64))).collect::<Result<_, BodyError>>()?;
    let count = r.varint()?;
    let mut raw = vec![];
    let mut h = from;
    for _ in 0..count {
        h += r.varint()? as i64;
        let cell = r.u16()? as i64;
        let note = match r.u8()? {
            NOTHING => None,
            i => {
                let (row, m) = *table.get(i as usize).ok_or(BodyError::Value("note index"))?;
                Some(note_from(row, m))
            }
        };
        raw.push((h, cell, note));
    }
    let mut owners = BTreeMap::new();
    for _ in 0..r.varint()? {
        let cell = r.u16()? as i64;
        let len = r.u8()? as usize;
        owners.insert(cell, String::from_utf8(r.take(len)?.to_vec()).map_err(|_| BodyError::Value("address"))?);
    }
    if r.i != b.len() {
        return Err(BodyError::Trailing);
    }
    let sets = raw
        .into_iter()
        .map(|(h, cell, note)| Ok(Set { h, ts: 0, owner: owners.get(&cell).cloned().ok_or(BodyError::Value("owner"))?, cell, note }))
        .collect::<Result<_, BodyError>>()?;
    Ok(Session { shape, from, to, sets })
}

// ------------------------------------------------------------------ the generator (R12)

/// xoshiro256** seeded through SplitMix64, as F1R3Score's `score-chance` `Prng`.
#[derive(Clone, Debug)]
pub struct Prng {
    s: [u64; 4],
}

impl Prng {
    pub fn new(seed: u64) -> Prng {
        let mut x = seed;
        let mut sm = || {
            x = x.wrapping_add(0x9E3779B97F4A7C15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z ^ (z >> 31)
        };
        Prng { s: [sm(), sm(), sm(), sm()] }
    }
    pub fn from_hash(h: &[u8; 32]) -> Prng {
        Prng::new(u64::from_le_bytes(h[..8].try_into().unwrap()))
    }
    pub fn next_u64(&mut self) -> u64 {
        let r = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        r
    }
    /// Uniform in 0..n by rejection, exactly as `score-chance`'s `below`.
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0);
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let x = self.next_u64();
            if x < zone {
                return x % n;
            }
        }
    }
    /// j of 0..m: the first j entries of a forward Fisher–Yates shuffle, sorted.
    pub fn choose(&mut self, j: usize, m: usize) -> Vec<usize> {
        let mut a: Vec<usize> = (0..m).collect();
        for i in 0..j.min(m) {
            let r = i + self.below((m - i) as u64) as usize;
            a.swap(i, r);
        }
        let mut out = a[..j.min(m)].to_vec();
        out.sort();
        out
    }
}

/// The epoch generator's seed hash: blake2b-256("f1r3beat/breed/v1" ‖ H ‖ epoch as u64 big-endian).
pub fn epoch_seed(block_hash: &[u8], epoch: u64) -> [u8; 32] {
    let mut b = b"f1r3beat/breed/v1".to_vec();
    b.extend(block_hash);
    b.extend(epoch.to_be_bytes());
    blake2b256(&b)
}

/// A cross's seed hash: blake2b-256("f1r3beat/cross/v1" ‖ H ‖ utf8(crosser)).
pub fn cross_seed(block_hash: &[u8], crosser: &str) -> [u8; 32] {
    let mut b = b"f1r3beat/cross/v1".to_vec();
    b.extend(block_hash);
    b.extend(crosser.as_bytes());
    blake2b256(&b)
}

/// A brood's generator: blake2b-256(seed ‖ digest(A) ‖ digest(B)), digests as bytes.
pub fn brood_seed(seed: &[u8; 32], a: &str, b: &str) -> [u8; 32] {
    let mut x = seed.to_vec();
    x.extend(hex::decode(a).unwrap_or_default());
    x.extend(hex::decode(b).unwrap_or_default());
    blake2b256(&x)
}

// ------------------------------------------------------------------ reproduction (§10)

/// Refill (§10.2): the slots of a rhythm take a melody; surplus pitches are
/// dropped and missing ones become rests, by draws from `g`.
pub fn refill(slots: &[usize], melody: &[String], g: &mut Prng) -> Vec<(usize, String)> {
    let (n, k) = (slots.len(), melody.len());
    if k >= n {
        let drop = g.choose(k - n, k);
        let kept: Vec<&String> = melody.iter().enumerate().filter(|(i, _)| !drop.contains(i)).map(|(_, p)| p).collect();
        slots.iter().zip(kept).map(|(s, p)| (*s, p.clone())).collect()
    } else {
        let silent = g.choose(n - k, n);
        let live: Vec<usize> = slots.iter().enumerate().filter(|(i, _)| !silent.contains(i)).map(|(_, s)| *s).collect();
        live.into_iter().zip(melody.iter()).map(|(s, p)| (s, p.clone())).collect()
    }
}

/// X(A, B): A's rhythm with B's melody, row by row. Draws refills in row order.
pub fn cross(a: &Pattern, b: &Pattern, g: &mut Prng) -> Pattern {
    let mut out = Pattern::silent(a.shape);
    for row in 0..5 {
        let ra = a.row(row);
        let slots: Vec<usize> = ra.iter().enumerate().filter(|(_, v)| v.is_some()).map(|(t, _)| t).collect();
        let melody: Vec<String> = b.row(row).into_iter().flatten().collect();
        for (t, p) in refill(&slots, &melody, g) {
            out.cells[cell_index(t as i64, row) as usize] = Some(p);
        }
    }
    out
}

/// V(A, B; c): whole lines, row ρ from B when bit ρ of c is set (drums the most significant).
pub fn voices(a: &Pattern, b: &Pattern, c: u64) -> Pattern {
    let mut out = a.clone();
    for row in 0..5 {
        if (c >> (4 - row)) & 1 == 1 {
            for t in 0..a.shape.steps() {
                out.cells[cell_index(t, row) as usize] = b.cells[cell_index(t, row) as usize].clone();
            }
        }
    }
    out
}

/// Pad a pattern with `extra` silent bars, each inserted at a boundary drawn from `g`.
pub fn pad(p: &Pattern, extra: i64, g: &mut Prng) -> Pattern {
    let per = p.shape.per_bar();
    let mut bars: Vec<Vec<Option<String>>> = (0..p.shape.bars).map(|b| p.cells[(5 * per * b) as usize..(5 * per * (b + 1)) as usize].to_vec()).collect();
    for _ in 0..extra {
        let at = g.below(bars.len() as u64 + 1) as usize;
        bars.insert(at, vec![None; (5 * per) as usize]);
    }
    let shape = Shape { bars: p.shape.bars + extra, ..p.shape };
    Pattern { shape, cells: bars.concat() }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Child {
    pub pattern: Pattern,
    /// "X" or "V".
    pub operator: &'static str,
    /// The parents' digests, rhythm (or first) parent first.
    pub parents: [String; 2],
}

/// The brood of A and B (D12): X(A,B), X(B,A), V(A,B;c), V(B,A;c). Requires one species.
/// Draw order (R13): padding, then c, then the refills of X(A,B), then of X(B,A).
pub fn brood(a: &Pattern, b: &Pattern, g: &mut Prng) -> Option<Vec<Child>> {
    if a.shape.species() != b.shape.species() {
        return None;
    }
    let (da, db) = (a.digest(), b.digest());
    let (mut pa, mut pb) = (a.clone(), b.clone());
    if pa.shape.bars < pb.shape.bars {
        pa = pad(&pa, pb.shape.bars - pa.shape.bars, g);
    } else if pb.shape.bars < pa.shape.bars {
        pb = pad(&pb, pa.shape.bars - pb.shape.bars, g);
    }
    let c = g.below(30) + 1;
    let xab = cross(a, b, g);
    let xba = cross(b, a, g);
    Some(vec![
        Child { pattern: xab, operator: "X", parents: [da.clone(), db.clone()] },
        Child { pattern: xba, operator: "X", parents: [db.clone(), da.clone()] },
        Child { pattern: voices(&pa, &pb, c), operator: "V", parents: [da.clone(), db.clone()] },
        Child { pattern: voices(&pb, &pa, c), operator: "V", parents: [db, da] },
    ])
}

/// A population member as the breeder sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub digest: String,
    pub shape: Shape,
    pub born: i64,
    pub weight: u64,
}

/// w = 1 + plays + 3·likes (D14).
pub fn weight(plays: u64, likes: u64) -> u64 {
    1 + plays + 3 * likes
}

fn draw(members: &[&Member], g: &mut Prng) -> usize {
    let total: u64 = members.iter().map(|m| m.weight).sum();
    let mut x = g.below(total);
    for (i, m) in members.iter().enumerate() {
        if x < m.weight {
            return i;
        }
        x -= m.weight;
    }
    members.len() - 1
}

/// Selection (D14 steps 1–2) over members sorted by digest. Returns the parents' digests.
pub fn select(pop: &[Member], g: &mut Prng) -> Option<(String, String)> {
    let mut sorted: Vec<&Member> = pop.iter().collect();
    sorted.sort_by(|a, b| a.digest.cmp(&b.digest));
    if sorted.is_empty() {
        return None;
    }
    let count = |m: &Member| sorted.iter().filter(|x| x.shape.species() == m.shape.species()).count();
    let mut a = sorted[draw(&sorted, g)];
    if count(a) < 2 {
        let eligible: Vec<&Member> = sorted.iter().copied().filter(|m| count(m) >= 2).collect();
        if eligible.is_empty() {
            return None;
        }
        a = eligible[draw(&eligible, g)];
    }
    let mates: Vec<&Member> = sorted.iter().copied().filter(|m| m.shape.species() == a.shape.species() && m.digest != a.digest).collect();
    let b = mates[draw(&mates, g)];
    Some((a.digest.clone(), b.digest.clone()))
}

pub const GRACE: i64 = 3;
pub const FLOOR: usize = 16;

/// Culling (D14 step 4), after admission at `epoch`: k = 1 + below(3) of the
/// least weighted members at least three epochs old; ties to the older, then
/// the smaller digest; never below the floor.
pub fn cull(pop: &[Member], epoch: i64, g: &mut Prng) -> Vec<String> {
    let k = 1 + g.below(3) as usize;
    let room = pop.len().saturating_sub(FLOOR);
    let mut old: Vec<&Member> = pop.iter().filter(|m| epoch - m.born >= GRACE).collect();
    old.sort_by(|a, b| a.weight.cmp(&b.weight).then(a.born.cmp(&b.born)).then(a.digest.cmp(&b.digest)));
    old.iter().take(k.min(room)).map(|m| m.digest.clone()).collect()
}

/// The outcome of an epoch, as recorded on the chain and recomputed by `verify`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Epoch {
    pub parents: Option<(String, String)>,
    pub children: Vec<Child>,
    pub culled: Vec<String>,
}

/// Run an epoch (D14, D15) over `pop`, which already holds the members joining
/// at this epoch (game patterns and promoted crosses, born at `epoch`).
/// `patterns` maps digest → pattern for every member.
pub fn run_epoch(block_hash: &[u8], epoch: i64, pop: &[Member], patterns: &BTreeMap<String, Pattern>) -> Epoch {
    let seed = epoch_seed(block_hash, epoch as u64);
    let mut g0 = Prng::from_hash(&seed);
    let parents = select(pop, &mut g0);
    let mut children = vec![];
    if let Some((da, db)) = &parents {
        let mut g1 = Prng::from_hash(&brood_seed(&seed, da, db));
        let known: std::collections::BTreeSet<&String> = pop.iter().map(|m| &m.digest).collect();
        let mut seen = std::collections::BTreeSet::new();
        for c in brood(&patterns[da], &patterns[db], &mut g1).unwrap_or_default() {
            let d = c.pattern.digest();
            if !known.contains(&d) && seen.insert(d) {
                children.push(c);
            }
        }
    }
    let mut after: Vec<Member> = pop.to_vec();
    after.extend(children.iter().map(|c| Member { digest: c.pattern.digest(), shape: c.pattern.shape, born: epoch, weight: 1 }));
    let culled = cull(&after, epoch, &mut g0);
    Epoch { parents, children, culled }
}

/// A player's cross (D15): the four children of A and B under the cross seed.
pub fn cross_brood(block_hash: &[u8], crosser: &str, a: &Pattern, b: &Pattern) -> Option<Vec<Child>> {
    let seed = cross_seed(block_hash, crosser);
    let mut g = Prng::from_hash(&brood_seed(&seed, &a.digest(), &b.digest()));
    brood(a, b, &mut g)
}

/// Crossed children join the population once liked by someone other than the
/// crosser; engagement counts do not name addresses, so two likes stand for that.
pub const CROSS_LIKES: u64 = 2;

// ------------------------------------------------------------------ plays as the portal stores them

use f1r3games_core::Value;

/// The header's preview (as the client's `publish.js`): one byte per cell in
/// index order, 255 for nothing, otherwise an index into `notes`.
pub fn preview(p: &Pattern) -> Value {
    let mut notes: Vec<String> = vec![];
    let mut grid = String::new();
    for v in &p.cells {
        match v {
            None => grid.push_str("ff"),
            Some(n) => {
                let i = notes.iter().position(|x| x == n).unwrap_or_else(|| {
                    notes.push(n.clone());
                    notes.len() - 1
                });
                grid.push_str(&format!("{i:02x}"));
            }
        }
    }
    let s = p.shape;
    let count = p.cells.iter().flatten().count();
    Value::map([
        ("shape", Value::map([("n", Value::Int(s.n)), ("d", Value::Int(s.d)), ("bars", Value::Int(s.bars)), ("k", Value::Int(s.k))])),
        ("notes", Value::List(notes.into_iter().map(Value::String).collect())),
        ("grid", Value::str(grid)),
        ("text", Value::str(format!("{}/{} · {} bar{} · 1/{} · {} notes", s.n, s.d, s.bars, if s.bars > 1 { "s" } else { "" }, s.k, count))),
    ])
}

/// A bred pattern's header: origin "bred", its parents' play ids, the operator and the epoch's seed.
pub fn bred_header(p: &Pattern, title: &str, parents: [&str; 2], operator: &str, block_hex: &str, epoch: i64) -> Value {
    let s = p.shape;
    Value::map([
        ("title", Value::str(title)),
        ("digest", Value::str(p.digest())),
        ("meter", Value::List(vec![Value::Int(s.n), Value::Int(s.d)])),
        ("column", Value::Int(s.k)),
        ("bars", Value::Int(s.bars)),
        ("steps", Value::Int(s.steps())),
        ("tempo", Value::Int(100)),
        ("origin", Value::str("bred")),
        ("parents", Value::List(parents.iter().map(|x| Value::str(*x)).collect())),
        ("operator", Value::str(operator)),
        ("seed", Value::map([("block", Value::str(block_hex)), ("epoch", Value::Int(epoch))])),
        ("preview", preview(p)),
    ])
}

/// A population member's record, as the environment's `epoch` admits it.
pub fn member_record(p: &Pattern, play: &str, origin: &str, parents: &[String]) -> Value {
    let s = p.shape;
    Value::map([
        ("digest", Value::str(p.digest())),
        ("play", Value::str(play)),
        ("meter", Value::List(vec![Value::Int(s.n), Value::Int(s.d)])),
        ("column", Value::Int(s.k)),
        ("steps", Value::Int(s.steps())),
        ("bars", Value::Int(s.bars)),
        ("origin", Value::str(origin)),
        ("parents", Value::List(parents.iter().map(|x| Value::str(x.clone())).collect())),
    ])
}

/// Rebuild an epoch's population from its record's weights and the members'
/// own records (shape and birth), and run it again (§10.7).
pub fn verify_epoch(block_hash: &[u8], epoch: i64, weights: &BTreeMap<String, u64>, members: &BTreeMap<String, (Shape, i64)>, patterns: &BTreeMap<String, Pattern>) -> Result<Epoch, String> {
    let pop: Vec<Member> = weights
        .iter()
        .map(|(d, w)| members.get(d).map(|(s, born)| Member { digest: d.clone(), shape: *s, born: *born, weight: *w }).ok_or(format!("no member record for {d}")))
        .collect::<Result<_, _>>()?;
    for m in &pop {
        if !patterns.contains_key(&m.digest) {
            return Err(format!("no pattern for {}", m.digest));
        }
    }
    Ok(run_epoch(block_hash, epoch, &pop, patterns))
}
