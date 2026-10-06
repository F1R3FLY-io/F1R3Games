// A compact SVG thumbnail of a frame, for the Portal's gallery cards
// (PlayCard renders header.preview.svg). One path per colour, integer
// coordinates, so a full 469-cell board stays a few kilobytes.
import { board, corners, key } from "./hex.js";

export function thumbnail(radius, cells /* Map "q,r" -> colour | null */) {
  const size = 10;
  const ext = Math.ceil(size * Math.sqrt(3) * (radius + 0.5));
  const groups = new Map();
  for (const [q, r] of board(radius)) {
    const k = key(q, r);
    if (!cells.has(k)) continue;
    const c = cells.get(k) ?? "#1E1E1E";
    const d = "M" + corners(q, r, size, 0.94).map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join("L") + "Z";
    groups.set(c, (groups.get(c) ?? "") + d);
  }
  const paths = [...groups].map(([c, d]) => `<path fill="${c}" d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-ext} ${-ext} ${2 * ext} ${2 * ext}"><rect x="${-ext}" y="${-ext}" width="${2 * ext}" height="${2 * ext}" fill="#000"/>${paths}</svg>`;
}
