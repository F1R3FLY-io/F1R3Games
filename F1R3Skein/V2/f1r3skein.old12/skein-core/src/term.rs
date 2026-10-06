//! Skein terms — representation version `skein/v0`.
//!
//! This module is the hand-written twin of `Skein.module`. Constructor names,
//! arities and argument names match the Theory deliberately, so that migration
//! to `skein/v1` is a re-parse and a re-target rather than a re-modelling.
//!
//! The central commitment: **a tune is a term, not a blob**. Leaves are spigot
//! addresses; internal nodes are the snip, twist, pad, crossover and mutation
//! operators; realisation is a rewrite. Lineage is therefore not stored beside
//! a tune, it *is* the tune's own syntax.
//!
//! Realisation produces `Material` — index pairs, the *material* of a tune.
//! Turning material into notes is the envelope's job (see `envelope.rs`). That
//! split is what makes breeding map-agnostic: crossing two tunes made in
//! different scales is an operation on material.

use serde::{Deserialize, Serialize};
use skein_spigot::{DigitCache, SpigotConfig};

// ------------------------------------------------------------------- the weave

/// The pair of ribbons. `Weave { pitch, duration }` after normalisation:
/// the first component governs pitch, the second duration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Skein {
    /// `Wv . l:Stream, r:Stream |- "<" l "," r ">" : Skein`
    Weave { left: SpigotConfig, right: SpigotConfig },
    /// `Twist . w:Skein |- "twist" "(" w ")" : Skein`
    Twist(Box<Skein>),
}

impl Skein {
    pub fn weave(left: SpigotConfig, right: SpigotConfig) -> Self {
        Skein::Weave { left, right }
    }

    pub fn twist(self) -> Self {
        Skein::Twist(Box::new(self))
    }

    /// Equation: `(Twist (Wv l r)) == (Wv r l)`.
    ///
    /// The involution `Twist(Twist w) == w` is a consequence rather than a
    /// separate equation, and is checked by test.
    pub fn normalise(&self) -> (SpigotConfig, SpigotConfig) {
        match self {
            Skein::Weave { left, right } => (*left, *right),
            Skein::Twist(inner) => {
                let (l, r) = inner.normalise();
                (r, l)
            }
        }
    }
}

// -------------------------------------------------------------------- the tune

/// A tune. Every constructor here has a counterpart in `Skein.module`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tune {
    /// `Rest` — the monoid unit. The *empty* tune, not a silent note.
    Rest,

    /// `Seq . ts:List(Tune)` — monoid multiplication. Associative, not
    /// commutative: a tune played forwards is not the tune played backwards.
    Seq(Vec<Tune>),

    /// `Snip . k:Skein, iL:Nat, iR:Nat, n:Nat`
    ///
    /// The leaf, and the whole reason the address property survives breeding.
    /// Two independent start positions because the two cursors are
    /// independent; one length because the notches mesh one-to-one.
    Snip {
        skein: Skein,
        i_l: usize,
        i_r: usize,
        n: usize,
    },

    /// `Pad . t:Tune, n:Nat` — append `n` silences. Length equalisation.
    Pad { tune: Box<Tune>, n: usize },

    /// `XPitch . m:Tune, f:Tune` — mother's pitches, father's durations.
    /// Forms a rectangular band (see tests).
    XPitch { m: Box<Tune>, f: Box<Tune> },

    /// `XFold . a:Tune, b:Tune, seed:Nat` — pitch against pitch, folded to a
    /// duration. Stochastic in the original; the seed makes it a function of
    /// its arguments again, without which a term would not faithfully describe
    /// its own realisation.
    XFold { a: Box<Tune>, b: Box<Tune>, seed: u64 },

    /// `XLift . a:Tune, b:Tune, seed:Nat` — duration against duration, lifted
    /// to a pitch.
    XLift { a: Box<Tune>, b: Box<Tune>, seed: u64 },

    /// `Mutate . t:Tune, seed:Nat`
    Mutate { tune: Box<Tune>, seed: u64 },
}

impl Tune {
    pub fn snip(skein: Skein, i_l: usize, i_r: usize, n: usize) -> Self {
        Tune::Snip { skein, i_l, i_r, n }
    }

    pub fn seq(parts: Vec<Tune>) -> Self {
        Tune::Seq(parts)
    }

    pub fn x_pitch(m: Tune, f: Tune) -> Self {
        Tune::XPitch {
            m: Box::new(m),
            f: Box::new(f),
        }
    }

    /// `XDur` needs no constructor: the child taking the father's pitches and
    /// the mother's durations is `XPitch(f, m)`. This halves the constructor
    /// count and removes a class of duplicate gallery entries by
    /// normalisation rather than deduplication.
    pub fn x_dur(m: Tune, f: Tune) -> Self {
        Tune::x_pitch(f, m)
    }

    /// Structural normalisation, implementing the equations of the Theory:
    ///
    /// * `(Snip k iL iR NZero) == (Rest)`
    /// * `Seq` associativity and unit (flattening, dropping `Rest`)
    /// * `(XPitch t t) == t`
    /// * `(XPitch (XPitch a b) c) == (XPitch a c)`
    /// * `(XPitch a (XPitch b c)) == (XPitch a c)`
    /// * `(Pad t NZero) == t`
    pub fn normalise(&self) -> Tune {
        match self {
            Tune::Rest => Tune::Rest,

            Tune::Snip { n: 0, .. } => Tune::Rest,
            Tune::Snip { skein, i_l, i_r, n } => {
                let (l, r) = skein.normalise();
                Tune::Snip {
                    skein: Skein::weave(l, r),
                    i_l: *i_l,
                    i_r: *i_r,
                    n: *n,
                }
            }

            Tune::Seq(parts) => {
                let mut flat = Vec::new();
                for p in parts {
                    match p.normalise() {
                        Tune::Rest => {}
                        Tune::Seq(inner) => flat.extend(inner),
                        other => flat.push(other),
                    }
                }
                match flat.len() {
                    0 => Tune::Rest,
                    1 => flat.pop().unwrap(),
                    _ => Tune::Seq(flat),
                }
            }

            Tune::Pad { tune, n: 0 } => tune.normalise(),
            Tune::Pad { tune, n } => Tune::Pad {
                tune: Box::new(tune.normalise()),
                n: *n,
            },

            Tune::XPitch { m, f } => {
                let mn = m.normalise();
                let fnorm = f.normalise();
                // Rectangular band: idempotent, associative, absorbing.
                let left = match &mn {
                    Tune::XPitch { m: inner_m, .. } => (**inner_m).clone(),
                    _ => mn.clone(),
                };
                let right = match &fnorm {
                    Tune::XPitch { f: inner_f, .. } => (**inner_f).clone(),
                    _ => fnorm.clone(),
                };
                if left == right {
                    return left;
                }
                Tune::XPitch {
                    m: Box::new(left),
                    f: Box::new(right),
                }
            }

            Tune::XFold { a, b, seed } => Tune::XFold {
                a: Box::new(a.normalise()),
                b: Box::new(b.normalise()),
                seed: *seed,
            },
            Tune::XLift { a, b, seed } => Tune::XLift {
                a: Box::new(a.normalise()),
                b: Box::new(b.normalise()),
                seed: *seed,
            },
            Tune::Mutate { tune, seed } => Tune::Mutate {
                tune: Box::new(tune.normalise()),
                seed: *seed,
            },
        }
    }

    /// Every spigot address appearing as a leaf. Lineage is readable off the
    /// syntax; this is the accessor for it.
    pub fn leaves(&self) -> Vec<(&Skein, usize, usize, usize)> {
        let mut out = Vec::new();
        self.collect_leaves(&mut out);
        out
    }

    fn collect_leaves<'a>(&'a self, out: &mut Vec<(&'a Skein, usize, usize, usize)>) {
        match self {
            Tune::Rest => {}
            Tune::Snip { skein, i_l, i_r, n } => out.push((skein, *i_l, *i_r, *n)),
            Tune::Seq(ps) => ps.iter().for_each(|p| p.collect_leaves(out)),
            Tune::Pad { tune, .. } | Tune::Mutate { tune, .. } => tune.collect_leaves(out),
            Tune::XPitch { m, f } => {
                m.collect_leaves(out);
                f.collect_leaves(out);
            }
            Tune::XFold { a, b, .. } | Tune::XLift { a, b, .. } => {
                a.collect_leaves(out);
                b.collect_leaves(out);
            }
        }
    }
}

// ---------------------------------------------------------------- the material

/// One position in a realised tune.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Cell {
    /// A sounded note: an index into the pitch vocabulary and one into the
    /// duration vocabulary.
    Sound { p: u8, d: u8 },
    /// A silence of the given duration index.
    Silence { d: u8 },
}

/// The realisation of a term: index pairs plus the vocabularies they index.
///
/// This is *material*. It carries no scale, no root, no tempo and no
/// instrument — those live in the envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Material {
    pub pitch_base: u32,
    pub dur_base: u32,
    pub cells: Vec<Cell>,
}

impl Material {
    pub fn empty(pitch_base: u32, dur_base: u32) -> Self {
        Material {
            pitch_base,
            dur_base,
            cells: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
}

/// splitmix64 — a deterministic, seedable generator. Stochastic operators are
/// functions of their seed, so a term describes its own realisation exactly.
fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn pitch_of(c: Cell) -> Option<u8> {
    match c {
        Cell::Sound { p, .. } => Some(p),
        Cell::Silence { .. } => None,
    }
}

fn dur_of(c: Cell) -> u8 {
    match c {
        Cell::Sound { d, .. } | Cell::Silence { d } => d,
    }
}

/// Realise a term to material. This is the rewrite the specification prices:
/// emitting the n-th digit costs, so deep addresses cost more than shallow
/// ones, which gives the evolutionary economy a real resource floor.
pub fn realise(tune: &Tune, cache: &mut DigitCache) -> Material {
    match tune {
        Tune::Rest => Material::empty(0, 0),

        Tune::Snip { skein, i_l, i_r, n } => {
            let (pitch_cfg, dur_cfg) = skein.normalise();
            let ps = cache.range(pitch_cfg, *i_l, *n);
            let ds = cache.range(dur_cfg, *i_r, *n);
            Material {
                pitch_base: pitch_cfg.base,
                dur_base: dur_cfg.base,
                cells: ps
                    .into_iter()
                    .zip(ds)
                    .map(|(p, d)| Cell::Sound { p, d })
                    .collect(),
            }
        }

        Tune::Seq(parts) => {
            let mut out: Option<Material> = None;
            for p in parts {
                let m = realise(p, cache);
                if m.is_empty() && m.pitch_base == 0 {
                    continue;
                }
                match &mut out {
                    None => out = Some(m),
                    Some(acc) => acc.cells.extend(m.cells),
                }
            }
            out.unwrap_or_else(|| Material::empty(0, 0))
        }

        Tune::Pad { tune, n } => {
            let mut m = realise(tune, cache);
            for _ in 0..*n {
                m.cells.push(Cell::Silence { d: 0 });
            }
            m
        }

        // Mother's pitches, father's durations. Zips to the shorter of the
        // two; the band laws of the Theory hold on equal lengths, which is
        // what `Pad` is for.
        Tune::XPitch { m, f } => {
            let ma = realise(m, cache);
            let fa = realise(f, cache);
            let len = ma.len().min(fa.len());
            Material {
                pitch_base: ma.pitch_base,
                dur_base: fa.dur_base,
                cells: (0..len)
                    .map(|i| match pitch_of(ma.cells[i]) {
                        Some(p) => Cell::Sound {
                            p,
                            d: dur_of(fa.cells[i]),
                        },
                        None => Cell::Silence {
                            d: dur_of(fa.cells[i]),
                        },
                    })
                    .collect(),
            }
        }

        Tune::XFold { a, b, seed } => {
            let aa = realise(a, cache);
            let bb = realise(b, cache);
            let len = aa.len().min(bb.len());
            let mut st = *seed;
            let dur_base = aa.dur_base.max(1);
            Material {
                pitch_base: aa.pitch_base,
                dur_base: aa.dur_base,
                cells: (0..len)
                    .map(|i| {
                        let flip = splitmix(&mut st) & 1 == 1;
                        let pa = pitch_of(aa.cells[i]);
                        let pb = pitch_of(bb.cells[i]);
                        match (pa, pb) {
                            (Some(x), Some(y)) => Cell::Sound {
                                p: if flip { x } else { y },
                                d: ((x as u32 + y as u32) % dur_base) as u8,
                            },
                            _ => Cell::Silence { d: 0 },
                        }
                    })
                    .collect(),
            }
        }

        Tune::XLift { a, b, seed } => {
            let aa = realise(a, cache);
            let bb = realise(b, cache);
            let len = aa.len().min(bb.len());
            let mut st = *seed;
            let pitch_base = aa.pitch_base.max(1);
            Material {
                pitch_base: aa.pitch_base,
                dur_base: aa.dur_base,
                cells: (0..len)
                    .map(|i| {
                        let flip = splitmix(&mut st) & 1 == 1;
                        let da = dur_of(aa.cells[i]);
                        let db = dur_of(bb.cells[i]);
                        Cell::Sound {
                            p: ((da as u32 + db as u32) % pitch_base) as u8,
                            d: if flip { da } else { db },
                        }
                    })
                    .collect(),
            }
        }

        Tune::Mutate { tune, seed } => {
            let mut m = realise(tune, cache);
            let mut st = *seed;
            let pb = m.pitch_base.max(1);
            for cell in m.cells.iter_mut() {
                // One position in eight is nudged by one scale degree.
                if splitmix(&mut st) % 8 == 0 {
                    if let Cell::Sound { p, d } = *cell {
                        let up = splitmix(&mut st) & 1 == 1;
                        let np = if up {
                            (p as u32 + 1) % pb
                        } else {
                            (p as u32 + pb - 1) % pb
                        };
                        *cell = Cell::Sound { p: np as u8, d };
                    }
                }
            }
            m
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skein_spigot::Constant;

    fn cfg(c: Constant, b: u32) -> SpigotConfig {
        SpigotConfig::new(c, b).unwrap()
    }

    fn sk() -> Skein {
        Skein::weave(cfg(Constant::Pi, 22), cfg(Constant::E, 5))
    }

    #[test]
    fn twist_is_an_involution() {
        let w = sk();
        assert_eq!(w.clone().twist().twist().normalise(), w.normalise());
    }

    #[test]
    fn twist_swaps_the_roles() {
        let (l, r) = sk().normalise();
        let (tl, tr) = sk().twist().normalise();
        assert_eq!((tl, tr), (r, l));
    }

    #[test]
    fn empty_snip_is_rest() {
        let t = Tune::snip(sk(), 10, 4, 0);
        assert_eq!(t.normalise(), Tune::Rest);
    }

    #[test]
    fn seq_has_unit_and_flattens() {
        let a = Tune::snip(sk(), 0, 0, 4);
        let inner = Tune::seq(vec![a.clone(), Tune::Rest]);
        let outer = Tune::seq(vec![Tune::Rest, inner, Tune::Rest]);
        assert_eq!(outer.normalise(), a.normalise());
    }

    #[test]
    fn xpitch_is_idempotent() {
        let a = Tune::snip(sk(), 3, 7, 6);
        assert_eq!(Tune::x_pitch(a.clone(), a.clone()).normalise(), a.normalise());
    }

    #[test]
    fn xpitch_is_a_rectangular_band() {
        let a = Tune::snip(sk(), 0, 0, 6);
        let b = Tune::snip(sk(), 10, 10, 6);
        let c = Tune::snip(sk(), 20, 20, 6);
        let left = Tune::x_pitch(Tune::x_pitch(a.clone(), b.clone()), c.clone()).normalise();
        let right = Tune::x_pitch(a.clone(), Tune::x_pitch(b.clone(), c.clone())).normalise();
        let direct = Tune::x_pitch(a, c).normalise();
        assert_eq!(left, direct, "(a><b)><c == a><c");
        assert_eq!(right, direct, "a><(b><c) == a><c");
    }

    #[test]
    fn band_laws_hold_on_realisation_too() {
        let mut cache = DigitCache::new();
        let a = Tune::snip(sk(), 0, 0, 6);
        let b = Tune::snip(sk(), 10, 10, 6);
        let c = Tune::snip(sk(), 20, 20, 6);
        let lhs = realise(
            &Tune::x_pitch(Tune::x_pitch(a.clone(), b.clone()), c.clone()),
            &mut cache,
        );
        let rhs = realise(&Tune::x_pitch(a, c), &mut cache);
        assert_eq!(lhs, rhs);
    }

    #[test]
    fn xdur_needs_no_constructor() {
        let m = Tune::snip(sk(), 0, 0, 4);
        let f = Tune::snip(sk(), 8, 8, 4);
        let mut cache = DigitCache::new();
        let via_dual = realise(&Tune::x_dur(m.clone(), f.clone()), &mut cache);
        let direct = realise(&Tune::x_pitch(f, m), &mut cache);
        assert_eq!(via_dual, direct);
    }

    #[test]
    fn snip_reads_independent_cursors() {
        // The defect this representation exists to fix: the two cursors are
        // independent, so a snip must carry a start for each side.
        let mut cache = DigitCache::new();
        let t = Tune::snip(sk(), 100, 3, 5);
        let m = realise(&t, &mut cache);
        let pitches = cache.range(cfg(Constant::Pi, 22), 100, 5);
        let durs = cache.range(cfg(Constant::E, 5), 3, 5);
        for (i, cell) in m.cells.iter().enumerate() {
            assert_eq!(*cell, Cell::Sound { p: pitches[i], d: durs[i] });
        }
    }

    #[test]
    fn stochastic_operators_are_reproducible() {
        let mut c1 = DigitCache::new();
        let mut c2 = DigitCache::new();
        let a = Tune::snip(sk(), 0, 0, 8);
        let b = Tune::snip(sk(), 40, 40, 8);
        let t = Tune::XFold {
            a: Box::new(a),
            b: Box::new(b),
            seed: 0xDEADBEEF,
        };
        assert_eq!(realise(&t, &mut c1), realise(&t, &mut c2));
    }

    #[test]
    fn lineage_is_the_syntax() {
        let a = Tune::snip(sk(), 0, 0, 4);
        let b = Tune::snip(sk(), 9, 9, 4);
        let child = Tune::x_pitch(a, b);
        let leaves = child.leaves();
        assert_eq!(leaves.len(), 2, "both parents readable off the term");
        assert_eq!((leaves[0].1, leaves[1].1), (0, 9));
    }

    #[test]
    fn round_trips_through_json() {
        let t = Tune::snip(sk().twist(), 5, 6, 7);
        let s = serde_json::to_string(&t).unwrap();
        let back: Tune = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
    }
}
