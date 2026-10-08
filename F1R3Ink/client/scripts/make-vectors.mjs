// Writes F1R3Ink/vectors/ink-vectors.json from the JavaScript implementation.
// The Rust tests (crates/games/tests/ink.rs, crates/wallet/tests/envelope.rs)
// and the JavaScript tests hold every implementation to these values.
import { writeFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { configOk, DEFAULT_CONFIG, DEFAULT_PALETTE, handle, opacity, remaining } from "../src/core/ink.js";
import { sealInk } from "../src/core/envelope.js";
import { encodeFlag, encodeRound, envelopeHash, orderEvents, toHex } from "../src/core/history.js";

const INSTANCE = "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9011223344556677889900aabbccdd";
const ADDR = ["1111aqq7mDkxjtYmLanT2sPVZ67HcmhMdBwr8wjAhE2B4kVRxJHM7", "1111bJHrH7cK3m8hW4eTyQWU2RjsX8JmGqYbUvVrV7eYV3kNqMPa", "1111cPs1DgpVHU8bwXzvR4gG8tRxE4oD6NQ2c8SxbfTjK9uWzM2E"];
const [A, B, C] = ADDR;

const configs = [
  { config: DEFAULT_CONFIG, ok: true },
  { config: { ...DEFAULT_CONFIG, decay: null }, ok: true },
  { config: { ...DEFAULT_CONFIG, capacity: 2 }, ok: false },
  { config: { ...DEFAULT_CONFIG, capacity: 65 }, ok: false },
  { config: { ...DEFAULT_CONFIG, palette: ["#E6194B"] }, ok: false },
  { config: { ...DEFAULT_CONFIG, palette: ["#E6194B", "#e6194b"] }, ok: false },
  { config: { ...DEFAULT_CONFIG, palette: ["#E6194B", "#E6194B"] }, ok: false },
  { config: { ...DEFAULT_CONFIG, decay: { unit: 999, steps: 24 } }, ok: false },
  { config: { ...DEFAULT_CONFIG, decay: { unit: 1000, steps: 1001 } }, ok: false },
  { config: { ...DEFAULT_CONFIG, anonMin: 2 }, ok: false },
  { config: { ...DEFAULT_CONFIG, extra: 1 }, ok: false },
  { config: (({ reciprocity, ...c }) => c)(DEFAULT_CONFIG), ok: false },
].map((x) => ({ ...x, ok: configOk(x.config) !== null }));

const DAY = { unit: 3_600_000, steps: 24 };
const decay = [[DAY, 0, 0], [DAY, 0, 3_599_999], [DAY, 0, 3_600_000], [DAY, 1000, 1000 + 5.5 * 3_600_000], [DAY, 0, 24 * 3_600_000], [DAY, 0, 99 * 3_600_000],
  [DAY, 5000, 4000], [null, 0, 1e12], [{ unit: 600_000, steps: 12 }, 0, 6_000_000]]
  .map(([d, last, now]) => ({ decay: d, last, now, remaining: remaining(d, last, now), opacity: opacity(d, last, now) }));

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const handles = [[A, B], [B, A], [A, C], [C, A]].map(([t, i]) => ({ target: t, inker: i, handle: handle(hexToBytes(SECRET), INSTANCE, t, i) }));

// Sealed inks with fixed randomness; the parties' private keys are given so Rust can open with each.
const keys = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
const pub = (k) => bytesToHex(secp256k1.getPublicKey(hexToBytes(k), false));
const sealedCase = (target, sid, seq, colour, parties, salt) => {
  const fixed = { ephemeral: hexToBytes(salt.repeat(32)), contentKey: hexToBytes("44".repeat(32)), n0: hexToBytes("55".repeat(12)), nonces: [hexToBytes("66".repeat(12)), hexToBytes("77".repeat(12))] };
  const { bytes, key } = sealInk({ game: "f1r3ink", instance: INSTANCE, target, sid, seq, parties: parties.map((i) => pub(keys[i])), colour }, fixed);
  return { target, sid, seq, colour, parties, envelope: toHex(bytes), key: toHex(key), hash: envelopeHash(toHex(bytes)) };
};
const sealed = [sealedCase(B, A, 1, 5, [1, 0], "88"), sealedCase(B, `anon:${handles[0].handle}`, 3, 0, [1, 2], "99")];

// A round: every event type, out of order on purpose.
const ev = (h, t, x) => ({ h, t, ...x });
const events = [
  ev(4, 1_700_000_004_000, { type: "ink", target: B, sid: A, ink: { sealed: sealed[0].envelope } }),
  ev(3, 1_700_000_003_000, { type: "ink", target: C, sid: A, ink: { c: 2 } }),
  ev(2, 1_700_000_002_000, { type: "tags", player: A, tags: ["calm", "new here"] }),
  ev(2, 1_700_000_002_000, { type: "visibility", player: B, public: false }),
  ev(2, 1_700_000_002_000, { type: "visibility", player: A, public: true }),
  ev(2, 1_700_000_002_000, { type: "visibility", player: C, public: true }),
  ev(5, 1_700_000_005_000, { type: "ink", target: C, sid: `anon:${handles[0].handle}`, ink: { c: 7 } }),
  ev(5, 1_700_000_005_000, { type: "ink", target: C, sid: A, ink: { lifted: true } }),
  ev(6, 1_700_000_004_500, { type: "veil", player: C, sids: [A, `anon:${handles[0].handle}`] }),
  ev(7, 1_700_000_007_000, { type: "reveal", target: C, handle: handles[0].handle, player: B }),
  ev(7, 1_700_000_007_000, { type: "ink", target: B, sid: C, ink: { sealed: sealed[1].envelope, colour: 0 } }),
];
const ordered = orderEvents(events);
const round = { from: 1, to: 9, palette: DEFAULT_PALETTE, decay: DAY, events: ordered };
const roundHex = toHex(encodeRound(round));
const forJson = (e) => (e.type === "ink" && e.ink.sealed ? { ...e, ink: { colour: e.ink.colour ?? null, hash: envelopeHash(e.ink.sealed) } } : e);
const portraitEvents = ordered.filter((e) => (e.type === "ink" || e.type === "reveal" ? e.target === B : e.player === B));
const portraitKeys = [[portraitEvents.findIndex((e) => e.type === "ink" && e.ink.sealed === sealed[0].envelope), sealed[0].key]];
const flagHex = toHex(encodeFlag({ owner: B, round: { from: 1, to: 9, palette: DEFAULT_PALETTE, decay: null, events: portraitEvents }, keys: portraitKeys }));

writeFileSync(new URL("../../vectors/ink-vectors.json", import.meta.url), JSON.stringify({
  note: "Generated by F1R3Ink/client/scripts/make-vectors.mjs; do not edit by hand.",
  instance: INSTANCE, addresses: ADDR, configs, decay, secret: SECRET, handles, keys, sealed,
  order: { shuffled: events.map(forJson), ordered: ordered.map(forJson) },
  round: { from: 1, to: 9, palette: DEFAULT_PALETTE, decay: DAY, hex: roundHex },
  flag: { owner: B, from: 1, to: 9, palette: DEFAULT_PALETTE, decay: null, events: portraitEvents.map(forJson), keys: portraitKeys, hex: flagHex },
}, null, 1) + "\n");
console.log("wrote ../vectors/ink-vectors.json");
