// Reproduction (design §10, D12–D15): the generator, refilling, the two
// operators, the brood, selection and culling. Mirrors crates/games/src/beat.rs
// draw for draw; both are held to vectors/beat-vectors.json.
import { blake2b } from "@noble/hashes/blake2b";
import { cellIndex, species } from "./grid.js";
import { digest, rowOfPattern, silent } from "./score.js";

const M64 = (1n << 64n) - 1n;
const rotl = (x, k) => ((x << BigInt(k)) | (x >> BigInt(64 - k))) & M64;
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...as) => { const o = new Uint8Array(as.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of as) { o.set(a, i); i += a.length; } return o; };
const fromHex = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const b2b = (b) => blake2b(b, { dkLen: 32 });

/** xoshiro256** seeded through SplitMix64, as F1R3Score's `score-chance` Prng. */
export class Prng {
  constructor(seed /* BigInt */) {
    let x = BigInt.asUintN(64, seed);
    const sm = () => {
      x = (x + 0x9E3779B97F4A7C15n) & M64;
      let z = x;
      z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
      z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
      return z ^ (z >> 31n);
    };
    this.s = [sm(), sm(), sm(), sm()];
  }
  static fromHash(h) { let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(h[i]); return new Prng(x); }
  nextU64() {
    const s = this.s;
    const r = (rotl((s[1] * 5n) & M64, 7) * 9n) & M64;
    const t = (s[1] << 17n) & M64;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 45);
    return r;
  }
  /** Uniform in 0..n by rejection, as `score-chance`'s `below`. */
  below(n) {
    const N = BigInt(n);
    if (N <= 0n) throw new RangeError("below(0)");
    const zone = M64 - (M64 % N);
    for (;;) { const x = this.nextU64(); if (x < zone) return Number(x % N); }
  }
  /** j of 0..m: the first j entries of a forward Fisher–Yates shuffle, sorted. */
  choose(j, m) {
    const a = Array.from({ length: m }, (_, i) => i);
    const k = Math.min(j, m);
    for (let i = 0; i < k; i++) { const r = i + this.below(m - i); [a[i], a[r]] = [a[r], a[i]]; }
    return a.slice(0, k).sort((x, y) => x - y);
  }
}

export function epochSeed(blockHashHex, epoch) {
  const e = new Uint8Array(8);
  let x = BigInt(epoch);
  for (let i = 7; i >= 0; i--) { e[i] = Number(x & 255n); x >>= 8n; }
  return b2b(concat(utf8("f1r3beat/breed/v1"), fromHex(blockHashHex), e));
}
export const crossSeed = (blockHashHex, crosser) => b2b(concat(utf8("f1r3beat/cross/v1"), fromHex(blockHashHex), utf8(crosser)));
export const broodSeed = (seed, a, b) => b2b(concat(seed, fromHex(a), fromHex(b)));

/** Refill: the slots of a rhythm take a melody; surplus pitches drop, missing ones become rests. */
export function refill(slots, melody, g) {
  const n = slots.length, k = melody.length;
  if (k >= n) {
    const drop = new Set(g.choose(k - n, k));
    const kept = melody.filter((_, i) => !drop.has(i));
    return slots.map((s, i) => [s, kept[i]]);
  }
  const quiet = new Set(g.choose(n - k, n));
  const live = slots.filter((_, i) => !quiet.has(i));
  return live.map((s, i) => [s, melody[i]]);
}

/** X(A, B): A's rhythm with B's melody, row by row. */
export function cross(a, b, g) {
  const out = silent(a.shape);
  for (let row = 0; row < 5; row++) {
    const slots = rowOfPattern(a, row).flatMap((v, t) => (v ? [t] : []));
    const melody = rowOfPattern(b, row).filter(Boolean);
    for (const [t, p] of refill(slots, melody, g)) out.cells[cellIndex(t, row)] = p;
  }
  return out;
}

/** V(A, B; c): row ρ from B when bit ρ of c is set, drums the most significant. */
export function voices(a, b, c) {
  const out = { shape: a.shape, cells: [...a.cells] };
  for (let row = 0; row < 5; row++) if ((c >> (4 - row)) & 1) for (let t = 0; t < a.shape.steps; t++) out.cells[cellIndex(t, row)] = b.cells[cellIndex(t, row)];
  return out;
}

/** Pad with `extra` silent bars, each inserted at a boundary drawn from g. */
export function pad(p, extra, g) {
  const w = 5 * p.shape.perBar;
  const bars = Array.from({ length: p.shape.bars }, (_, b) => p.cells.slice(w * b, w * (b + 1)));
  for (let i = 0; i < extra; i++) bars.splice(g.below(bars.length + 1), 0, Array(w).fill(null));
  const bs = p.shape.bars + extra;
  return { shape: { ...p.shape, bars: bs, steps: bs * p.shape.perBar, cells: 5 * bs * p.shape.perBar }, cells: bars.flat() };
}

/** The brood (D12): X(A,B), X(B,A), V(A,B;c), V(B,A;c). Draws: padding, c, X(A,B), X(B,A). */
export function brood(a, b, g) {
  if (species(a.shape) !== species(b.shape)) return null;
  const da = digest(a), db = digest(b);
  let pa = a, pb = b;
  if (pa.shape.bars < pb.shape.bars) pa = pad(pa, pb.shape.bars - pa.shape.bars, g);
  else if (pb.shape.bars < pa.shape.bars) pb = pad(pb, pa.shape.bars - pb.shape.bars, g);
  const c = g.below(30) + 1;
  const xab = cross(a, b, g);
  const xba = cross(b, a, g);
  return [
    { pattern: xab, operator: "X", parents: [da, db] },
    { pattern: xba, operator: "X", parents: [db, da] },
    { pattern: voices(pa, pb, c), operator: "V", parents: [da, db] },
    { pattern: voices(pb, pa, c), operator: "V", parents: [db, da] },
  ];
}

export const weight = (plays = 0, likes = 0) => 1 + plays + 3 * likes;

function draw(ms, g) {
  let x = g.below(ms.reduce((n, m) => n + m.weight, 0));
  for (let i = 0; i < ms.length; i++) { if (x < ms[i].weight) return i; x -= ms[i].weight; }
  return ms.length - 1;
}

/** Selection (D14): members {digest, shape, born, weight}, sorted by digest. */
export function select(pop, g) {
  const sorted = [...pop].sort((a, b) => (a.digest < b.digest ? -1 : 1));
  if (!sorted.length) return null;
  const count = (m) => sorted.filter((x) => species(x.shape) === species(m.shape)).length;
  let a = sorted[draw(sorted, g)];
  if (count(a) < 2) {
    const eligible = sorted.filter((m) => count(m) >= 2);
    if (!eligible.length) return null;
    a = eligible[draw(eligible, g)];
  }
  const mates = sorted.filter((m) => species(m.shape) === species(a.shape) && m.digest !== a.digest);
  return [a.digest, mates[draw(mates, g)].digest];
}

export const GRACE = 3, FLOOR = 16, CROSS_LIKES = 2;

export function cull(pop, epoch, g) {
  const k = 1 + g.below(3);
  const room = Math.max(0, pop.length - FLOOR);
  const old = pop.filter((m) => epoch - m.born >= GRACE)
    .sort((a, b) => a.weight - b.weight || a.born - b.born || (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  return old.slice(0, Math.min(k, room)).map((m) => m.digest);
}

/** An epoch: selection, the brood (deduplicated), then culling. `patterns` maps digest → pattern. */
export function runEpoch(blockHashHex, epoch, pop, patterns) {
  const seed = epochSeed(blockHashHex, epoch);
  const g0 = Prng.fromHash(seed);
  const parents = select(pop, g0);
  const children = [];
  if (parents) {
    const g1 = Prng.fromHash(broodSeed(seed, parents[0], parents[1]));
    const known = new Set(pop.map((m) => m.digest)), seen = new Set();
    for (const c of brood(patterns.get(parents[0]), patterns.get(parents[1]), g1) ?? []) {
      const d = digest(c.pattern);
      if (!known.has(d) && !seen.has(d)) { seen.add(d); children.push(c); }
    }
  }
  const after = [...pop, ...children.map((c) => ({ digest: digest(c.pattern), shape: c.pattern.shape, born: epoch, weight: 1 }))];
  return { parents, children, culled: cull(after, epoch, g0) };
}

/** A player's cross (D15). */
export function crossBrood(blockHashHex, crosser, a, b) {
  const g = Prng.fromHash(broodSeed(crossSeed(blockHashHex, crosser), digest(a), digest(b)));
  return brood(a, b, g);
}
