// History order (as F1R3Pix §5.5) and the play bodies (design §9): a session
// is the history of a span, encoded "F1BT"; a pattern is its canonical score
// with credits, in canonical CBOR. Mirrors crates/games/src/beat.rs.
import { KIT, midiName, midiOf, rowOf, shapeOf } from "./grid.js";
import { encodeCbor, decodeCbor } from "./cbor.js";
import { parseScore, score } from "./score.js";

/** `log` entries [h, ts, owner, c, note] (a missing note is Nil, dropped by the node's JSON). */
export function orderSets(entries) {
  return entries
    .map((e, i) => ({ h: e[0], ts: e[1], owner: e[2], cell: e[3], note: e.length > 4 ? e[4] ?? null : null, i }))
    .sort((a, b) => a.h - b.h || a.ts - b.ts || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.i - b.i)
    .map(({ i, ...s }) => s);
}

/** Cell notes after applying ordered `sets` up to and including height `upTo`, over `base` (seeded cells). */
export function gridAt(sets, upTo = Infinity, base = new Map()) {
  const m = new Map(base);
  for (const s of sets) { if (s.h > upTo) break; m.set(s.cell, s.note); }
  return m;
}

export const frames = (sets) => [...new Set(sets.map((s) => s.h))];

class Writer {
  constructor() { this.b = []; }
  u8(x) { this.b.push(x & 255); }
  u16(x) { this.u8(x >> 8); this.u8(x); }
  u32(x) { this.u16(Math.floor(x / 65536)); this.u16(x % 65536); }
  varint(x) { if (!Number.isSafeInteger(x) || x < 0) throw new RangeError("varint"); do { let y = x % 128; x = Math.floor(x / 128); if (x > 0) y |= 128; this.u8(y); } while (x > 0); }
  bytes(a) { for (const x of a) this.u8(x); }
  done() { return Uint8Array.from(this.b); }
}
class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  u8() { if (this.i >= this.b.length) throw new Error("truncated"); return this.b[this.i++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return this.u16() * 65536 + this.u16(); }
  varint() { let x = 0, m = 1, y; do { y = this.u8(); x += (y & 127) * m; m *= 128; } while (y & 128); return x; }
  bytes(n) { const o = this.b.slice(this.i, this.i + n); if (o.length < n) throw new Error("truncated"); this.i += n; return o; }
}

const MAGIC = [0x46, 0x31, 0x42, 0x54]; // "F1BT"
const NOTHING = 255;
const noteFrom = (row, m) => (row === 0 ? KIT.find(([, x]) => x === m)?.[0] ?? null : midiName(m));

/**
 * "F1BT" u8 version=1 u8 n u8 d u8 k u8 bars u32 from u32 to
 * varint P, P × (u8 row, u8 midi)              notes used, in first-use order
 * varint S, S × (varint Δh, u16 cell, u8 note)  sets in history order; 255 = nothing
 * varint O, O × (u16 cell, u8 len, address)     owners of the cells that appear
 */
export function encodeSession({ shape, from, to, sets }) {
  const w = new Writer();
  w.bytes(MAGIC); w.u8(1); w.u8(shape.n); w.u8(shape.d); w.u8(shape.k); w.u8(shape.bars); w.u32(from); w.u32(to);
  const table = [];
  const idx = (row, m) => table.findIndex(([r, x]) => r === row && x === m);
  for (const s of sets) if (s.note) { const m = midiOf(s.note); if (idx(rowOf(s.cell), m) < 0) table.push([rowOf(s.cell), m]); }
  if (table.length > 254) throw new Error("too many notes");
  w.varint(table.length);
  for (const [r, m] of table) { w.u8(r); w.u8(m); }
  w.varint(sets.length);
  let prev = from;
  const owners = new Map();
  for (const s of sets) {
    if (s.h < prev) throw new Error("sets are not in history order");
    w.varint(s.h - prev); prev = s.h;
    w.u16(s.cell);
    w.u8(s.note ? idx(rowOf(s.cell), midiOf(s.note)) : NOTHING);
    if (!owners.has(s.cell)) owners.set(s.cell, s.owner);
  }
  w.varint(owners.size);
  for (const [cell, owner] of [...owners].sort((a, b) => a[0] - b[0])) {
    const a = new TextEncoder().encode(owner);
    if (a.length > 255) throw new Error("address too long");
    w.u16(cell); w.u8(a.length); w.bytes(a);
  }
  return w.done();
}

export function decodeSession(bytes) {
  const r = new Reader(bytes);
  const magic = r.bytes(4);
  if (MAGIC.some((m, i) => magic[i] !== m)) throw new Error("not a F1R3Beat session");
  const v = r.u8();
  if (v !== 1) throw new Error(`unknown body version ${v}`);
  const n = r.u8(), d = r.u8(), k = r.u8(), bars = r.u8();
  const shape = shapeOf(n, d, bars, k);
  if (!shape) throw new Error("bad shape");
  const from = r.u32(), to = r.u32();
  const table = Array.from({ length: r.varint() }, () => [r.u8(), r.u8()]);
  const raw = [];
  let h = from;
  for (let c = r.varint(); c > 0; c--) {
    h += r.varint();
    const cell = r.u16(), x = r.u8();
    if (x !== NOTHING && !table[x]) throw new Error("note index");
    raw.push({ h, cell, note: x === NOTHING ? null : noteFrom(table[x][0], table[x][1]) });
  }
  const owners = new Map();
  for (let c = r.varint(); c > 0; c--) { const cell = r.u16(); owners.set(cell, new TextDecoder().decode(r.bytes(r.u8()))); }
  if (r.i !== bytes.length) throw new Error("trailing bytes");
  return { shape, from, to, sets: raw.map((s) => ({ ...s, owner: owners.get(s.cell) })) };
}

/** A pattern body: canonical CBOR {score, credits: [[cell, address], ...]}. */
export function encodePatternBody(p, credits = new Map()) {
  return encodeCbor({ score: score(p), credits: [...credits].sort((a, b) => a[0] - b[0]).map(([c, a]) => [c, a]) });
}

export function decodePatternBody(bytes) {
  const v = decodeCbor(bytes);
  if (!v || typeof v.score !== "string") throw new Error("not a F1R3Beat pattern");
  return { pattern: parseScore(v.score), credits: new Map((v.credits ?? []).map(([c, a]) => [c, a])) };
}

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
