// History order (design §5.5) and the play body encoding (§10.2).
//
// The environment's `log` answers paints cell by cell; readers order them by
// height, then timestamp, then owner, keeping each cell's own order.
import { cellToIdx, idxToCell, cellsFor } from "./hex.js";

export function orderPaints(entries) {
  // entries: [h, ts, owner, q, r, colour] as `log` answers them.
  return entries
    .map((e, i) => ({ h: e[0], ts: e[1], owner: e[2], q: e[3], r: e[4], colour: e[5], i }))
    .sort((a, b) => a.h - b.h || a.ts - b.ts || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.i - b.i)
    .map(({ i, ...p }) => p);
}

/** The board after applying `paints` (ordered) up to and including height `upTo`. */
export function boardAt(paints, upTo = Infinity) {
  const m = new Map();
  for (const p of paints) {
    if (p.h > upTo) break;
    m.set(`${p.q},${p.r}`, p.colour);
  }
  return m;
}

/** Distinct heights at which the board changed: one playback frame per block. */
export const frames = (paints) => [...new Set(paints.map((p) => p.h))];

// ---------------------------------------------------------------- bytes

class Writer {
  constructor() { this.b = []; }
  u8(x) { this.b.push(x & 255); }
  u16(x) { this.u8(x >> 8); this.u8(x); }
  u32(x) { this.u16(Math.floor(x / 65536)); this.u16(x % 65536); }
  varint(x) {
    if (!Number.isSafeInteger(x) || x < 0) throw new RangeError("varint must be a non-negative safe integer");
    do { let byte = x % 128; x = Math.floor(x / 128); if (x > 0) byte |= 128; this.u8(byte); } while (x > 0);
  }
  bytes(a) { for (const x of a) this.u8(x); }
  done() { return Uint8Array.from(this.b); }
}

class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  u8() { if (this.i >= this.b.length) throw new Error("truncated"); return this.b[this.i++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return this.u16() * 65536 + this.u16(); }
  varint() { let x = 0, m = 1, byte; do { byte = this.u8(); x += (byte & 127) * m; m *= 128; } while (byte & 128); return x; }
  bytes(n) { const out = this.b.slice(this.i, this.i + n); if (out.length < n) throw new Error("truncated"); this.i += n; return out; }
}

const UNPAINTED = 255;
const SPILL = 254;
const MAGIC = [0x46, 0x31, 0x50, 0x58]; // "F1PX"

function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hexOf([r, g, b]) { return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase(); }

/**
 * Encode the history of a span. `paints` must already be in history order.
 *   "F1PX" u8 version=1 u8 radius u32 from u32 to
 *   varint P, P × 3 bytes     palette in first-use order
 *   varint S, S × (varint Δh, u16 cell, colour)   colour: u8 < 254, or 254 then u16; 255 = unpainted
 *   varint O, O × (u16 cell, u8 n, n bytes)       owners (address as UTF-8) of the cells that appear
 */
export function encodeBody({ radius, from, to, paints }) {
  const w = new Writer();
  w.bytes(MAGIC); w.u8(1); w.u8(radius); w.u32(from); w.u32(to);
  const palette = [];
  const index = new Map();
  for (const p of paints) if (p.colour && !index.has(p.colour)) { index.set(p.colour, palette.length); palette.push(p.colour); }
  w.varint(palette.length);
  for (const c of palette) w.bytes(rgb(c));
  w.varint(paints.length);
  let prev = from;
  const owners = new Map();
  for (const p of paints) {
    if (p.h < prev) throw new Error("paints are not in history order");
    w.varint(p.h - prev); prev = p.h;
    const cell = cellToIdx(p.q, p.r);
    w.u16(cell);
    if (!p.colour) w.u8(UNPAINTED);
    else { const ci = index.get(p.colour); if (ci < SPILL) w.u8(ci); else { w.u8(SPILL); w.u16(ci); } }
    if (!owners.has(cell)) owners.set(cell, p.owner);
  }
  w.varint(owners.size);
  for (const [cell, owner] of [...owners].sort((a, b) => a[0] - b[0])) {
    const a = new TextEncoder().encode(owner);
    if (a.length > 255) throw new Error("address too long");
    w.u16(cell); w.u8(a.length); w.bytes(a);
  }
  return w.done();
}

export function decodeBody(bytes) {
  const r = new Reader(bytes);
  const magic = r.bytes(4);
  if (MAGIC.some((m, i) => magic[i] !== m)) throw new Error("not a F1R3Pix body");
  const version = r.u8();
  if (version !== 1) throw new Error(`unknown body version ${version}`);
  const radius = r.u8(), from = r.u32(), to = r.u32();
  const palette = Array.from({ length: r.varint() }, () => hexOf(r.bytes(3)));
  const n = r.varint();
  const raw = [];
  let h = from;
  for (let k = 0; k < n; k++) {
    h += r.varint();
    const cell = r.u16();
    const c = r.u8();
    const colour = c === UNPAINTED ? null : c === SPILL ? palette[r.u16()] : palette[c];
    raw.push({ h, cell, colour });
  }
  const owners = new Map();
  for (let k = r.varint(); k > 0; k--) { const cell = r.u16(); owners.set(cell, new TextDecoder().decode(r.bytes(r.u8()))); }
  if (r.i !== bytes.length) throw new Error("trailing bytes");
  const paints = raw.map(({ h, cell, colour }) => { const [q, rr] = idxToCell(cell); return { h, q, r: rr, owner: owners.get(cell), colour }; });
  return { radius, from, to, palette, paints };
}

/**
 * The header's preview frame: one byte per cell in spiral order (255 void,
 * 254 seated but unpainted, otherwise a palette index). A frame using more
 * than 254 colours maps the extra ones to the nearest earlier colour.
 */
export function encodePreview(radius, cells /* Map "q,r" -> colour | null (seated, unpainted) */) {
  const n = cellsFor(radius);
  const palette = [];
  const index = new Map();
  const frame = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) {
    const [q, r] = idxToCell(i);
    const k = `${q},${r}`;
    if (!cells.has(k)) continue;
    const c = cells.get(k);
    if (!c) { frame[i] = 254; continue; }
    if (!index.has(c)) {
      if (palette.length < 254) { index.set(c, palette.length); palette.push(c); }
      else index.set(c, nearest(c, palette));
    }
    frame[i] = index.get(c);
  }
  return { radius, palette, frame: Array.from(frame, (b) => b.toString(16).padStart(2, "0")).join("") };
}

export function decodePreview({ radius, palette, frame }) {
  const m = new Map();
  const bytes = (frame.match(/../g) ?? []).map((x) => parseInt(x, 16));
  bytes.forEach((b, i) => {
    if (b === 255) return;
    const [q, r] = idxToCell(i);
    m.set(`${q},${r}`, b === 254 ? null : palette[b]);
  });
  return { radius, cells: m };
}

function nearest(c, palette) {
  const [r, g, b] = rgb(c);
  let best = 0, bd = Infinity;
  palette.forEach((p, i) => { const [x, y, z] = rgb(p); const d = (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
