// Random and row seating (design D2), as the environment computes them: start
// at blake2b-256(instance ‖ address) read as a big-endian u32 from its first
// four bytes. Random seating takes the first free cell from start mod 5S in
// index order; row seating the first free cell of the row from step start mod S.
import { blake2b } from "@noble/hashes/blake2b";
import { cellIndex } from "./grid.js";

const utf8 = (s) => new TextEncoder().encode(s);

export function seatStart(instance, address) {
  const h = blake2b(utf8(instance + address), { dkLen: 32 });
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

export function randomSeat(instance, address, shape, taken /* Set of cell indices */) {
  const n = shape.cells;
  const start = seatStart(instance, address) % n;
  for (let t = 0; t < n; t++) if (!taken.has((start + t) % n)) return (start + t) % n;
  return null;
}

export function rowSeat(instance, address, shape, row, taken) {
  const s = shape.steps;
  const start = seatStart(instance, address) % s;
  for (let t = 0; t < s; t++) { const c = cellIndex((start + t) % s, row); if (!taken.has(c)) return c; }
  return null;
}
