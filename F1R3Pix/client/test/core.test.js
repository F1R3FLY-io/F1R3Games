import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { idxToCell, cellToIdx, radiusFor, cellsFor, board, onBoard, distance } from "../src/core/hex.js";
import { seatStart, randomSeat } from "../src/core/seating.js";
import { encodeBody, decodeBody, encodePreview, decodePreview, orderPaints, boardAt, frames, toHex, fromHex } from "../src/core/history.js";
import { seal, inspect, cbor, uncbor } from "../src/core/envelope.js";
import { openWith } from "../src/core/fake.js";
import { planPayment } from "../src/core/amounts.js";
import { isColour, normalise } from "../src/core/colour.js";
import { buildPlay } from "../src/core/publish.js";

const V = JSON.parse(readFileSync(resolve(process.cwd(), "../vectors/pix-vectors.json"), "utf8"));

describe("the board", () => {
  it("indexes every cell of every board exactly once, in rings", () => {
    for (let R = 1; R <= 12; R++) {
      const cells = board(R);
      expect(cells.length).toBe(cellsFor(R));
      expect(new Set(cells.map(String)).size).toBe(cells.length);
      cells.forEach(([q, r], i) => { expect(onBoard(q, r, R)).toBe(true); expect(cellToIdx(q, r)).toBe(i); });
    }
  });
  it("walks ring k from (-k, k) along the six directions", () => {
    expect(board(1)).toEqual([[0, 0], [-1, 1], [0, 1], [1, 0], [1, -1], [0, -1], [-1, 0]]);
    expect(idxToCell(7)).toEqual([-2, 2]);
    for (let i = 1; i < cellsFor(6); i++) {
      const a = idxToCell(i), b = idxToCell(i + 1);
      const sameRing = Math.max(...a.map(Math.abs), Math.abs(a[0] + a[1])) === Math.max(...b.map(Math.abs), Math.abs(b[0] + b[1]));
      if (sameRing) expect(distance(a, b)).toBe(1);
    }
  });
  it("matches the shared vectors", () => {
    V.spiral.forEach((c, i) => expect(idxToCell(i)).toEqual(c));
    for (const [cap, r] of Object.entries(V.radius)) expect(radiusFor(Number(cap))).toBe(r);
  });
  it("refuses capacities outside 7 ..= 469", () => {
    for (const c of [6, 470, 7.5, "61"]) expect(() => radiusFor(c)).toThrow();
  });
});

describe("random seating", () => {
  it("matches the shared vectors", () => {
    for (const s of V.seats) expect(seatStart(s.instance, s.address)).toBe(s.start);
    for (const r of V.random) expect(randomSeat(V.seats[0].instance, r.address, r.radius, new Set(r.taken))).toEqual(r.cell);
  });
  it("never seats two players at one cell and reports a full board", () => {
    const taken = new Set();
    for (let i = 0; i < 7; i++) { const c = randomSeat("inst", `addr${i}`, 1, taken); expect(taken.has(String(c))).toBe(false); taken.add(String(c)); }
    expect(randomSeat("inst", "addr7", 1, taken)).toBeNull();
  });
});

describe("history and the body", () => {
  it("orders by height, then timestamp, then owner, keeping a cell's own order", () => {
    const log = [[5, 2, "b", 0, 0, "#000000"], [5, 2, "b", 0, 0, "#111111"], [3, 9, "c", 1, 0, "#222222"], [5, 1, "z", 1, -1, "#333333"], [5, 2, "a", 0, 1, "#444444"]];
    expect(orderPaints(log).map((p) => p.colour)).toEqual(["#222222", "#333333", "#444444", "#000000", "#111111"]);
  });
  it("encodes the shared vector byte for byte and decodes it back", () => {
    const { radius, from, to, paints, hex } = V.body;
    expect(toHex(encodeBody({ radius, from, to, paints }))).toBe(hex);
    const d = decodeBody(fromHex(hex));
    expect(d.paints).toEqual(paints);
    expect([d.radius, d.from, d.to]).toEqual([radius, from, to]);
  });
  it("spills palettes beyond 254 colours", () => {
    const paints = Array.from({ length: 300 }, (_, i) => ({ h: i, owner: "a", q: 0, r: 0, colour: `#${i.toString(16).padStart(6, "0").toUpperCase()}` }));
    const d = decodeBody(encodeBody({ radius: 1, from: 0, to: 300, paints }));
    expect(d.paints.map((p) => p.colour)).toEqual(paints.map((p) => p.colour));
  });
  it("refuses bodies out of history order, and damaged bodies", () => {
    expect(() => encodeBody({ radius: 1, from: 5, to: 9, paints: [{ h: 4, owner: "a", q: 0, r: 0, colour: "#000000" }] })).toThrow();
    expect(() => decodeBody(fromHex(V.body.hex.slice(0, -2)))).toThrow();
    expect(() => decodeBody(fromHex("00" + V.body.hex.slice(2)))).toThrow();
  });
  it("encodes the preview frame of the shared vector", () => {
    const pv = encodePreview(2, new Map(V.preview.cells));
    expect(pv.frame).toBe(V.preview.frame);
    expect(pv.palette).toEqual(V.preview.palette);
    expect([...decodePreview(pv).cells]).toEqual(expect.arrayContaining(V.preview.cells));
  });
  it("replays frame by block", () => {
    const ps = orderPaints([[1, 0, "a", 0, 0, "#000000"], [3, 0, "a", 0, 0, "#FFFFFF"], [3, 1, "b", 1, 0, "#F3D630"]]);
    expect(frames(ps)).toEqual([1, 3]);
    expect(boardAt(ps, 1).get("0,0")).toBe("#000000");
    expect(boardAt(ps, 3).get("0,0")).toBe("#FFFFFF");
  });
  it("builds a play whose body covers its span and whose preview is the span's last frame", () => {
    const seats = { a: { cell: [0, 0] }, b: { cell: [1, 0] }, c: { cell: [0, 1] } };
    const ps = orderPaints([[1, 0, "a", 0, 0, "#000000"], [4, 0, "b", 1, 0, "#F3D630"], [9, 0, "a", 0, 0, "#FFFFFF"]]);
    const { header, bodyHex } = buildPlay({ radius: 1, seats, paints: ps, from: 2, to: 9, title: "t", blockHash: "bh", players: 3 });
    expect(decodeBody(fromHex(bodyHex)).paints).toHaveLength(1);
    const f = decodePreview(header.preview).cells;
    expect([f.get("0,0"), f.get("1,0"), f.get("0,1")]).toEqual(["#000000", "#F3D630", null]);
    expect(header.preview.svg.startsWith("<svg")).toBe(true);
    expect(header.span).toEqual([2, 9]);
  });
});

describe("envelopes", () => {
  const E = V.envelope;
  it("seals the shared vector deterministically", () => {
    const m = uncbor(fromHex(E.hex));
    expect(Object.keys(m)).toEqual(["c", "e", "n", "s", "v", "w"]);
    expect(toHex(cbor(m))).toBe(E.hex);
    expect(inspect(fromHex(E.hex))).toEqual({ sender: E.sender, recipients: Object.keys(E.keys).slice(1).concat(E.sender) });
  });
  it("opens for every recipient and the sender, and for no one else", () => {
    for (const [address, sk] of Object.entries(E.keys)) {
      expect(openWith(hexToBytes(sk), { game: E.game, instance: E.instance, address }, E.hex)).toEqual({ sender: E.sender, text: E.text });
    }
    const eve = secp256k1.utils.randomPrivateKey();
    expect(() => openWith(eve, { game: E.game, instance: E.instance, address: "1111eve" }, E.hex)).toThrow(/not addressed/);
  });
  it("binds the game and the instance", () => {
    const [address, sk] = Object.entries(E.keys)[1];
    expect(() => openWith(hexToBytes(sk), { game: "f1r3ink", instance: E.instance, address }, E.hex)).toThrow();
    expect(() => openWith(hexToBytes(sk), { game: E.game, instance: "another", address }, E.hex)).toThrow();
  });
  it("seals with fresh randomness each time", () => {
    const sk = secp256k1.utils.randomPrivateKey(), pk = bytesToHex(secp256k1.getPublicKey(sk, false));
    const args = { game: "f1r3pix", instance: "i", sender: { address: "s", pk }, recipients: [{ address: "r", pk }], text: "hi" };
    expect(toHex(seal(args))).not.toBe(toHex(seal(args)));
    expect(openWith(sk, { game: "f1r3pix", instance: "i", address: "r" }, toHex(seal(args))).text).toBe("hi");
  });
});

describe("amounts and colours", () => {
  it("sends each, or splits evenly, and says what it will do", () => {
    expect(planPayment({ mode: "each", amount: 10, recipients: ["a", "b", "c"] })).toMatchObject({ total: 30, line: "10 each to 3 players: 30 F1R3Cap" });
    expect(planPayment({ mode: "split", amount: 30, recipients: ["a", "b", "c"] })).toMatchObject({ total: 30, each: 10, line: "30 split among 3 players: 10 each" });
    expect(planPayment({ mode: "split", amount: 31, recipients: ["a", "b", "c"] })).toMatchObject({ suggestions: [30, 33] });
    expect(planPayment({ mode: "each", amount: 0, recipients: ["a"] }).error).toBeTruthy();
    expect(planPayment({ mode: "each", amount: 5, recipients: [] }).error).toBeTruthy();
  });
  it("normalises colours to #RRGGBB upper case", () => {
    expect(normalise("f3d630")).toBe("#F3D630");
    expect(normalise("#abc")).toBe("#AABBCC");
    expect(normalise("red")).toBeNull();
    expect(isColour("#f3d630")).toBe(false);
  });
});
