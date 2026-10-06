// Random seating (design D2), as the environment computes it: start at
// blake2b-256(instance ‖ address) read as a big-endian u32 from its first four
// bytes, modulo the number of cells; take the first free cell in increasing
// spiral order, wrapping. Clients use this only to predict and to check.
import { blake2b } from "@noble/hashes/blake2b";
import { cellsFor, idxToCell } from "./hex.js";

const utf8 = (s) => new TextEncoder().encode(s);

export function seatStart(instance, address) {
  const h = blake2b(utf8(instance + address), { dkLen: 32 });
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

/** The cell random seating gives `address`, or null when the board is full. */
export function randomSeat(instance, address, radius, taken /* Set of "q,r" */) {
  const n = cellsFor(radius);
  const start = seatStart(instance, address) % n;
  for (let t = 0; t < n; t++) {
    const [q, r] = idxToCell((start + t) % n);
    if (!taken.has(`${q},${r}`)) return [q, r];
  }
  return null;
}
