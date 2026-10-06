// Writes F1R3Beat/vectors/beat-vectors.json from the JavaScript implementation.
// The Rust tests (crates/games/tests/beat.rs) and the JavaScript tests hold
// every implementation to these values.
import { writeFileSync } from "node:fs";
import { shapeOf, palette, cellIndex } from "../src/core/grid.js";
import { seatStart, randomSeat, rowSeat } from "../src/core/seating.js";
import { score, digest } from "../src/core/score.js";
import { encodeSession, encodePatternBody, toHex } from "../src/core/history.js";
import { Prng, brood, broodSeed, epochSeed, runEpoch, crossBrood, refill } from "../src/core/breed.js";

const INSTANCE = "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9011223344556677889900aabbccdd";
const ADDR = ["1111aqq7mDkxjtYmLanT2sPVZ67HcmhMdBwr8wjAhE2B4kVRxJHM7", "1111bJHrH7cK3m8hW4eTyQWU2RjsX8JmGqYbUvVrV7eYV3kNqMPa", "1111cPs1DgpVHU8bwXzvR4gG8tRxE4oD6NQ2c8SxbfTjK9uWzM2E"];
const BLOCK = "7b5d1b2a9c0e3f4a5b6c7d8e9f00112233445566778899aabbccddeeff001122";

export function patternFrom(shape, rows) {
  const cells = Array(shape.cells).fill(null);
  rows.forEach((r, row) => Object.entries(r).forEach(([t, v]) => { cells[cellIndex(+t, row)] = v; }));
  return { shape, cells };
}
const S16 = shapeOf(4, 4, 1, 16);
// The design's worked example (§7.1, Figure 2) and its second parent (Figure 3).
export const MOTHER = patternFrom(S16, [
  { 0: "kick", 2: "chh", 4: "snare", 6: "chh", 8: "kick", 10: "kick", 12: "snare", 14: "ohh" },
  { 0: "E2", 3: "E2", 6: "G2", 8: "A2", 11: "A2" }, { 4: "E3", 12: "D3" }, {}, { 4: "D4", 8: "E4" }]);
export const FATHER = patternFrom(S16, [
  { 0: "kick", 2: "chh", 4: "kick", 6: "chh", 8: "kick", 10: "chh", 12: "kick", 14: "chh" },
  { 0: "A2", 4: "C3", 8: "D3", 14: "E3" }, { 0: "G3" }, { 4: "C4" }, { 0: "G4", 2: "A4", 4: "B4" }]);
const TRIPLET = patternFrom(shapeOf(4, 4, 2, 12), [{ 0: "kick", 3: "snare", 6: "kick", 9: "snare", 12: "kick", 21: "snare" }, { 0: "E2", 2: "G2", 5: "A2", 14: "B2" }, {}, {}, {}]);
const SHORT = patternFrom(shapeOf(4, 4, 1, 16), [{ 0: "kick", 8: "kick" }, {}, { 0: "B3" }, {}, {}]);
const LONG = patternFrom(shapeOf(4, 4, 3, 16), [{ 0: "kick", 4: "snare", 20: "snare", 36: "snare" }, { 16: "E2" }, {}, {}, { 40: "G4" }]);

const shapes = [[4, 4, 2, 16], [3, 4, 2, 16], [6, 8, 2, 16], [7, 8, 4, 16], [4, 4, 2, 12], [4, 4, 1, 32], [4, 4, 5, 16], [5, 8, 1, 4], [4, 3, 1, 16]]
  .map(([n, d, bars, k]) => ({ n, d, bars, k, shape: shapeOf(n, d, bars, k) }));
const palettes = { scale: ["minor-pentatonic", "E"], rows: [0, 1, 2, 3, 4].map((r) => ({ any: palette(r), scale: palette(r, ["minor-pentatonic", "E"]) })) };
const s2 = shapeOf(4, 4, 2, 16);
const taken = new Set([0, 1, 2, 5, 7, 31]);
const seating = ADDR.map((a) => ({ address: a, start: seatStart(INSTANCE, a), random: randomSeat(INSTANCE, a, s2, taken), row: [0, 1, 2, 3, 4].map((r) => rowSeat(INSTANCE, a, s2, r, taken)) }));

const patterns = { mother: MOTHER, father: FATHER, triplet: TRIPLET, short: SHORT, long: LONG };
const scores = Object.fromEntries(Object.entries(patterns).map(([k, p]) => [k, { shape: [p.shape.n, p.shape.d, p.shape.bars, p.shape.k], cells: p.cells, score: score(p), digest: digest(p) }]));

const sets = [
  { h: 10, owner: ADDR[0], cell: 0, note: "kick" }, { h: 10, owner: ADDR[1], cell: 6, note: "E2" },
  { h: 12, owner: ADDR[0], cell: 0, note: null }, { h: 15, owner: ADDR[2], cell: 24, note: "D4" }, { h: 15, owner: ADDR[1], cell: 6, note: "G2" },
];
const session = { shape: [4, 4, 2, 16], from: 10, to: 16, sets, hex: toHex(encodeSession({ shape: s2, from: 10, to: 16, sets })) };
const credits = [[0, ADDR[0]], [6, ADDR[1]], [24, ADDR[2]]];
const patternBody = { pattern: "mother", credits, hex: toHex(encodePatternBody(MOTHER, new Map(credits))) };

const g = new Prng(42n);
const prng = { seed: 42, u64: Array.from({ length: 6 }, () => g.nextU64().toString()), below: [7, 30, 1000].map((n) => g.below(n)), choose: g.choose(3, 10) };
const refills = [[0, 3, 6, 8, 11], [4, 12], [4, 8]].map((slots, i) => {
  const melody = [["A2", "C3", "D3", "E3"], ["G3"], ["G4", "A4", "B4"]][i];
  const r = new Prng(BigInt(7 + i));
  return { seed: 7 + i, slots, melody, out: refill(slots, melody, r) };
});

const brd = (a, b) => brood(a, b, Prng.fromHash(broodSeed(epochSeed(BLOCK, 1), digest(a), digest(b))));
const kids = (ks) => ks?.map((c) => ({ operator: c.operator, parents: c.parents, digest: digest(c.pattern), score: score(c.pattern) })) ?? null;
const broods = { block: BLOCK, epoch: 1, motherFather: kids(brd(MOTHER, FATHER)), shortLong: kids(brd(SHORT, LONG)), motherTriplet: kids(brd(MOTHER, TRIPLET)) };

const pop = [MOTHER, FATHER, SHORT, LONG, TRIPLET].map((p, i) => ({ digest: digest(p), shape: p.shape, born: i % 2, weight: [5, 2, 9, 1, 3][i] }));
const extra = Array.from({ length: 14 }, (_, i) => patternFrom(S16, [{ [i]: "kick" }, {}, {}, {}, {}]));
const big = [...pop, ...extra.map((p, i) => ({ digest: digest(p), shape: p.shape, born: 0, weight: 1 + (i % 4) }))];
const byDigest = new Map([MOTHER, FATHER, SHORT, LONG, TRIPLET, ...extra].map((p) => [digest(p), p]));
const ep = (popl, e) => { const r = runEpoch(BLOCK, e, popl, byDigest); return { parents: r.parents, children: r.children.map((c) => digest(c.pattern)), culled: r.culled }; };
const epochs = {
  members: big.map((m) => ({ digest: m.digest, shape: [m.shape.n, m.shape.d, m.shape.bars, m.shape.k], born: m.born, weight: m.weight })),
  small: { size: pop.length, epoch: 4, out: ep(pop, 4) },
  big: { size: big.length, epoch: 5, out: ep(big, 5) },
};
const cross = { block: BLOCK, crosser: ADDR[2], children: kids(crossBrood(BLOCK, ADDR[2], MOTHER, FATHER)) };

const out = { note: "Generated by F1R3Beat/client/scripts/make-vectors.mjs; do not edit by hand.", instance: INSTANCE,
  shapes, palettes, seating: { shape: [4, 4, 2, 16], taken: [...taken], seats: seating }, scores, session, patternBody, prng, refills, broods, epochs, cross };
writeFileSync(new URL("../../vectors/beat-vectors.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log("wrote vectors/beat-vectors.json");
