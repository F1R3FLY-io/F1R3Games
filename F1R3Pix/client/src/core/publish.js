// Building a `canvas` play (design D9, §10): the history of a span of blocks,
// encoded, with the final frame of the span as the header's preview.
import { boardAt, encodeBody, encodePreview, toHex } from "./history.js";
import { thumbnail } from "./thumb.js";

export function buildPlay({ radius, seats, paints, from, to, title, blockHash, players }) {
  const span = paints.filter((p) => p.h >= from && p.h < to);
  const body = encodeBody({ radius, from, to, paints: span });
  // The final frame: every seated cell, painted or not, with all paints up to `to`.
  const frame = new Map();
  for (const s of Object.values(seats)) frame.set(`${s.cell[0]},${s.cell[1]}`, null);
  for (const [k, c] of boardAt(paints.filter((p) => p.h < to))) frame.set(k, c);
  const pv = encodePreview(radius, frame);
  const header = {
    title,
    span: [from, to],
    blockHash: blockHash ?? "",
    radius,
    players,
    paints: span.length,
    preview: { ...pv, svg: thumbnail(radius, frame), text: `${players} players · ${span.length} paints · blocks ${from}–${to - 1}` },
  };
  return { header, bodyHex: toHex(body) };
}
