//! Digit streams for the five constants named in the specification.
//!
//! Every stream is the base-`b` expansion of the **fractional part** of its
//! constant, indexed from zero. Uniform treatment avoids a special case for
//! constants below one:
//!
//! | constant   | value       | base-10 digits from index 0 |
//! |------------|-------------|------------------------------|
//! | pi         | 3.14159...  | 1 4 1 5 9 2 6 5 3 5 ...      |
//! | e          | 2.71828...  | 7 1 8 2 8 1 8 2 8 4 ...      |
//! | phi        | 1.61803...  | 6 1 8 0 3 3 9 8 8 7 ...      |
//! | ln2        | 0.69314...  | 6 9 3 1 4 7 1 8 0 5 ...      |
//! | liouville  | 0.11000...  | 1 1 0 0 0 1 0 0 ...          |
//!
//! Spec conformance:
//!
//! * emission is exact and unbounded — every value is computed with
//!   arbitrary-precision integers and the working precision extends on demand;
//! * digits are memoised, so re-realising a visited range is O(1) per digit,
//!   which the spec requires because deep cursor positions are exactly what a
//!   long session produces.
//!
//! Digits are produced in blocks. A block computes `floor(frac(x) * b^k)` for
//! `k = requested + GUARD` and keeps the leading `requested` digits, so the
//! trailing digits — the only ones that can be wrong — are discarded.

use num_bigint::BigUint;
use num_integer::Integer;
use num_traits::{One, Zero};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Digits computed beyond those retained, to absorb truncation error.
const GUARD: usize = 24;
/// Minimum block size; growth is geometric above this.
const MIN_BLOCK: usize = 64;

/// The five constants of the specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Constant {
    Pi,
    E,
    Phi,
    Ln2,
    Liouville,
}

impl Constant {
    pub fn name(&self) -> &'static str {
        match self {
            Constant::Pi => "pi",
            Constant::E => "e",
            Constant::Phi => "phi",
            Constant::Ln2 => "ln2",
            Constant::Liouville => "liouville",
        }
    }

    pub fn all() -> [Constant; 5] {
        [
            Constant::Pi,
            Constant::E,
            Constant::Phi,
            Constant::Ln2,
            Constant::Liouville,
        ]
    }
}

/// A stream configuration: a constant and an output base.
///
/// The spec requires `2 <= base <= 36`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SpigotConfig {
    pub constant: Constant,
    pub base: u32,
}

impl SpigotConfig {
    pub fn new(constant: Constant, base: u32) -> Result<Self, String> {
        if !(2..=36).contains(&base) {
            return Err(format!("base {base} out of range 2..=36"));
        }
        Ok(SpigotConfig { constant, base })
    }

    pub fn label(&self) -> String {
        format!("{} base {}", self.constant.name(), self.base)
    }
}

// ---------------------------------------------------------------- computation

/// `floor(frac(x) * base^k)` as a big unsigned integer, for each constant.
fn scaled_fraction(c: Constant, base: u32, k: usize) -> BigUint {
    let b = BigUint::from(base);
    let scale = b.pow(k as u32);
    match c {
        // pi/4 = 4*atan(1/5) - atan(1/239)   (Machin)
        Constant::Pi => {
            let pi = (atan_inv(5u32, &scale) * BigUint::from(16u32))
                - (atan_inv(239u32, &scale) * BigUint::from(4u32));
            // frac(pi) = pi - 3
            pi - BigUint::from(3u32) * &scale
        }
        // e = sum 1/n!  ; frac(e) = e - 2
        Constant::E => {
            let mut term = scale.clone();
            let mut sum = BigUint::zero();
            let mut n = 1u32;
            while !term.is_zero() {
                term /= BigUint::from(n);
                sum += &term;
                n += 1;
            }
            // sum here is 1/1! + 1/2! + ... = e - 1, so frac = sum - 1
            sum - &scale
        }
        // phi = (1 + sqrt 5)/2 ; frac(phi) = phi - 1 = (sqrt 5 - 1)/2
        Constant::Phi => {
            let five = BigUint::from(5u32) * &scale * &scale;
            let root = isqrt(&five); // floor(sqrt(5) * base^k)
            (root - &scale) / BigUint::from(2u32)
        }
        // ln2 = 2 * atanh(1/3) = 2 * sum_{j odd} 1/(j * 3^j)
        Constant::Ln2 => atanh_inv(3u32, &scale) * BigUint::from(2u32),
        // sum_{n>=1} base^{-n!}
        Constant::Liouville => {
            let mut sum = BigUint::zero();
            let mut fact: usize = 1;
            let mut n: usize = 1;
            while fact <= k {
                sum += b.pow((k - fact) as u32);
                n += 1;
                match fact.checked_mul(n) {
                    Some(f) => fact = f,
                    None => break,
                }
            }
            sum
        }
    }
}

/// `floor(atan(1/x) * scale)` by the alternating series.
fn atan_inv(x: u32, scale: &BigUint) -> BigUint {
    let x2 = BigUint::from(x) * BigUint::from(x);
    let mut power = scale / BigUint::from(x); // scale / x^(2j+1)
    let mut sum = power.clone();
    let mut j = 1u32;
    loop {
        power /= &x2;
        if power.is_zero() {
            break;
        }
        let term = &power / BigUint::from(2 * j + 1);
        if j % 2 == 1 {
            if term > sum {
                break;
            }
            sum -= term;
        } else {
            sum += term;
        }
        j += 1;
    }
    sum
}

/// `floor(atanh(1/x) * scale)` = sum over odd j of 1/(j x^j), scaled.
fn atanh_inv(x: u32, scale: &BigUint) -> BigUint {
    let x2 = BigUint::from(x) * BigUint::from(x);
    let mut power = scale / BigUint::from(x);
    let mut sum = power.clone();
    let mut j = 1u32;
    loop {
        power /= &x2;
        if power.is_zero() {
            break;
        }
        sum += &power / BigUint::from(2 * j + 1);
        j += 1;
    }
    sum
}

/// Integer square root by Newton's method.
fn isqrt(n: &BigUint) -> BigUint {
    if n.is_zero() {
        return BigUint::zero();
    }
    let bits = n.bits();
    let mut x = BigUint::one() << ((bits + 1) / 2);
    loop {
        let y = (&x + n / &x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

// -------------------------------------------------------------------- streams

/// A memoised digit stream for one configuration.
#[derive(Debug, Clone)]
pub struct DigitStream {
    config: SpigotConfig,
    digits: Vec<u8>,
}

impl DigitStream {
    pub fn new(config: SpigotConfig) -> Self {
        DigitStream {
            config,
            digits: Vec::new(),
        }
    }

    pub fn config(&self) -> SpigotConfig {
        self.config
    }

    /// Number of digits currently memoised.
    pub fn cached(&self) -> usize {
        self.digits.len()
    }

    /// The digit at `index`, computing a block if needed.
    pub fn digit(&mut self, index: usize) -> u8 {
        if index >= self.digits.len() {
            let want = (index + 1).max(MIN_BLOCK).max(self.digits.len() * 2);
            self.extend_to(want);
        }
        self.digits[index]
    }

    /// The half-open range `[from, from + n)`.
    pub fn range(&mut self, from: usize, n: usize) -> Vec<u8> {
        if n == 0 {
            return Vec::new();
        }
        let end = from + n;
        if end > self.digits.len() {
            let want = end.max(MIN_BLOCK).max(self.digits.len() * 2);
            self.extend_to(want);
        }
        self.digits[from..end].to_vec()
    }

    fn extend_to(&mut self, count: usize) {
        let k = count + GUARD;
        let scaled = scaled_fraction(self.config.constant, self.config.base, k);
        let b = BigUint::from(self.config.base);
        // Most significant first: repeatedly divide out the top power.
        let mut out = vec![0u8; k];
        let mut rem = scaled;
        for slot in (0..k).rev() {
            let (q, r) = rem.div_rem(&b);
            out[slot] = r
                .try_into()
                .expect("remainder below base fits in u8");
            rem = q;
        }
        out.truncate(count);
        self.digits = out;
    }
}

/// A pair of memoised streams. Realisation reads through this.
#[derive(Debug, Clone, Default)]
pub struct DigitCache {
    streams: HashMap<SpigotConfig, DigitStream>,
}

impl DigitCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn digit(&mut self, cfg: SpigotConfig, index: usize) -> u8 {
        self.stream(cfg).digit(index)
    }

    pub fn range(&mut self, cfg: SpigotConfig, from: usize, n: usize) -> Vec<u8> {
        self.stream(cfg).range(from, n)
    }

    fn stream(&mut self, cfg: SpigotConfig) -> &mut DigitStream {
        self.streams
            .entry(cfg)
            .or_insert_with(|| DigitStream::new(cfg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digits(c: Constant, base: u32, n: usize) -> Vec<u8> {
        let mut s = DigitStream::new(SpigotConfig::new(c, base).unwrap());
        s.range(0, n)
    }

    #[test]
    fn pi_base_ten() {
        // frac(pi) = .14159265358979323846
        assert_eq!(
            digits(Constant::Pi, 10, 20),
            vec![1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6]
        );
    }

    #[test]
    fn e_base_ten() {
        // frac(e) = .718281828459045
        assert_eq!(
            digits(Constant::E, 10, 15),
            vec![7, 1, 8, 2, 8, 1, 8, 2, 8, 4, 5, 9, 0, 4, 5]
        );
    }

    #[test]
    fn phi_base_ten() {
        // frac(phi) = .6180339887498948
        assert_eq!(
            digits(Constant::Phi, 10, 16),
            vec![6, 1, 8, 0, 3, 3, 9, 8, 8, 7, 4, 9, 8, 9, 4, 8]
        );
    }

    #[test]
    fn ln2_base_ten() {
        // frac(ln 2) = .6931471805599453
        assert_eq!(
            digits(Constant::Ln2, 10, 16),
            vec![6, 9, 3, 1, 4, 7, 1, 8, 0, 5, 5, 9, 9, 4, 5, 3]
        );
    }

    #[test]
    fn liouville_has_ones_at_factorials() {
        let d = digits(Constant::Liouville, 10, 30);
        // 1-indexed positions 1,2,6,24 are factorials.
        for (i, v) in d.iter().enumerate() {
            let pos = i + 1;
            let is_fact = [1usize, 2, 6, 24].contains(&pos);
            assert_eq!(*v, if is_fact { 1 } else { 0 }, "position {pos}");
        }
    }

    #[test]
    fn other_bases_are_consistent() {
        // Reading pi in base 2 twice must agree, and blocks must join cleanly.
        let cfg = SpigotConfig::new(Constant::Pi, 2).unwrap();
        let mut a = DigitStream::new(cfg);
        let long = a.range(0, 300);
        let mut b = DigitStream::new(cfg);
        let mut joined = Vec::new();
        for i in 0..300 {
            joined.push(b.digit(i));
        }
        assert_eq!(long, joined);
        assert!(long.iter().all(|d| *d < 2));
    }

    #[test]
    fn deep_positions_are_stable() {
        let cfg = SpigotConfig::new(Constant::Pi, 10).unwrap();
        let mut s = DigitStream::new(cfg);
        let deep = s.range(1000, 10);
        let mut t = DigitStream::new(cfg);
        assert_eq!(t.range(1000, 10), deep);
    }

    #[test]
    fn base_is_validated() {
        assert!(SpigotConfig::new(Constant::Pi, 1).is_err());
        assert!(SpigotConfig::new(Constant::Pi, 37).is_err());
        assert!(SpigotConfig::new(Constant::Pi, 36).is_ok());
    }
}
