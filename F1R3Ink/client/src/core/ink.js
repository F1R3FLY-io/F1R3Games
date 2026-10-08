// F1R3Ink's rules outside the shard (design v1, 8 October 2026): the round's
// configuration, the palette, decay, stripe ids and the relay's handles. The
// environment (templates/games/f1r3ink.rho) and the Rust crate
// (crates/games/src/ink.rs) implement the same rules; all three are held to
// F1R3Ink/vectors/ink-vectors.json.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** The default palette (D4): far apart in hue and lightness; numbers, never names. */
export const DEFAULT_PALETTE = [
  "#E6194B", "#F58231", "#FFE119", "#BFEF45", "#3CB44B", "#42D4F4", "#4363D8", "#911EB4",
  "#F032E6", "#FABED4", "#DCBEFF", "#9A6324", "#800000", "#000075", "#A9A9A9", "#FFFFFF",
];

/** Decay presets (D5). */
export const DECAY_PRESETS = {
  evening: { unit: 600_000, steps: 12, label: "an evening", gone: "2 hours" },
  day: { unit: 3_600_000, steps: 24, label: "a day", gone: "24 hours" },
  week: { unit: 21_600_000, steps: 28, label: "a week", gone: "7 days" },
  season: { unit: 86_400_000, steps: 90, label: "a season", gone: "90 days" },
  never: null,
};

export const DEFAULT_CONFIG = {
  capacity: 24, palette: DEFAULT_PALETTE, decay: { unit: 3_600_000, steps: 24 }, minInterval: 60_000,
  anonymous: true, anonMin: 5, reciprocity: false, messageLimit: 2048,
};

const KEYS = ["anonMin", "anonymous", "capacity", "decay", "messageLimit", "minInterval", "palette", "reciprocity"];
const int = (x) => Number.isSafeInteger(x);
export const colourOk = (c) => typeof c === "string" && /^#[0-9A-F]{6}$/.test(c);

/** The configuration as the environment validates it (R1): exactly these keys, in range, no defaults. Null when bad. */
export function configOk(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const ks = Object.keys(c).sort();
  if (ks.length !== KEYS.length || ks.some((k, i) => k !== KEYS[i])) return null;
  const { capacity, palette, decay, minInterval, anonymous, anonMin, reciprocity, messageLimit } = c;
  if (!int(capacity) || capacity < 3 || capacity > 64 || !int(minInterval) || minInterval < 0 || minInterval > 86_400_000
    || !int(anonMin) || anonMin < 3 || anonMin > 64 || !int(messageLimit) || messageLimit < 1 || messageLimit > 65536
    || typeof anonymous !== "boolean" || typeof reciprocity !== "boolean") return null;
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 32 || new Set(palette).size !== palette.length || !palette.every(colourOk)) return null;
  if (decay !== null) {
    if (!decay || typeof decay !== "object" || Object.keys(decay).length !== 2 || !int(decay.unit) || !int(decay.steps)
      || decay.unit < 1000 || decay.steps < 1 || decay.steps > 1000) return null;
  }
  return { capacity, palette, decay: decay ? { unit: decay.unit, steps: decay.steps } : null, minInterval, anonymous, anonMin, reciprocity, messageLimit };
}

/** Steps of opacity left (D5): k − ⌊(now − last)/u⌋, at least 0; null without decay. */
export function remaining(decay, last, now) {
  if (!decay) return null;
  const elapsed = Math.max(0, now - last);
  return Math.max(0, decay.steps - Math.floor(elapsed / decay.unit));
}

/** Opacity α ∈ [0, 1]. */
export function opacity(decay, last, now) {
  const r = remaining(decay, last, now);
  return r === null ? 1 : r / decay.steps;
}

/** A stripe id as the chain writes it (an address, or ["anon", handle]) → its key ("address" or "anon:<handle>"). */
export function sidKey(sid) {
  if (typeof sid === "string") return sid;
  if (Array.isArray(sid) && sid[0] === "anon" && typeof sid[1] === "string") return `anon:${sid[1]}`;
  throw new Error("bad stripe id");
}
/** A key back to the chain's form. */
export const sidOf = (key) => (key.startsWith("anon:") ? ["anon", key.slice(5)] : key);
export const isAnon = (key) => key.startsWith("anon:");

const enc = new TextEncoder();
/** The relay's handle for inker's stripe on target (design §8). */
export function handle(secret, instance, target, inker) {
  const m = new Uint8Array([...enc.encode("f1r3ink/handle/v1"), ...enc.encode(instance), 0, ...enc.encode(target), 0, ...enc.encode(inker)]);
  return bytesToHex(hmac(sha256, secret, m).slice(0, 16));
}

/** Tags as the environment accepts them: at most 12, each 1 to 24 characters, no control characters. */
export function tagsOk(tags) {
  return Array.isArray(tags) && tags.length <= 12 && tags.every((t) => typeof t === "string" && t.length >= 1 && t.length <= 24 && !/[\u0000-\u001f\u007f]/.test(t));
}
export function parseTags(text) {
  return text.split(",").map((t) => t.trim()).filter(Boolean);
}
