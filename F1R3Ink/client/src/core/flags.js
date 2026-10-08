// What a viewer sees of each flag (design §3.3, D1, D8, D15) and the two
// aggregate views (§12, D13). Framework-free: the game model feeds it the
// chain's records, the colours the wallet opened, and the clock.
import { opacity, remaining, sidKey } from "./ink.js";

/** Stripes in location order: first ink's block, then its time, then stripe id. */
export function locationOrder(stripes) {
  return [...stripes].sort((a, b) => a.first[0] - b.first[0] || a.first[1] - b.first[1] || (sidKey(a.sid) < sidKey(b.sid) ? -1 : 1));
}

/**
 * May `viewer` see `target`'s flag in full? Its owner always may; anyone may
 * see a public flag, unless the round asks to "show to see" (D8) and the
 * viewer's own flag is private.
 */
export function seesFull({ viewer, target, players, reciprocity }) {
  if (viewer === target) return true;
  if (players[target]?.flag !== "public") return false;
  if (!reciprocity) return true;
  return players[viewer]?.flag === "public";
}

/**
 * The stripes `viewer` sees on `target`, in location order:
 *   {key, by, anon, mine, colour (index or null), sealed, lifted, veiled, alpha, remaining}
 * `colours` maps "target|sid|seq" to an opened or disclosed colour.
 * Faded and lifted stripes are kept (with alpha 0), so locations stay put;
 * renderers skip them.
 */
export function flagView({ viewer, target, players, stripes, colours = new Map(), mine = new Set(), decay, now, reciprocity = false }) {
  const full = seesFull({ viewer, target, players, reciprocity });
  const veil = new Set((players[target]?.veil ?? []).map(sidKey));
  return locationOrder(stripes[target] ?? [])
    .map((s) => {
      const key = sidKey(s.sid);
      const isMine = key === viewer || mine.has(`${target}|${key}`);
      if (!full && !isMine) return null;
      const ink = s.ink ?? null;
      const lifted = ink === null || ink === undefined;
      const sealed = !lifted && typeof ink.sealed === "string";
      let colour = null;
      if (!lifted && Number.isInteger(ink.c)) colour = ink.c;
      else if (sealed) colour = colours.get(`${target}|${key}|${s.seq}`) ?? null;
      const veiled = veil.has(key) && viewer !== target && !isMine;
      const r = remaining(decay, s.last[1], now);
      return {
        key, by: s.by ?? null, anon: key.startsWith("anon:"), mine: isMine, seq: s.seq, colour: veiled ? null : colour,
        sealed, lifted, veiled, alpha: lifted ? 0 : opacity(decay, s.last[1], now), remaining: r, first: s.first, last: s.last,
      };
    })
    .filter(Boolean);
}

/** Visible, not faded, not lifted: the stripes a renderer draws. */
export const drawn = (view) => view.filter((v) => !v.lifted && v.alpha > 0);

/**
 * The community spectrum (D13): summed opacity per palette colour over every
 * stripe the viewer may see in full or owns — public flags (unless veiled),
 * the viewer's own flag, and the viewer's own stripes. `from` counts the
 * flags it is built from (D8: "14 of 22 flags").
 */
export function spectrum({ viewer, players, stripes, colours, mine, decay, now, reciprocity, palette }) {
  const weights = palette.map(() => 0);
  let built = 0;
  const entered = Object.keys(players).filter((a) => !players[a].left);
  for (const target of entered) {
    const full = seesFull({ viewer, target, players, reciprocity });
    if (full) built++;
    for (const v of flagView({ viewer, target, players, stripes, colours, mine, decay, now, reciprocity })) {
      if (v.colour === null || v.lifted) continue;
      if (v.colour < weights.length) weights[v.colour] += v.alpha;
    }
  }
  const total = weights.reduce((a, b) => a + b, 0);
  return { weights, shares: weights.map((w) => (total ? w / total : 0)), total, from: built, of: entered.length };
}

/** Inks per bucket of `bucketMs` across [start, end), from ordered events; counts every ink, sealed and anonymous too. */
export function volume(events, { start, end, bucketMs }) {
  const n = Math.max(1, Math.ceil((end - start) / bucketMs));
  const out = Array(n).fill(0);
  for (const e of events) if (e.type === "ink" && !e.ink.lifted && e.t >= start && e.t < end) out[Math.min(n - 1, Math.floor((e.t - start) / bucketMs))]++;
  return out;
}

/**
 * One flag over time (D13): at `samples` evenly spaced times from `start` to
 * `end`, the opacity-weighted share of each palette colour on `target`'s flag,
 * replaying its inks in history order. `colourOf(event)` answers a sealed
 * ink's colour when the viewer can know it, else null (it then counts as
 * unknown, in `unknown`).
 */
export function trend(events, { target, start, end, samples = 24, decay, palette, colourOf = () => null }) {
  const mine = events.filter((e) => e.type === "ink" && e.target === target);
  const times = Array.from({ length: samples }, (_, i) => start + ((end - start) * (i + 1)) / samples);
  const state = new Map();
  let j = 0;
  return times.map((t) => {
    while (j < mine.length && mine[j].t <= t) {
      const e = mine[j++];
      if (e.ink.lifted) state.delete(e.sid);
      else state.set(e.sid, { colour: Number.isInteger(e.ink.c) ? e.ink.c : colourOf(e), last: e.t });
    }
    const w = palette.map(() => 0);
    let unknown = 0;
    for (const s of state.values()) {
      const a = opacity(decay, s.last, t);
      if (s.colour === null || s.colour === undefined) unknown += a;
      else if (s.colour < w.length) w[s.colour] += a;
    }
    const total = w.reduce((a, b) => a + b, 0) + unknown;
    return { t, weights: w, unknown, shares: w.map((x) => (total ? x / total : 0)), received: mine.filter((e) => e.t <= t).length };
  });
}
