// The grid (design v2 §3.2, D4, D5): five rows by S columns; a cell's index is
// c = 5 * step + row. The column, the subdivision of the beat, is fixed at setup
// with the meter and bars; every note lasts one column. Mirrors
// crates/games/src/beat.rs and templates/games/f1r3beat.rho.

export const ROWS = ["drums", "bass", "guitar", "keys", "sax"];
export const MAX_STEPS = 64;
export const COLUMNS = [4, 8, 16, 32, 6, 12, 24];
export const DENOMINATORS = [2, 4, 8, 16];

/** The kit (Table 1), in increasing MIDI order. */
export const KIT = [["kick", 36], ["rim", 37], ["snare", 38], ["clap", 39], ["chh", 42], ["phh", 44],
  ["ltom", 45], ["ohh", 46], ["mtom", 47], ["crash", 49], ["htom", 50], ["ride", 51]];
export const KIT_NAMES = { kick: "bass drum", rim: "side stick", snare: "snare", clap: "hand clap", chh: "closed hi-hat",
  phh: "pedal hi-hat", ltom: "low tom", ohh: "open hi-hat", mtom: "low-mid tom", crash: "crash cymbal", htom: "high tom", ride: "ride cymbal" };
const KIT_MIDI = new Map(KIT);

/** MIDI ranges of the pitched rows; index 0 (drums) is unused. */
export const RANGES = [[0, 0], [28, 55], [40, 76], [36, 84], [44, 75]];
/** [General MIDI program, channel] per row, as the canonical score declares them. */
export const TIMBRES = [[0, 10], [33, 2], [29, 3], [0, 4], [66, 5]];
export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9], "minor-pentatonic": [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** A validated shape {n, d, bars, k, steps, perBar, cells}, or null. */
export function shapeOf(n, d, bars, k) {
  const ok = Number.isInteger(n) && n >= 1 && n <= 32 && DENOMINATORS.includes(d) && COLUMNS.includes(k)
    && Number.isInteger(bars) && bars >= 1 && (n * k) % d === 0;
  if (!ok) return null;
  const perBar = (n * k) / d;
  const steps = bars * perBar;
  if (steps < 1 || steps > MAX_STEPS) return null;
  return { n, d, bars, k, perBar, steps, cells: 5 * steps };
}

/** The shape of a configuration or a grid read ({meter: [n, d], bars, column: [1, k] | k}). */
export function shapeOfConfig(c) {
  const k = Array.isArray(c.column) ? c.column[1] : c.column;
  return shapeOf(c.meter?.[0], c.meter?.[1], c.bars, k);
}

export const species = (s) => `${s.n}/${s.d}@${s.k}`;
export const cellIndex = (step, row) => 5 * step + row;
export const stepOf = (c) => Math.floor(c / 5);
export const rowOf = (c) => c % 5;

/** Distance on the loop as a cylinder (D10). */
export function distance(a, b, steps) {
  const dt = Math.abs(stepOf(a) - stepOf(b));
  return Math.min(dt, steps - dt) + Math.abs(rowOf(a) - rowOf(b));
}

export const midiName = (m) => `${PITCH_CLASSES[m % 12]}${Math.floor(m / 12) - 1}`;
export const isKit = (note) => KIT_MIDI.has(note);

export function midiOf(note) {
  if (KIT_MIDI.has(note)) return KIT_MIDI.get(note);
  if (typeof note !== "string" || note.length < 2) return null;
  const pc = PITCH_CLASSES.indexOf(note.slice(0, -1));
  const oct = Number(note.slice(-1));
  if (pc < 0 || !/^[0-9]$/.test(note.slice(-1))) return null;
  return 12 * (oct + 1) + pc;
}

/** Is `note` in the palette of `row` (D4)? `scale` is null or [kind, tonic]. */
export function noteOk(row, note, scale = null) {
  if (typeof note !== "string") return false;
  if (row === 0) return KIT_MIDI.has(note);
  if (KIT_MIDI.has(note) || note.length < 2 || note.length > 4) return false;
  const m = midiOf(note);
  if (m === null || midiName(m) !== note) return false;
  const [lo, hi] = RANGES[row];
  if (m < lo || m > hi) return false;
  if (!scale) return true;
  const steps = SCALES[scale[0]];
  const t = PITCH_CLASSES.indexOf(scale[1]);
  return !!steps && t >= 0 && steps.includes((m + 12 - t) % 12);
}

/** The palette of a row, in increasing MIDI order. */
export function palette(row, scale = null) {
  if (row === 0) return KIT.map(([k]) => k);
  const [lo, hi] = RANGES[row];
  const out = [];
  for (let m = lo; m <= hi; m++) if (noteOk(row, midiName(m), scale)) out.push(midiName(m));
  return out;
}

export const describeCell = (c) => `${ROWS[rowOf(c)]}, step ${stepOf(c) + 1}`;
