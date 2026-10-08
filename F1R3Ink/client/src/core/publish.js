// Building plays (design D14, §13). A `round` holds only what is already
// public on the chain, so publishing it discloses nothing; a `flag` portrait
// is published only by its owner, and discloses the sealed inks whose keys it
// carries. Headers carry a small preview: each public flag at the span's end.
import { encodeFlag, encodeRound, toHex } from "./history.js";
import { remaining } from "./ink.js";

/**
 * Replay ordered events up to block `upTo` (inclusive): each player's
 * visibility, tags and veil, and each flag's stripes keyed by stripe id
 * ({first: [h, t], last: [h, t], ink, colour, by}).
 */
export function stateAt(events, upTo = Infinity) {
  const players = {}, stripes = {};
  const p = (a) => players[a] ?? (players[a] = { public: false, tags: [], veil: [] });
  for (const e of events) {
    if (e.h > upTo) break;
    if (e.type === "visibility") p(e.player).public = e.public;
    else if (e.type === "tags") p(e.player).tags = e.tags;
    else if (e.type === "veil") p(e.player).veil = e.sids;
    else if (e.type === "ink") {
      p(e.target);
      const f = stripes[e.target] ?? (stripes[e.target] = new Map());
      const s = f.get(e.sid) ?? { first: [e.h, e.t], by: e.sid.startsWith("anon:") ? null : e.sid };
      const colour = e.ink.lifted ? null : Number.isInteger(e.ink.c) ? e.ink.c : Number.isInteger(e.ink.colour) ? e.ink.colour : null;
      f.set(e.sid, { ...s, last: [e.h, e.t], lifted: !!e.ink.lifted, sealed: !e.ink.lifted && !Number.isInteger(e.ink.c), colour });
    } else if (e.type === "reveal") {
      const s = stripes[e.target]?.get(`anon:${e.handle}`);
      if (s) s.by = e.player;
    }
  }
  return { players, stripes };
}

/** Stripes of one flag in location order, as [colour or 255, remaining steps or null]; faded and lifted stripes left out. */
export function frameOf(stripeMap, { decay, now }) {
  return [...(stripeMap ?? new Map()).entries()]
    .sort((a, b) => a[1].first[0] - b[1].first[0] || a[1].first[1] - b[1].first[1] || (a[0] < b[0] ? -1 : 1))
    .filter(([, s]) => !s.lifted && (remaining(decay, s.last[1], now) ?? 1) > 0)
    .map(([, s]) => [s.colour ?? 255, remaining(decay, s.last[1], now)]);
}

/** The header's preview: every public flag at the span's end (veiled stripes drawn without colour). */
export function preview({ events, to, decay, now, palette, names = {} }) {
  const st = stateAt(events, to - 1);
  const flags = Object.entries(st.players)
    .filter(([, v]) => v.public)
    .map(([a, v]) => {
      const veil = new Set(v.veil);
      const m = new Map([...(st.stripes[a] ?? new Map()).entries()].map(([k, s]) => [k, veil.has(k) ? { ...s, colour: null } : s]));
      return { p: a, n: names[a] ?? null, s: frameOf(m, { decay, now }) };
    });
  return { palette, flags, steps: decay?.steps ?? null };
}

export function buildRound({ events, from, to, palette, decay, title, blockHash = "", now, names = {}, players }) {
  const span = events.filter((e) => e.h >= from && e.h < to);
  const body = encodeRound({ from, to, palette, decay, events: span });
  const inks = span.filter((e) => e.type === "ink").length;
  const pv = preview({ events, to, decay, now, palette, names });
  const header = {
    title, span: [from, to], blockHash, players, inks, publicFlags: pv.flags.length, decay: decay ? [decay.unit, decay.steps] : null,
    preview: { ...pv, text: `${players} players · ${inks} inks · ${pv.flags.length} public flags · blocks ${from}–${to - 1}` },
  };
  return { header, bodyHex: toHex(body) };
}

/**
 * A portrait (D14): the owner's own events over a span, with the content
 * keys `keys` (event index → key hex) of the sealed inks it discloses. The
 * header previews the flag at the span's end with those colours.
 */
export function buildFlag({ owner, events, from, to, palette, decay, title, blockHash = "", now, keys = [], name = null }) {
  const span = events.filter((e) => e.h >= from && e.h < to && (e.type === "ink" || e.type === "reveal" ? e.target === owner : e.player === owner));
  const body = encodeFlag({ owner, round: { from, to, palette, decay, events: span }, keys });
  const st = stateAt(span, to - 1);
  const frame = frameOf(st.stripes[owner], { decay, now });
  const header = {
    title, owner, span: [from, to], blockHash, inks: span.filter((e) => e.type === "ink").length, disclosed: keys.length,
    decay: decay ? [decay.unit, decay.steps] : null,
    preview: { palette, flags: [{ p: owner, n: name, s: frame }], steps: decay?.steps ?? null, text: `${frame.length} stripes · ${keys.length} disclosed` },
  };
  return { header, bodyHex: toHex(body) };
}
