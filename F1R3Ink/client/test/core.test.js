// The framework-free core held to F1R3Ink/vectors/ink-vectors.json, which the
// Rust tests read too (crates/games/tests/ink.rs, crates/wallet/tests/ink.rs).
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { configOk, handle, opacity, remaining } from "../src/core/ink.js";
import { inspectInk, openInkWith, openInkWithKey } from "../src/core/envelope.js";
import { decodeFlag, decodeRound, encodeFlag, encodeRound, fromHex, orderEvents, toHex } from "../src/core/history.js";
import { flagView, spectrum } from "../src/core/flags.js";
import vectors from "../../vectors/ink-vectors.json";

const v = vectors;
const sealedOf = (e) => (e.type === "ink" && e.ink.hash ? { ...e, ink: { hash: e.ink.hash, ...(e.ink.colour === null ? {} : { colour: e.ink.colour }) } } : e);

describe("the vectors", () => {
  it("configurations, decay and handles", () => {
    for (const c of v.configs) expect(configOk(c.config) !== null).toBe(c.ok);
    for (const d of v.decay) {
      expect(remaining(d.decay, d.last, d.now)).toBe(d.remaining);
      expect(opacity(d.decay, d.last, d.now)).toBeCloseTo(d.opacity, 12);
    }
    for (const h of v.handles) expect(handle(hexToBytes(v.secret), v.instance, h.target, h.inker)).toBe(h.handle);
  });

  it("sealed inks open for their parties only, and with their content key", () => {
    for (const s of v.sealed) {
      const b = fromHex(s.envelope);
      expect(inspectInk(b)).toEqual({ target: s.target, sid: s.sid, seq: s.seq });
      for (const i of s.parties) {
        const o = openInkWith(hexToBytes(v.keys[i]), { game: "f1r3ink", instance: v.instance }, b);
        expect(o).toMatchObject({ target: s.target, sid: s.sid, seq: s.seq, colour: s.colour });
        expect(toHex(o.key)).toBe(s.key);
      }
      const outsider = [0, 1, 2].find((i) => !s.parties.includes(i));
      expect(() => openInkWith(hexToBytes(v.keys[outsider]), { game: "f1r3ink", instance: v.instance }, b)).toThrow();
      expect(() => openInkWith(hexToBytes(v.keys[s.parties[0]]), { game: "f1r3ink", instance: "elsewhere" }, b)).toThrow();
      expect(openInkWithKey({ game: "f1r3ink", instance: v.instance }, b, fromHex(s.key)).colour).toBe(s.colour);
    }
  });

  it("history order, and the round and portrait bodies", () => {
    const shuffled = v.order.shuffled.map(sealedOf), ordered = v.order.ordered.map(sealedOf);
    expect(orderEvents(shuffled)).toEqual(ordered);
    const round = { from: v.round.from, to: v.round.to, palette: v.round.palette, decay: v.round.decay, events: ordered };
    const b = encodeRound(round);
    expect(toHex(b)).toBe(v.round.hex);
    expect(decodeRound(b).events.map((e) => e.type)).toEqual(ordered.map((e) => e.type));
    const f = v.flag;
    const fb = encodeFlag({ owner: f.owner, round: { from: f.from, to: f.to, palette: f.palette, decay: null, events: f.events.map(sealedOf) }, keys: f.keys });
    expect(toHex(fb)).toBe(f.hex);
    expect(decodeFlag(fb)).toMatchObject({ owner: f.owner, keys: f.keys });
    expect(() => decodeRound(fb)).toThrow();
  });
});

describe("what a viewer sees (D1, D8, D15)", () => {
  const players = { a: { flag: "public", veil: ["c"] }, b: { flag: "private", veil: [] }, c: { flag: "public", veil: [] } };
  const s = (sid, c, t = 0) => ({ sid, seq: 1, first: [1, t], last: [1, t], ink: { c } });
  const stripes = { a: [s("b", 1), s("c", 2, 1)], b: [s("a", 3), s("c", 4, 1)], c: [s("a", 5)] };
  const base = { players, stripes, decay: null, now: 0 };
  it("a public flag in full, a private one as your own stripe, veiled stripes without colour", () => {
    expect(flagView({ ...base, viewer: "b", target: "a" }).map((x) => [x.key, x.colour, x.veiled])).toEqual([["b", 1, false], ["c", null, true]]);
    expect(flagView({ ...base, viewer: "a", target: "b" }).map((x) => x.key)).toEqual(["a"]);
    expect(flagView({ ...base, viewer: "a", target: "a" }).map((x) => x.colour)).toEqual([1, 2]);
    // Show to see: a private viewer sees only their own stripes.
    expect(flagView({ ...base, viewer: "b", target: "c", reciprocity: true }).map((x) => x.key)).toEqual([]);
  });
  it("the spectrum counts the flags it is built from", () => {
    const sp = spectrum({ ...base, viewer: "c", colours: new Map(), mine: new Set(), reciprocity: false, palette: Array(8).fill("#000000") });
    expect([sp.from, sp.of]).toEqual([2, 3]);
    expect(sp.weights[3]).toBe(0); // b's private flag: a's stripe on it is not c's to see
    expect(sp.weights[4]).toBe(1); // c's own stripe on b
  });
});
