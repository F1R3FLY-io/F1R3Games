// Building plays (design D11, §9): a `pattern` is the grid at one block as its
// canonical score, with credits; a `session` is the history of a span of
// blocks. Headers carry a small preview: one byte per cell (255 nothing,
// otherwise an index into `notes`).
import { encodePatternBody, encodeSession, gridAt, toHex } from "./history.js";
import { digest } from "./score.js";

export function preview(pattern) {
  const notes = [];
  const grid = pattern.cells.map((v) => {
    if (!v) return "ff";
    let i = notes.indexOf(v);
    if (i < 0) { notes.push(v); i = notes.length - 1; }
    return i.toString(16).padStart(2, "0");
  }).join("");
  const s = pattern.shape;
  return { shape: { n: s.n, d: s.d, bars: s.bars, k: s.k }, notes, grid };
}

export function buildPattern({ pattern, credits = new Map(), title, tempo, origin = "game", parents = [], operator = null, seed = null, instance = null, blockHash = null }) {
  const s = pattern.shape;
  const header = {
    title, digest: digest(pattern), meter: [s.n, s.d], column: s.k, bars: s.bars, steps: s.steps, tempo, origin,
    ...(parents.length ? { parents } : {}), ...(operator ? { operator } : {}), ...(seed ? { seed } : {}),
    ...(instance ? { instance } : {}), ...(blockHash ? { blockHash } : {}),
    preview: { ...preview(pattern), text: `${s.n}/${s.d} · ${s.bars} bar${s.bars > 1 ? "s" : ""} · 1/${s.k} · ${pattern.cells.filter(Boolean).length} notes` },
  };
  return { header, bodyHex: toHex(encodePatternBody(pattern, credits)) };
}

export function buildSession({ shape, sets, from, to, title, blockHash, players, base = new Map() }) {
  const span = sets.filter((x) => x.h >= from && x.h < to);
  const body = encodeSession({ shape, from, to, sets: span });
  const final = gridAt(sets.filter((x) => x.h < to), Infinity, base);
  const cells = Array.from({ length: shape.cells }, (_, c) => final.get(c) ?? null);
  const header = {
    title, span: [from, to], blockHash: blockHash ?? "", meter: [shape.n, shape.d], column: shape.k, bars: shape.bars, players, sets: span.length,
    preview: { ...preview({ shape, cells }), text: `${players} players · ${span.length} changes · blocks ${from}–${to - 1}` },
  };
  return { header, bodyHex: toHex(body), final: { shape, cells } };
}
