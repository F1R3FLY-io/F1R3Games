// The score bridge (design §7): a grid as its canonical F1R3Score score, form
// v2 — a parallel composition of five lines, one per row, each the sequence of
// its notes and rests, every note one column long. A pattern's identity is the
// blake2b-256 of its canonical text. Mirrors crates/games/src/beat.rs.
import { blake2b } from "@noble/hashes/blake2b";
import { ROWS, KIT, cellIndex, midiOf, isKit, noteOk, rowOf, shapeOf } from "./grid.js";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const frac = (num, den) => { const g = gcd(num, den); return den / g === 1 ? `${num / g}` : `${num / g}/${den / g}`; };

/** A pattern: {shape, cells: Array(5S) of note | null}. */
export function makePattern(shape, cells) {
  if (!shape) throw new Error("bad shape");
  if (cells.length !== shape.cells) throw new Error(`expected ${shape.cells} cells`);
  cells.forEach((v, c) => { if (v !== null && !noteOk(rowOf(c), v)) throw new Error(`cell ${c}: ${v} is not in its row's palette`); });
  return { shape, cells: [...cells] };
}

export const silent = (shape) => ({ shape, cells: Array(shape.cells).fill(null) });
export const rowOfPattern = (p, row) => Array.from({ length: p.shape.steps }, (_, t) => p.cells[cellIndex(t, row)]);

/** [pitch | "r", length in columns][] with rests merged. */
export function line(p, row) {
  const out = [];
  let gap = 0;
  for (const v of rowOfPattern(p, row)) {
    if (v) { if (gap) { out.push(["r", gap]); gap = 0; } out.push([v, 1]); }
    else gap++;
  }
  if (gap) out.push(["r", gap]);
  return out;
}

export function score(p) {
  const s = p.shape;
  const lines = ROWS.map((_, r) => line(p, r));
  const used = [...new Set(lines.flat().map(([x]) => x).filter((x) => x !== "r"))];
  const kit = used.filter(isKit).sort((a, b) => midiOf(a) - midiOf(b));
  const pit = used.filter((x) => !isKit(x)).sort((a, b) => midiOf(a) - midiOf(b));
  const lens = [...new Set(lines.flat().map(([, k]) => k))].sort((a, b) => a - b);
  const pd = ["r", ...kit.map((x) => `${x} = ${midiOf(x)}`), ...pit].join(", ");
  const dd = lens.map((k) => `c${k} = ${frac(k, s.k)}`).join(", ");
  let out = `// F1R3Beat pattern, canonical form v2 · meter ${s.n}/${s.d} · bars ${s.bars} · column 1/${s.k} · columns ${s.steps}\n`
    + `score F1R3Beat\nimport std\npitches   { ${pd} }\ndurations { ${dd} }\n`
    + "timbres   { drums = gm(0) on 10, bass = gm(33) on 2, guitar = gm(29) on 3,\n            keys = gm(0) on 4, sax = gm(66) on 5 }\n";
  ROWS.forEach((r, i) => {
    const notes = lines[i].map(([x, k]) => `${x} c${k}`);
    const chunks = [];
    for (let j = 0; j < notes.length; j += 8) chunks.push(notes.slice(j, j + 8).join(", "));
    const lead = i === 0 ? "play " : "   | ";
    const head = `line(base "${r}", ${r})`.padEnd(30);
    out += `${lead}${head}  [ ${chunks.join(",\n" + " ".repeat(lead.length + 32))} ]\n`;
  });
  return out;
}

export const digest = (p) => hex(blake2b(new TextEncoder().encode(score(p)), { dkLen: 32 }));

/** Parse a canonical score; refuses anything that does not re-render to the same text. */
export function parseScore(text) {
  const m = /^\/\/ F1R3Beat pattern, canonical form v2 · meter (\d+)\/(\d+) · bars (\d+) · column 1\/(\d+) · columns (\d+)\n/.exec(text);
  if (!m) throw new Error("not a canonical F1R3Beat score");
  const shape = shapeOf(+m[1], +m[2], +m[3], +m[4]);
  if (!shape) throw new Error("bad shape");
  const cells = Array(shape.cells).fill(null);
  ROWS.forEach((r, i) => {
    const at = text.indexOf(`line(base "${r}", ${r})`);
    if (at < 0) throw new Error("missing line");
    const open = text.indexOf("[ ", at) + 2, close = text.indexOf(" ]", open);
    let t = 0;
    for (const item of text.slice(open, close).split(",")) {
      const [x, c] = item.trim().split(/\s+/);
      const len = Number(c?.slice(1));
      if (!Number.isInteger(len) || len < 1) throw new Error("bad length");
      if (x !== "r") { if (t >= shape.steps) throw new Error("line too long"); cells[cellIndex(t, i)] = x; }
      t += len;
    }
    if (t !== shape.steps) throw new Error("line length");
  });
  const p = makePattern(shape, cells);
  if (score(p) !== text) throw new Error("not in canonical form");
  return p;
}

/** The notes the score denotes, rests excluded: {step, onset (whole notes), row, timbre, note, midi}. */
export function notes(p) {
  const out = [];
  for (let t = 0; t < p.shape.steps; t++) for (let r = 0; r < 5; r++) {
    const v = p.cells[cellIndex(t, r)];
    if (v) out.push({ step: t, onset: t / p.shape.k, row: r, timbre: ROWS[r], note: v, midi: midiOf(v) });
  }
  return out;
}

/** The pattern a grid read shows: every cell's note, seeded or set (null when nothing). */
export function patternOfGrid(shape, cells /* Map c -> {note} */) {
  const out = Array(shape.cells).fill(null);
  for (const [c, v] of cells) if (v?.note) out[c] = v.note;
  return { shape, cells: out };
}

export { KIT };
