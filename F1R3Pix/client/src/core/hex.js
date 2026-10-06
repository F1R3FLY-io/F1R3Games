// The board (design §3.2): axial coordinates (q, r), pointy-top hexagons,
// boards of radius R, and the spiral index used for encodings and seating.
// Mirrored in Rust (crates/games/src/pix.rs) and in the environment
// (templates/games/f1r3pix.rho); the shared vectors hold them to each other.

export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const MIN_CAPACITY = 7;
export const MAX_CAPACITY = 469;

export const cellsFor = (radius) => 3 * radius * (radius + 1) + 1;

/** Smallest radius whose board seats `capacity` (7 ..= 469). */
export function radiusFor(capacity) {
  if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
    throw new RangeError(`capacity must be an integer from ${MIN_CAPACITY} to ${MAX_CAPACITY}`);
  }
  let r = 1;
  while (cellsFor(r) < capacity) r++;
  return r;
}

export const ringOf = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
export const onBoard = (q, r, radius) => ringOf(q, r) <= radius;
export const distance = (a, b) => ringOf(a[0] - b[0], a[1] - b[1]);
export const key = (q, r) => `${q},${r}`;

/** Spiral index -> [q, r]. Ring k starts at (-k, k) and walks k steps along each direction. */
export function idxToCell(i) {
  if (!Number.isInteger(i) || i < 0) throw new RangeError("index must be a non-negative integer");
  if (i === 0) return [0, 0];
  let k = 1;
  while (3 * k * (k + 1) < i) k++;
  const j = i - (3 * k * (k - 1) + 1);
  const side = Math.floor(j / k);
  const s = j % k;
  switch (side) {
    case 0: return [-k + s, k];
    case 1: return [s, k - s];
    case 2: return [k, 0 - s];
    case 3: return [k - s, -k];
    case 4: return [0 - s, s - k];
    default: return [-k, s];
  }
}

/** [q, r] -> spiral index. */
export function cellToIdx(q, r) {
  const k = ringOf(q, r);
  if (k === 0) return 0;
  const base = 3 * k * (k - 1) + 1;
  if (r === k && q < 0) return base + (q + k);
  if (q >= 0 && r > 0 && q + r === k) return base + k + q;
  if (q === k && r <= 0) return base + 2 * k - r;
  if (r === -k && q > 0) return base + 3 * k + (k - q);
  if (q + r === -k && q <= 0) return base + 4 * k - q;
  return base + 5 * k + r; // q === -k, 0 <= r < k
}

/** Every cell of the board of radius R, in spiral order. */
export function board(radius) {
  return Array.from({ length: cellsFor(radius) }, (_, i) => idxToCell(i));
}

/** Pixel centre of a pointy-top hexagon of circumradius `size`. */
export function centre(q, r, size) {
  return [size * Math.sqrt(3) * (q + r / 2), size * 1.5 * r];
}

export function corners(q, r, size, shrink = 1) {
  const [cx, cy] = centre(q, r, size);
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return [cx + size * shrink * Math.cos(a), cy + size * shrink * Math.sin(a)];
  });
}
