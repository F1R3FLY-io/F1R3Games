// An in-memory shard that answers as the F1R3Ink environment, the Portal and
// the relay do, and a bridge onto it per player. Used by the tests and by the
// standalone demo (open the client without ?portal=…). It mirrors
// templates/games/f1r3ink.rho rule for rule; it is not a substitute for
// running the environment on a shard (see F1R3Ink/README.md for that check).
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import { label, uncbor, openInkWith } from "./envelope.js";
import { configOk, DEFAULT_CONFIG, handle, sidKey, tagsOk } from "./ink.js";

export function fakeAddress(pkHex) {
  return "1111" + bytesToHex(blake2b(hexToBytes(pkHex), { dkLen: 20 }));
}

/** The wallet's `open`, in JavaScript (tests and demo only; the Portal uses the Rust wallet). */
export function openWith(priv, { game, instance, address }, envHex) {
  const bytes = hexToBytes(envHex);
  const m = uncbor(bytes);
  if (m.v === 2) { const o = openInkWith(priv, { game, instance }, bytes); return { kind: "ink", target: o.target, sid: o.sid, seq: o.seq, colour: o.colour, key: bytesToHex(o.key) }; }
  if (m.v !== 1) throw Object.assign(new Error("unknown envelope version"), { code: "corrupt" });
  const w = m.w.find((x) => x[0] === address);
  if (!w) throw Object.assign(new Error("not addressed to you"), { code: "not-addressed" });
  const L = label(game, instance);
  const Z = secp256k1.getSharedSecret(priv, m.e, true).slice(1);
  const W = hkdf(sha256, Z, m.e, L, 32);
  const K = gcm(W, w[1]).decrypt(w[2]);
  const aad = new Uint8Array([...L, ...new TextEncoder().encode(m.s)]);
  return { sender: m.s, text: new TextDecoder().decode(gcm(K, m.n, aad).decrypt(m.c)) };
}

export const DEMO_CONFIG = { ...DEFAULT_CONFIG, capacity: 12, minInterval: 2000, decay: { unit: 60_000, steps: 10 } };
const bytesOf = (v) => (typeof v === "string" ? v.replace(/^0x/, "") : v?.bytes ?? null);

export class FakeShard {
  constructor({ instance = "inst-demo", config = DEMO_CONFIG, relayWindow = 1 } = {}) {
    this.instanceId = instance;
    this.inst = { id: instance, game: "f1r3ink", host: null, status: "lobby", visibility: "unlisted", config, participants: {} };
    this.state = new Map();
    this.height = 1;
    this.ts = 1_700_000_000_000;
    this.balances = {};
    this.profiles = {};
    this.payments = {};
    this.players = {};
    this.plays = [];
    this.counts = {};
    this.relayAddress = "1111relay";
    this.relaySecret = randomBytes(32);
    this.relayQueue = [];
    this.relayWindow = relayWindow;
    this.put("relay", this.relayAddress);
  }

  addPlayer({ name, priv }, { host = false, balance = 1000 } = {}) {
    const sk = priv ?? secp256k1.utils.randomPrivateKey();
    const pk = bytesToHex(secp256k1.getPublicKey(sk, false));
    const address = fakeAddress(pk);
    this.players[address] = { sk, pk, name };
    this.profiles[address] = { name };
    this.balances[address] = balance;
    this.inst.participants[address] = { role: host ? "host" : "player", joinedAt: this.ts };
    if (host) this.inst.host = address;
    return { address, pk, sk };
  }

  /** A new block: the relay's window may close, then the clock moves. */
  block(ms = 1000) {
    if (this.relayQueue.length && this.height % this.relayWindow === 0) this.flushRelay();
    this.height++;
    this.ts += ms;
  }
  get(k) { const v = this.state.get(JSON.stringify(k)); return v === undefined ? null : structuredClone(v); }
  put(k, v) { this.state.set(JSON.stringify(k), structuredClone(v)); }
  append(k, x) { const l = this.get(k) ?? []; this.put(k, [...l, x]); return l.length; }
  cfg() { return configOk(this.inst.config); }
  isPlayer(a) { return this.inst.participants[a] ? this.get(["p", a]) : null; }
  get roster() { return this.get(["roster"]) ?? []; }

  // -------------------------------------------------- moves, as the environment answers them
  enter(by, pk, flag) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    if (!["public", "private"].includes(flag)) return [false, "a flag is public or private"];
    if (typeof pk !== "string") return [false, "pk must be the caller's public key"];
    if (fakeAddress(pk) !== by) return [false, "public key is not the caller's"];
    const p = this.get(["p", by]);
    if (p) return [true, p];
    if (this.roster.length >= cfg.capacity) return [false, "full"];
    const rec = { pk, flag, tags: [], veil: [], at: [this.height, this.ts] };
    this.put(["p", by], rec);
    this.put(["roster"], [...this.roster, by]);
    this.append(["plog", by], [this.height, this.ts, "flag", flag]);
    return [true, rec];
  }

  tags(by, tags) {
    if (!this.cfg()) return [false, "bad config"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    const p = this.isPlayer(by);
    if (!p) return [false, "enter the game first"];
    if (!tagsOk(tags)) return [false, "at most 12 tags, each 1 to 24 characters"];
    this.put(["p", by], { ...p, tags });
    this.append(["plog", by], [this.height, this.ts, "tags", tags]);
    return [true, tags];
  }

  visibility(by, flag, keys) {
    if (!this.cfg()) return [false, "bad config"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    if (!["public", "private"].includes(flag)) return [false, "a flag is public or private"];
    const p = this.isPlayer(by);
    let ks;
    if (keys === null || (Array.isArray(keys) && keys.length === 0)) ks = [];
    else if (flag === "public" && Array.isArray(keys) && keys.every((k) => Array.isArray(k) && k.length === 3 && Number.isInteger(k[1]) && k[1] >= 1 && bytesOf(k[2])?.length === 64)) ks = keys.map((k) => [k[0], k[1], bytesOf(k[2])]);
    else ks = null;
    if (!p) return [false, "enter the game first"];
    if (ks === null) return [false, "keys are [[sid, seq, 32-byte key], ...], and only when going public"];
    this.put(["p", by], { ...p, flag });
    this.append(["plog", by], [this.height, this.ts, "flag", flag]);
    if (ks.length) this.put(["disc", by], [...(this.get(["disc", by]) ?? []), ...ks]);
    return [true, flag];
  }

  inkOk(cfg, flag, ink) {
    if (ink === null) return [true, ""];
    if (ink && Object.keys(ink).length === 1 && Number.isInteger(ink.c)) {
      if (flag !== "public") return [false, "that flag is private: the ink must be sealed"];
      if (ink.c < 0 || ink.c >= cfg.palette.length) return [false, "not a colour of this round's palette"];
      return [true, ""];
    }
    if (ink && Object.keys(ink).length === 1 && bytesOf(ink.sealed)) {
      if (flag !== "private") return [false, "that flag is public: the ink must be in the clear"];
      if (bytesOf(ink.sealed).length / 2 > 512) return [false, "sealed ink too long"];
      return [true, ""];
    }
    return [false, "an ink is a palette index, a sealed envelope, or Nil"];
  }

  writeStripe(target, sid, by, ink, gap) {
    const k = sidKey(sid);
    const s = this.get(["s", target, k]);
    const stored = ink === null ? null : Number.isInteger(ink.c) ? { c: ink.c } : { sealed: bytesOf(ink.sealed) };
    if (!s) {
      if (ink === null) return [false, "nothing to lift"];
      this.put(["s", target, k], { sid, by, first: [this.height, this.ts], last: [this.height, this.ts], seq: 1, ink: stored });
      this.append(["sh", target, k], [this.height, this.ts, stored]);
      return [true, { sid, seq: 1, h: this.height, t: this.ts }];
    }
    if (this.ts < s.last[1] + gap) return [false, "too soon"];
    this.put(["s", target, k], { ...s, last: [this.height, this.ts], seq: s.seq + 1, ink: stored });
    this.append(["sh", target, k], [this.height, this.ts, stored]);
    return [true, { sid, seq: s.seq + 1, h: this.height, t: this.ts }];
  }

  ink(by, target, ink) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (this.inst.status !== "active") return [false, "the round is not active"];
    if (by === target) return [false, "you cannot ink yourself"];
    const me = this.isPlayer(by), them = this.isPlayer(target);
    if (!me) return [false, "enter the game first"];
    if (!them) return [false, "you can only ink players in this round"];
    const [ok, why] = this.inkOk(cfg, them.flag, ink);
    if (!ok) return [false, why];
    const r = this.writeStripe(target, by, by, ink, cfg.minInterval);
    if (r[0]) { const o = new Set(this.get(["o", by]) ?? []); o.add(target); this.put(["o", by], [...o]); }
    return r;
  }

  veil(by, sids) {
    if (!this.cfg()) return [false, "bad config"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    const p = this.isPlayer(by);
    if (!p) return [false, "enter the game first"];
    if (!Array.isArray(sids) || sids.length > 128) return [false, "sids must be a list of at most 128 stripe ids"];
    this.put(["p", by], { ...p, veil: sids });
    this.append(["plog", by], [this.height, this.ts, "veil", sids]);
    return [true, sids];
  }

  say(by, to, envHex) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    if (!Array.isArray(to) || to.length < 1 || to.length > 64 || new Set(to).size !== to.length || to.includes(by)) return [false, "recipients must be 1 to 64 distinct other players"];
    if (envHex.length / 2 > cfg.messageLimit) return [false, "message too long"];
    if (!to.every((a) => this.get(["p", a]))) return [false, "every recipient must have entered the game"];
    return [true, this.append(["out", by], { to, env: envHex, at: this.ts, h: this.height })];
  }

  close(by) {
    if (this.inst.status !== "closed") return [false, "the round is not closed"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    const at = this.get(["closedAt"]);
    if (at) return [true, at];
    this.put(["closedAt"], [this.height, this.ts]);
    return [true, [this.height, this.ts]];
  }

  relayInk(by, batch) {
    if (by !== this.get("relay")) return [false, "only the relay may write anonymous stripes"];
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (this.inst.status !== "active") return [false, "the round is not active"];
    if (!cfg.anonymous) return [false, "this round does not allow anonymous ink"];
    const n = this.roster.filter((a) => this.inst.participants[a]).length;
    if (n < cfg.anonMin) return [false, "too few players for anonymous ink"];
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 64) return [false, "a batch is a list of 1 to 64 entries"];
    return [true, batch.map((e) => {
      if (!Array.isArray(e) || e.length !== 3 || typeof e[1] !== "string") return [false, "an entry is [target, handle, ink]"];
      const [target, h, ink] = e;
      const them = this.isPlayer(target);
      if (!them) return [false, "not a player in this round"];
      const [ok, why] = this.inkOk(cfg, them.flag, ink);
      if (!ok) return [false, why];
      const r = this.writeStripe(target, ["anon", h], null, ink, cfg.minInterval);
      if (r[0]) { const m = this.get(["o", "relay"]) ?? {}; m[target] = [...new Set([...(m[target] ?? []), h])]; this.put(["o", "relay"], m); }
      return r;
    })];
  }

  relayReveal(by, target, h, address) {
    if (by !== this.get("relay")) return [false, "only the relay may reveal anonymous stripes"];
    if (this.inst.status === "closed") return [false, "the round is closed"];
    const s = this.get(["s", target, `anon:${h}`]);
    if (!s) return [false, "no such stripe"];
    if (s.by) return [true, s.by];
    this.put(["s", target, `anon:${h}`], { ...s, by: address });
    this.append(["rlog"], [this.height, this.ts, target, h, address]);
    return [true, address];
  }

  pay(by, to, amounts, memo) {
    if (this.inst.status === "closed") return [false, "instance is closed"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    if (to.length < 1 || to.length > 64 || to.length !== amounts.length) return [false, "1 to 64 transfers"];
    const seen = new Set();
    for (let i = 0; i < to.length; i++) {
      if (!this.inst.participants[to[i]] || to[i] === by || seen.has(to[i]) || !Number.isInteger(amounts[i]) || amounts[i] < 1) return [false, "bad transfer"];
      seen.add(to[i]);
    }
    const list = this.payments[by] ?? (this.payments[by] = []);
    return [true, to.map((a, i) => {
      const ok = this.balances[by] >= amounts[i];
      if (ok) { this.balances[by] -= amounts[i]; this.balances[a] += amounts[i]; }
      list.push({ seq: list.length, to: a, amount: amounts[i], ok, reason: ok ? "" : "Insufficient funds", at: this.ts, h: this.height, memo });
      return { to: a, amount: amounts[i], ok };
    })];
  }

  // -------------------------------------------------- the relay (design §8)
  relayRequest(inker, op, params) {
    if (!this.inst.participants[inker]) throw { code: "relay", message: "the relay serves only participants of the round" };
    if (op === "handles") {
      return { handles: Object.fromEntries(this.roster.filter((t) => t !== inker).map((t) => [t, handle(this.relaySecret, this.instanceId, t, inker)])) };
    }
    const target = params.target;
    if (typeof target !== "string" || target === inker) throw { code: "relay", message: "a target other than yourself" };
    const h = handle(this.relaySecret, this.instanceId, target, inker);
    if (op === "reveal") {
      const r = this.relayReveal(this.relayAddress, target, h, inker);
      if (!r[0]) throw { code: "relay", message: r[1] };
      return { handle: h, revealed: true };
    }
    if (op !== "ink") throw { code: "relay", message: `unknown op ${op}` };
    const cfg = this.cfg();
    const s = this.get(["s", target, `anon:${h}`]);
    if (s && this.ts < s.last[1] + cfg.minInterval) throw { code: "relay", message: "too soon" };
    this.relayQueue.push([target, h, params.ink ?? null]);
    return { queued: true, handle: h };
  }
  flushRelay() {
    const batch = this.relayQueue.splice(0, 64).sort(() => Math.random() - 0.5);
    this.lastRelayResult = this.relayInk(this.relayAddress, batch);
  }

  // -------------------------------------------------- reads
  playersRead() {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    const players = {};
    for (const a of this.roster) { const p = this.get(["p", a]); if (p) players[a] = { ...p, left: !this.inst.participants[a] }; }
    return [true, { ...cfg, status: this.inst.status, closedAt: this.get(["closedAt"]), relay: this.get("relay"), players }];
  }
  flags() {
    if (!this.cfg()) return [false, "bad config"];
    const stripes = {}, disc = {};
    const add = (b, s) => { (stripes[b] ?? (stripes[b] = [])).push(s); };
    for (const a of this.roster) {
      for (const b of this.get(["o", a]) ?? []) { const s = this.get(["s", b, a]); if (s) add(b, s); }
      const d = this.get(["disc", a]); if (d) disc[a] = d;
    }
    for (const [b, hs] of Object.entries(this.get(["o", "relay"]) ?? {})) for (const h of hs) { const s = this.get(["s", b, `anon:${h}`]); if (s) add(b, s); }
    return [true, { stripes, disc }];
  }
  history(target, sid, from) {
    const l = this.get(["sh", target, sidKey(sid)]) ?? [];
    if (!Number.isInteger(from) || from < 0 || from > l.length) return [false, "from is out of range"];
    return [true, { size: l.length, entries: l.slice(from, from + 256).map((e) => (e[2] === null ? e.slice(0, 2) : e)) }];
  }
  log(from, to) {
    const [, f] = this.flags();
    const out = [];
    for (const [b, ss] of Object.entries(f.stripes)) for (const s of ss) {
      for (const [h, t, v] of this.get(["sh", b, sidKey(s.sid)]) ?? []) if (h >= from && h < to) out.push(v === null ? [h, t, "ink", b, s.sid] : [h, t, "ink", b, s.sid, v]);
    }
    for (const a of this.roster) for (const [h, t, kind, v] of this.get(["plog", a]) ?? []) if (h >= from && h < to) out.push([h, t, kind, a, v]);
    for (const [h, t, b, hd, a] of this.get(["rlog"]) ?? []) if (h >= from && h < to) out.push([h, t, "reveal", b, hd, a]);
    return [true, out];
  }
  mail(address, cursor = {}) {
    const out = [];
    for (const s of Object.keys(this.inst.participants)) (this.get(["out", s]) ?? []).forEach((m, seq) => { if (seq > (cursor[s] ?? -1) && m.to.includes(address)) out.push({ ...m, from: s, seq }); });
    return [true, out];
  }
  outbox(address, from) { return [true, (this.get(["out", address]) ?? []).map((m, seq) => ({ ...m, seq })).filter((m) => m.seq >= from)]; }
  paymentsList(cursor = {}) {
    const out = [];
    for (const [p, list] of Object.entries(this.payments)) for (const x of list) if (x.seq > (cursor[p] ?? -1)) out.push({ ...x, from: p });
    return [true, out];
  }

  /** A bridge onto this shard for one player: the host protocol as the Portal answers it. */
  bridge(address, { autoBlock = true, onPay } = {}) {
    const me = this.players[address];
    const unwrap = ([ok, v]) => { if (!ok) throw { code: "refused", message: v }; return v; };
    const plain = (v) => (!v || typeof v !== "object" || Array.isArray(v) ? (Array.isArray(v) ? v.map(plain) : v) : "map" in v ? Object.fromEntries(Object.entries(v.map).map(([k, x]) => [k, plain(x)])) : "bytes" in v ? v.bytes : v);
    const done = () => { if (autoBlock) this.block(); };
    return {
      hello: async () => ({ protocol: 2, address, publicKey: me.pk, profile: this.profiles[address], instance: structuredClone(this.inst) }),
      deploy: async (template, args) => {
        const a = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, plain(v)]));
        const r = {
          "f1r3ink.enter": () => this.enter(address, a.pk, a.flag), "f1r3ink.tags": () => this.tags(address, a.tags),
          "f1r3ink.visibility": () => this.visibility(address, a.flag, a.keys ?? null), "f1r3ink.ink": () => this.ink(address, a.target, a.ink ?? null),
          "f1r3ink.veil": () => this.veil(address, a.sids), "f1r3ink.say": () => this.say(address, a.to, a.envelope), "f1r3ink.close": () => this.close(address),
        }[template];
        if (!r) throw { code: "refused", message: `unknown template ${template}` };
        const out = r();
        done();
        if (!out[0]) this.lastError = out[1];
        return { deployId: `d${this.height}` };
      },
      read: async (template, args = {}, meta = false) => {
        const a = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, plain(v)]));
        const r = {
          "f1r3ink.players": () => this.playersRead(), "f1r3ink.flags": () => this.flags(), "f1r3ink.history": () => this.history(a.target, a.sid, a.from ?? 0),
          "f1r3ink.log": () => this.log(a.from, a.to), "f1r3ink.mail": () => this.mail(a.address, a.cursor ?? {}), "f1r3ink.outbox": () => this.outbox(a.address, a.from ?? 0),
        }[template];
        if (!r) throw { code: "refused", message: `unknown template ${template}` };
        const value = structuredClone(unwrap(r()));
        return meta ? { value, blockNumber: this.height, blockHash: blockHashAt(this.height), blockTimestamp: this.ts } : value;
      },
      relay: async (op, params = {}) => { const r = this.relayRequest(address, op, params); return structuredClone(r); },
      pay: async (to, amounts, memo) => {
        if (onPay && !(await onPay(to, amounts, memo))) throw { code: "declined", message: "not approved" };
        const v = unwrap(this.pay(address, to, amounts, memo));
        done();
        return { deployId: `d${this.height}`, results: v };
      },
      open: async (envHex) => openWith(me.sk, { game: "f1r3ink", instance: this.instanceId, address }, envHex),
      balance: async () => this.balances[address],
      payments: async (cursor) => unwrap(this.paymentsList(cursor)),
      profiles: async (addresses) => Object.fromEntries(addresses.map((a) => [a, this.profiles[a] ?? null])),
      publishPlay: async (kind, header, body) => {
        const id = `p${this.plays.length + 1}`;
        this.plays.push({ ...header, id, kind, game: "f1r3ink", instance: this.instanceId, authors: [address], createdAt: this.ts, links: [], body });
        done();
        return { playId: id };
      },
      linkPlays: async (id, other) => {
        const p = this.plays.find((x) => x.id === id), o = this.plays.find((x) => x.id === other);
        if (!p || !o) throw { code: "refused", message: "unknown play" };
        p.links.push(other); o.links.push(id);
        return true;
      },
      engage: async (play, kind) => { const c = this.counts[play] ?? (this.counts[play] = {}); c[kind] = (c[kind] ?? 0) + 1; return true; },
      gallery: async (kind) => this.plays.filter((p) => p.kind === kind).map(({ body, ...h }) => structuredClone(h)).reverse(),
      playBody: async (id) => this.plays.find((p) => p.id === id)?.body ?? null,
      counts: async (id) => ({ ...(this.counts[id] ?? {}) }),
      invite: async () => true,
      on: () => () => {},
    };
  }
}

/** A stand-in block hash for height h: 32 bytes, hex. */
export const blockHashAt = (h) => bytesToHex(blake2b(new TextEncoder().encode(`block ${h}`), { dkLen: 32 }));
