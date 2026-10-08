// History order (design §6.5) and the play bodies (design D14, §13): a `round`
// is the history of a span, encoded "F1NK"; a `flag` portrait is one person's
// part of it, "F1NF", with the content keys of the sealed inks it discloses.
// Mirrors crates/games/src/ink.rs.
import { blake2b } from "@noble/hashes/blake2b";
import { sidKey } from "./ink.js";

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h) => Uint8Array.from(((h.startsWith("0x") ? h.slice(2) : h).match(/../g) ?? []).map((x) => parseInt(x, 16)));
/** BLAKE2b-256 of a sealed envelope (hex in, hex out). */
export const envelopeHash = (hex) => toHex(blake2b(fromHex(hex), { dkLen: 32 }));

/** An ink as the chain answers it ({c}, {sealed}, or missing/Nil) → {c} | {lifted} | {sealed}. */
export function inkOf(v) {
  if (v === undefined || v === null) return { lifted: true };
  if (Number.isInteger(v.c)) return { c: v.c };
  if (typeof v.sealed === "string") return { sealed: v.sealed.startsWith("0x") ? v.sealed.slice(2) : v.sealed };
  throw new Error("bad ink");
}

/**
 * `log` entries →  events:
 *   [h, t, "ink", target, sid, ink?]          → {type: "ink", target, sid: key, ink}
 *   [h, t, "flag", a, "public"|"private"]     → {type: "visibility", player, public}
 *   [h, t, "tags", a, tags] / [h, t, "veil", a, sids]
 *   [h, t, "reveal", target, handle, a]       → {type: "reveal", target, handle, player}
 */
export function eventsOf(entries) {
  return entries.map((e) => {
    const [h, t, kind] = e;
    switch (kind) {
      case "ink": return { h, t, type: "ink", target: e[3], sid: sidKey(e[4]), ink: inkOf(e[5]) };
      case "flag": return { h, t, type: "visibility", player: e[3], public: e[4] === "public" };
      case "tags": return { h, t, type: "tags", player: e[3], tags: e[4] ?? [] };
      case "veil": return { h, t, type: "veil", player: e[3], sids: (e[4] ?? []).map(sidKey) };
      case "reveal": return { h, t, type: "reveal", target: e[3], handle: e[4], player: e[5] };
      default: throw new Error(`unknown log entry ${kind}`);
    }
  });
}

const RANK = { visibility: 0, tags: 1, veil: 2, ink: 3, reveal: 4 };
const keyOf = (e) => {
  switch (e.type) {
    case "ink": return [e.target, e.sid];
    case "reveal": return [e.target, `anon:${e.handle}`];
    default: return [e.player, ""];
  }
};
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function cmpEvents(a, b) {
  const [ka, kb] = [keyOf(a), keyOf(b)];
  return a.h - b.h || a.t - b.t || RANK[a.type] - RANK[b.type] || cmpStr(ka[0], kb[0]) || cmpStr(ka[1], kb[1]);
}
/** History order: block, block time, then visibility, tags, veils, inks and reveals, by subject and stripe. Stable. */
export const orderEvents = (events) => events.map((e, i) => [e, i]).sort((x, y) => cmpEvents(x[0], y[0]) || x[1] - y[1]).map(([e]) => e);

export const frames = (events) => [...new Set(events.map((e) => e.h))];

// ------------------------------------------------------------------ encodings

class Writer {
  constructor() { this.b = []; }
  u8(x) { this.b.push(x & 255); }
  u16(x) { this.u8(x >> 8); this.u8(x); }
  u32(x) { this.u16(Math.floor(x / 65536)); this.u16(x % 65536); }
  u64(x) { if (!Number.isSafeInteger(x) || x < 0) throw new RangeError("u64"); this.u32(Math.floor(x / 2 ** 32)); this.u32(x % 2 ** 32); }
  varint(x) { if (!Number.isSafeInteger(x) || x < 0) throw new RangeError("varint"); do { let y = x % 128; x = Math.floor(x / 128); if (x > 0) y |= 128; this.u8(y); } while (x > 0); }
  zigzag(x) { this.varint(x >= 0 ? 2 * x : -2 * x - 1); }
  bytes(a) { for (const x of a) this.u8(x); }
  done() { return Uint8Array.from(this.b); }
}
class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  u8() { if (this.i >= this.b.length) throw new Error("truncated"); return this.b[this.i++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return this.u16() * 65536 + this.u16(); }
  u64() { return this.u32() * 2 ** 32 + this.u32(); }
  varint() { let x = 0, m = 1, y; do { y = this.u8(); x += (y & 127) * m; m *= 128; if (m > 2 ** 56) throw new Error("varint"); } while (y & 128); return x; }
  zigzag() { const z = this.varint(); return z % 2 ? -(z + 1) / 2 : z / 2; }
  bytes(n) { const o = this.b.slice(this.i, this.i + n); if (o.length < n) throw new Error("truncated"); this.i += n; return o; }
  index(table) { const i = this.varint(); if (i >= table.length) throw new Error("bad index"); return table[i]; }
}

const ROUND = [0x46, 0x31, 0x4e, 0x4b]; // "F1NK"
const FLAG = [0x46, 0x31, 0x4e, 0x46]; // "F1NF"
const UNKNOWN = 255;
const SEP = "\u001f";
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const rgb = (c) => { if (!/^#[0-9A-F]{6}$/.test(c)) throw new Error(`bad colour ${c}`); const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

function tables(events, first = []) {
  const players = [], handles = [];
  const p = (a) => { if (!players.includes(a)) players.push(a); };
  const h = (x) => { if (!handles.includes(x)) handles.push(x); };
  const s = (k) => (k.startsWith("anon:") ? h(k.slice(5)) : p(k));
  first.forEach(p);
  for (const e of events) {
    if (e.type === "visibility" || e.type === "tags") p(e.player);
    else if (e.type === "veil") { p(e.player); e.sids.forEach(s); }
    else if (e.type === "ink") { p(e.target); s(e.sid); }
    else if (e.type === "reveal") { p(e.target); h(e.handle); p(e.player); }
  }
  return { players, handles };
}

function writeParts(w, { from, to, palette, decay, events }, first = []) {
  const t = tables(events, first);
  const pi = (a) => t.players.indexOf(a), hi = (x) => t.handles.indexOf(x);
  const sid = (k) => { if (k.startsWith("anon:")) { w.u8(1); w.varint(hi(k.slice(5))); } else { w.u8(0); w.varint(pi(k)); } };
  const t0 = events[0]?.t ?? 0;
  w.u32(from); w.u32(to); w.u64(t0);
  w.u16(decay ? decay.steps : 0); w.u32(decay ? decay.unit : 0);
  if (palette.length > 32) throw new Error("palette");
  w.varint(palette.length); palette.forEach((c) => w.bytes(rgb(c)));
  w.varint(t.players.length); for (const a of t.players) { const b = enc.encode(a); w.varint(b.length); w.bytes(b); }
  w.varint(t.handles.length); for (const x of t.handles) { if (!/^[0-9a-f]{32}$/.test(x)) throw new Error("bad handle"); w.bytes(fromHex(x)); }
  w.varint(events.length);
  let ph = from, pt = t0, prev = null;
  for (const e of events) {
    if (e.h < ph || (prev && cmpEvents(prev, e) > 0)) throw new Error("events are not in history order");
    prev = e;
    w.varint(e.h - ph); w.zigzag(e.t - pt); ph = e.h; pt = e.t;
    switch (e.type) {
      case "visibility": w.u8(0); w.varint(pi(e.player)); w.u8(e.public ? 1 : 0); break;
      case "tags": { w.u8(1); w.varint(pi(e.player)); const b = enc.encode(e.tags.join(SEP)); w.varint(b.length); w.bytes(b); break; }
      case "ink": {
        w.u8(2); w.varint(pi(e.target)); sid(e.sid);
        const k = e.ink;
        if (k.lifted) w.u8(1);
        else if (Number.isInteger(k.c)) { w.u8(0); w.u8(k.c); }
        else { w.u8(2); w.u8(Number.isInteger(k.colour) ? k.colour : UNKNOWN); w.bytes(fromHex(k.hash ?? envelopeHash(k.sealed))); }
        break;
      }
      case "veil": w.u8(3); w.varint(pi(e.player)); w.varint(e.sids.length); e.sids.forEach(sid); break;
      case "reveal": w.u8(4); w.varint(pi(e.target)); w.varint(hi(e.handle)); w.varint(pi(e.player)); break;
      default: throw new Error(`bad event ${e.type}`);
    }
  }
  return t;
}

function readParts(r) {
  const from = r.u32(), to = r.u32(), t0 = r.u64(), steps = r.u16(), unit = r.u32();
  const decay = steps ? { unit, steps } : null;
  const np = r.varint(); if (np > 32) throw new Error("palette");
  const palette = Array.from({ length: np }, () => "#" + toHex(r.bytes(3)).toUpperCase());
  const players = Array.from({ length: r.varint() }, () => dec.decode(r.bytes(r.varint())));
  const handles = Array.from({ length: r.varint() }, () => toHex(r.bytes(16)));
  const sid = () => { const k = r.u8(); if (k === 0) return r.index(players); if (k === 1) return `anon:${r.index(handles)}`; throw new Error("bad stripe"); };
  const n = r.varint();
  const events = [];
  let h = from, t = t0;
  for (let i = 0; i < n; i++) {
    h += r.varint(); t += r.zigzag();
    const type = r.u8();
    if (type === 0) events.push({ h, t, type: "visibility", player: r.index(players), public: r.u8() === 1 });
    else if (type === 1) { const player = r.index(players); const s = dec.decode(r.bytes(r.varint())); events.push({ h, t, type: "tags", player, tags: s ? s.split(SEP) : [] }); }
    else if (type === 2) {
      const target = r.index(players), s = sid(), k = r.u8();
      let ink;
      if (k === 0) ink = { c: r.u8() };
      else if (k === 1) ink = { lifted: true };
      else if (k === 2) { const c = r.u8(); ink = { colour: c === UNKNOWN ? null : c, hash: toHex(r.bytes(32)) }; }
      else throw new Error("bad ink");
      events.push({ h, t, type: "ink", target, sid: s, ink });
    } else if (type === 3) { const player = r.index(players); const m = r.varint(); events.push({ h, t, type: "veil", player, sids: Array.from({ length: m }, sid) }); }
    else if (type === 4) events.push({ h, t, type: "reveal", target: r.index(players), handle: r.index(handles), player: r.index(players) });
    else throw new Error("bad event type");
  }
  return { round: { from, to, palette, decay, events }, players };
}

/** Encode a `round` body; events in history order (sealed inks carry `sealed` hex or `hash`, and `colour` if disclosed). */
export function encodeRound(round) {
  const w = new Writer();
  w.bytes(ROUND); w.u8(1);
  writeParts(w, round);
  return w.done();
}

export function decodeRound(b) {
  const r = new Reader(b);
  if (toHex(r.bytes(4)) !== toHex(ROUND)) throw new Error("not a F1R3Ink round");
  const v = r.u8(); if (v !== 1) throw new Error(`unknown round version ${v}`);
  const { round } = readParts(r);
  if (r.i !== b.length) throw new Error("trailing bytes");
  return round;
}

const concerns = (e, owner) => (e.type === "ink" || e.type === "reveal" ? e.target === owner : e.player === owner);

/** Encode a `flag` portrait: {owner, round, keys: [[eventIndex, keyHex], ...]}; the owner is first in the player table. */
export function encodeFlag({ owner, round, keys = [] }) {
  if (!round.events.every((e) => concerns(e, owner))) throw new Error("an event that does not concern the owner");
  const w = new Writer();
  w.bytes(FLAG); w.u8(1);
  const t = writeParts(w, round, [owner]);
  w.varint(t.players.indexOf(owner));
  w.varint(keys.length);
  for (const [i, k] of keys) { if (i >= round.events.length) throw new Error("key index"); w.varint(i); w.bytes(fromHex(k)); }
  return w.done();
}

export function decodeFlag(b) {
  const r = new Reader(b);
  if (toHex(r.bytes(4)) !== toHex(FLAG)) throw new Error("not a F1R3Ink portrait");
  const v = r.u8(); if (v !== 1) throw new Error(`unknown portrait version ${v}`);
  const { round, players } = readParts(r);
  const owner = r.index(players);
  const keys = Array.from({ length: r.varint() }, () => { const i = r.varint(); if (i >= round.events.length) throw new Error("key index"); return [i, toHex(r.bytes(32))]; });
  if (r.i !== b.length) throw new Error("trailing bytes");
  return { owner, round, keys };
}
