// Sealed message envelopes (design §6.2). The client seals with public keys
// only; the Portal wallet opens (crates/wallet/src/envelope.rs).
//
//   K random 32 bytes; (e, E) ephemeral secp256k1; E compressed (33 bytes)
//   label = utf8(game + "/msg/v1") ‖ utf8(instance)
//   C = AES-256-GCM_K(n0, plaintext, aad = label ‖ utf8(sender))
//   for each recipient j (and the sender): Z_j = x(e·P_j),
//     W_j = HKDF-SHA-256(ikm Z_j, salt E, info label, 32),
//     wrap_j = AES-256-GCM_{W_j}(n_j, K)
//   envelope = canonical CBOR {c: C, e: E, n: n0, s: sender, v: 1, w: [[address, n_j, wrap_j], ...]}
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/hashes/utils";

const enc = new TextEncoder();
const concat = (...as) => { const out = new Uint8Array(as.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of as) { out.set(a, i); i += a.length; } return out; };
export const label = (game, instance) => concat(enc.encode(`${game}/msg/v1`), enc.encode(instance));
const hexBytes = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/**
 * seal({game, instance, sender: {address, pk}, recipients: [{address, pk}], text})
 * pk: hex of the SEC1 public key (uncompressed, as `seats` records it).
 * `fixed` (tests only) supplies ephemeral, contentKey and nonces.
 */
export function seal({ game, instance, sender, recipients, text }, fixed = {}) {
  const parties = [...recipients.filter((r) => r.address !== sender.address), sender];
  const eph = fixed.ephemeral ?? secp256k1.utils.randomPrivateKey();
  const E = secp256k1.getPublicKey(eph, true);
  const K = fixed.contentKey ?? randomBytes(32);
  const nonces = fixed.nonces ?? parties.map(() => randomBytes(12));
  const n0 = fixed.n0 ?? randomBytes(12);
  const L = label(game, instance);
  const C = gcm(K, n0, concat(L, enc.encode(sender.address))).encrypt(enc.encode(text));
  const w = parties.map((p, j) => {
    const Z = secp256k1.getSharedSecret(eph, hexBytes(p.pk), true).slice(1);
    const W = hkdf(sha256, Z, E, L, 32);
    return [p.address, nonces[j], gcm(W, nonces[j]).encrypt(K)];
  });
  return cbor({ c: C, e: E, n: n0, s: sender.address, v: 1, w });
}

/** Read the public fields (sender, recipients) without opening. */
export function inspect(bytes) {
  const m = uncbor(bytes);
  if (m.v !== 1) throw new Error("unknown envelope version");
  return { sender: m.s, recipients: m.w.map((x) => x[0]) };
}

// ---------------------------------------------------------------- minimal canonical CBOR
// Unsigned ints, byte strings, text strings, arrays, and maps with text keys
// (sorted by length, then bytes) — all the envelope needs.

function head(major, n, out) {
  if (n < 24) out.push((major << 5) | n);
  else if (n < 256) out.push((major << 5) | 24, n);
  else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
  else out.push((major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
}

export function cbor(v) {
  const out = [];
  const go = (x) => {
    if (Number.isInteger(x) && x >= 0) head(0, x, out);
    else if (x instanceof Uint8Array) { head(2, x.length, out); out.push(...x); }
    else if (typeof x === "string") { const b = enc.encode(x); head(3, b.length, out); out.push(...b); }
    else if (Array.isArray(x)) { head(4, x.length, out); x.forEach(go); }
    else if (x && typeof x === "object") {
      const ks = Object.keys(x).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
      head(5, ks.length, out);
      for (const k of ks) { go(k); go(x[k]); }
    } else throw new Error(`cannot encode ${typeof x}`);
  };
  go(v);
  return Uint8Array.from(out);
}

export function uncbor(bytes) {
  let i = 0;
  const u8 = () => { if (i >= bytes.length) throw new Error("truncated"); return bytes[i++]; };
  const arg = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) return u8();
    if (ai === 25) return (u8() << 8) | u8();
    if (ai === 26) return ((u8() << 24) >>> 0) + (u8() << 16) + (u8() << 8) + u8();
    throw new Error("unsupported length");
  };
  const go = () => {
    const b = u8(), major = b >> 5, n = arg(b & 31);
    switch (major) {
      case 0: return n;
      case 2: { const x = bytes.slice(i, i + n); if (x.length < n) throw new Error("truncated"); i += n; return x; }
      case 3: { const x = bytes.slice(i, i + n); if (x.length < n) throw new Error("truncated"); i += n; return new TextDecoder("utf-8", { fatal: true }).decode(x); }
      case 4: return Array.from({ length: n }, go);
      case 5: { const o = {}; for (let k = 0; k < n; k++) { const key = go(); if (typeof key !== "string") throw new Error("map keys must be text"); o[key] = go(); } return o; }
      default: throw new Error(`unsupported CBOR major type ${major}`);
    }
  };
  const v = go();
  if (i !== bytes.length) throw new Error("trailing bytes");
  return v;
}
