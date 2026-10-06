import { describe, expect, it } from "vitest";
import vectors from "../../vectors/beat-vectors.json";
import { shapeOf, palette, noteOk, distance, cellIndex } from "../src/core/grid.js";
import { seatStart, randomSeat, rowSeat } from "../src/core/seating.js";
import { score, digest, parseScore, notes } from "../src/core/score.js";
import { encodeSession, decodeSession, encodePatternBody, decodePatternBody, orderSets, toHex, fromHex } from "../src/core/history.js";
import { Prng, refill, brood, broodSeed, epochSeed, runEpoch, crossBrood, cull } from "../src/core/breed.js";
import { loopEvents, columnSeconds, midiFile } from "../src/core/audio.js";
import { encodeCbor, decodeCbor } from "../src/core/cbor.js";

const pat = (s) => ({ shape: shapeOf(...s.shape), cells: s.cells });

describe("the grid", () => {
  it("validates shapes as the vectors record", () => {
    for (const s of vectors.shapes) expect(shapeOf(s.n, s.d, s.bars, s.k)).toEqual(s.shape);
    expect(shapeOf(4, 4, 5, 16)).toBeNull(); // 80 columns is over the bound
  });
  it("builds palettes and checks notes", () => {
    vectors.palettes.rows.forEach((p, r) => {
      expect(palette(r)).toEqual(p.any);
      expect(palette(r, vectors.palettes.scale)).toEqual(p.scale);
    });
    expect(noteOk(1, "E1")).toBe(true);
    expect(noteOk(1, "Fb2")).toBe(false);
    expect(noteOk(0, "kick") && !noteOk(1, "kick") && !noteOk(0, "C2")).toBe(true);
  });
  it("measures distance on the loop as a cylinder", () => {
    expect(distance(cellIndex(0, 0), cellIndex(31, 0), 32)).toBe(1);
    expect(distance(cellIndex(4, 1), cellIndex(4, 4), 32)).toBe(3);
  });
});

describe("seating", () => {
  it("matches the vectors", () => {
    const s = shapeOf(...vectors.seating.shape), taken = new Set(vectors.seating.taken);
    for (const v of vectors.seating.seats) {
      expect(seatStart(vectors.instance, v.address)).toBe(v.start);
      expect(randomSeat(vectors.instance, v.address, s, taken)).toBe(v.random);
      v.row.forEach((c, r) => expect(rowSeat(vectors.instance, v.address, s, r, taken)).toBe(c));
    }
  });
});

describe("the score bridge", () => {
  it("writes canonical scores that parse back", () => {
    for (const [name, v] of Object.entries(vectors.scores)) {
      const p = pat(v);
      expect(score(p), name).toBe(v.score);
      expect(digest(p), name).toBe(v.digest);
      expect(parseScore(v.score)).toEqual(p);
    }
    expect(() => parseScore(vectors.scores.mother.score.replace("c16 = 1", "c16 = 1/1"))).toThrow();
  });
  it("matches the design's worked example (§7.1)", () => {
    expect(vectors.scores.mother.score).toContain('line(base "bass", bass)         [ E2 c1, r c2, E2 c1, r c2, G2 c1, r c1, A2 c1, r c2,');
    const ns = notes(pat(vectors.scores.mother));
    expect(ns.filter((n) => n.onset === 0).map((n) => n.note)).toEqual(["kick", "E2"]);
  });
});

describe("the bodies", () => {
  it("encode sessions and patterns as the vectors record", () => {
    const v = vectors.session;
    const bytes = encodeSession({ shape: shapeOf(...v.shape), from: v.from, to: v.to, sets: v.sets });
    expect(toHex(bytes)).toBe(v.hex);
    expect(decodeSession(bytes).sets).toEqual(v.sets);
    expect(() => decodeSession(bytes.slice(0, -1))).toThrow(/truncated/);
    const pb = vectors.patternBody;
    const b = encodePatternBody(pat(vectors.scores.mother), new Map(pb.credits));
    expect(toHex(b)).toBe(pb.hex);
    expect(decodePatternBody(fromHex(pb.hex)).credits).toEqual(new Map(pb.credits));
    expect(decodeCbor(encodeCbor({ a: [1, 300, "x"], bb: 70000 }))).toEqual({ a: [1, 300, "x"], bb: 70000 });
  });
  it("reads log entries whose Nil note the node's JSON dropped", () => {
    const s = orderSets([[5, 2, "b", 3], [5, 1, "a", 0, "kick"], [4, 9, "c", 6, "E2"]]);
    expect(s.map((x) => [x.owner, x.note])).toEqual([["c", "E2"], ["a", "kick"], ["b", null]]);
  });
});

describe("reproduction", () => {
  it("uses F1R3Score's generator", () => {
    const v = vectors.prng, g = new Prng(BigInt(v.seed));
    expect(Array.from({ length: 6 }, () => g.nextU64().toString())).toEqual(v.u64);
    expect([7, 30, 1000].map((n) => g.below(n))).toEqual(v.below);
    expect(g.choose(3, 10)).toEqual(v.choose);
    for (const r of vectors.refills) expect(refill(r.slots, r.melody, new Prng(BigInt(r.seed)))).toEqual(r.out);
  });
  it("breeds, crosses and runs epochs as the vectors record", () => {
    const p = (n) => pat(vectors.scores[n]);
    const kids = (ks) => ks?.map((c) => ({ operator: c.operator, parents: c.parents, digest: digest(c.pattern), score: score(c.pattern) })) ?? null;
    const brd = (a, b) => brood(a, b, Prng.fromHash(broodSeed(epochSeed(vectors.broods.block, 1), digest(a), digest(b))));
    expect(kids(brd(p("mother"), p("father")))).toEqual(vectors.broods.motherFather);
    expect(kids(brd(p("short"), p("long")))).toEqual(vectors.broods.shortLong);
    expect(brd(p("mother"), p("triplet"))).toBeNull(); // different species
    expect(kids(crossBrood(vectors.cross.block, vectors.cross.crosser, p("mother"), p("father")))).toEqual(vectors.cross.children);
    const byDigest = new Map(["mother", "father", "short", "long", "triplet"].map((n) => [vectors.scores[n].digest, p(n)]));
    for (let i = 0; i < 14; i++) {
      const cells = Array(80).fill(null); cells[cellIndex(i, 0)] = "kick";
      const x = { shape: shapeOf(4, 4, 1, 16), cells };
      byDigest.set(digest(x), x);
    }
    const members = vectors.epochs.members.map((m) => ({ ...m, shape: shapeOf(...m.shape) }));
    for (const key of ["small", "big"]) {
      const e = vectors.epochs[key];
      const r = runEpoch(vectors.broods.block, e.epoch, members.slice(0, e.size), byDigest);
      expect({ parents: r.parents, children: r.children.map((c) => digest(c.pattern)), culled: r.culled }).toEqual(e.out);
    }
  });
  it("never culls newborns or below the floor", () => {
    const s = shapeOf(4, 4, 1, 16);
    const pop = Array.from({ length: 20 }, (_, i) => ({ digest: i.toString(16).padStart(64, "0"), shape: s, born: i < 3 ? 9 : 0, weight: 1 + i }));
    for (let seed = 0; seed < 20; seed++) {
      const out = cull(pop, 10, new Prng(BigInt(seed)));
      expect(out.length).toBeGreaterThan(0);
      expect(out.some((d) => parseInt(d, 16) < 3)).toBe(false);
    }
    expect(cull(pop.slice(0, 16), 10, new Prng(1n))).toEqual([]);
  });
});

describe("sound", () => {
  it("schedules the loop at the listener's tempo", () => {
    const p = pat(vectors.scores.mother);
    expect(columnSeconds(16, 120)).toBeCloseTo(0.125);
    const ev = loopEvents(p, 120);
    expect(ev.filter((e) => e.time === 0).map((e) => e.note)).toEqual(["kick", "E2"]);
    expect(ev.find((e) => e.note === "snare").time).toBeCloseTo(0.5);
    const midi = midiFile(p, 96);
    expect(String.fromCharCode(...midi.slice(0, 4))).toBe("MThd");
    expect(midi[11]).toBe(6); // a tempo track and one per row
  });
});
