// An in-memory shard that answers as the F1R3Beat environment and the Portal
// do, and a bridge onto it per player. Used by the tests and by the standalone
// demo (open the client without ?portal=…). It mirrors
// templates/games/f1r3beat.rho rule for rule; it is not a substitute for
// running the environment on a shard.
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { cellIndex, noteOk, shapeOfConfig, SCALES, PITCH_CLASSES } from "./grid.js";
import { label, uncbor } from "./envelope.js";
import { seatStart } from "./seating.js";

export function fakeAddress(pkHex) {
  return "1111" + bytesToHex(blake2b(hexToBytes(pkHex), { dkLen: 20 }));
}

/** The wallet's `open`, in JavaScript (tests and demo only; the Portal uses the Rust wallet). */
export function openWith(priv, { game, instance, address }, envHex) {
  const m = uncbor(hexToBytes(envHex));
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

export const DEMO_CONFIG = { meter: [4, 4], bars: 2, column: [1, 16], capacity: 40, seating: "random", scale: null, tempo: 100, seed: null, messageLimit: 2048 };

export class FakeShard {
  constructor({ instance = "inst-demo", config = DEMO_CONFIG } = {}) {
    this.instanceId = instance;
    this.inst = { id: instance, game: "f1r3beat", host: null, status: "lobby", visibility: "unlisted", config, participants: {} };
    this.state = new Map();
    this.height = 1;
    this.ts = 1_700_000_000_000;
    this.balances = {};
    this.profiles = {};
    this.payments = {};
    this.players = {};
    this.plays = [];
    this.counts = {};
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

  block() { this.height++; this.ts += 1000; }
  get(k) { return this.state.get(JSON.stringify(k)) ?? null; }
  put(k, v) { this.state.set(JSON.stringify(k), v); }

  cfg() {
    const c = this.inst.config;
    const keys = ["meter", "bars", "column", "capacity", "seating", "scale", "tempo", "seed", "messageLimit"];
    if (!c || Object.keys(c).length !== keys.length || !keys.every((k) => k in c)) return null;
    if (!Array.isArray(c.column) || c.column.length !== 2 || c.column[0] !== 1) return null;
    const shape = shapeOfConfig(c);
    if (!shape) return null;
    if (!Number.isInteger(c.capacity) || c.capacity < 1 || c.capacity > shape.cells || !["random", "claim", "row"].includes(c.seating)
      || !Number.isInteger(c.tempo) || c.tempo < 40 || c.tempo > 240 || !Number.isInteger(c.messageLimit) || c.messageLimit < 1 || c.messageLimit > 65536) return null;
    if (c.scale !== null && !(Array.isArray(c.scale) && SCALES[c.scale[0]] && PITCH_CLASSES.includes(c.scale[1]))) return null;
    const seedMap = new Map();
    if (c.seed !== null) {
      const s = c.seed;
      if (!s || typeof s.play !== "string" || typeof s.digest !== "string" || !Array.isArray(s.cells) || s.cells.length > shape.cells) return null;
      for (const [cell, v] of s.cells) {
        if (!Number.isInteger(cell) || cell < 0 || cell >= shape.cells || seedMap.has(cell) || !noteOk(cell % 5, v)) return null;
        seedMap.set(cell, v);
      }
    }
    return { ...c, shape, steps: shape.steps, cells: shape.cells, seedMap };
  }

  seatAt(by, pk, c, cfg) {
    this.put(["seat", by], { cell: c, pk, listen: cfg.tempo, at: this.ts, h: this.height });
    this.put(["cell", c], { owner: by, note: cfg.seedMap.get(c) ?? null, at: this.ts, h: this.height, n: 0 });
    return [true, c];
  }

  // -------------------------------------------------- moves, as the environment answers them
  seat(by, pk, want) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    if (fakeAddress(pk) !== by) return [false, "public key is not the caller's"];
    const seat = this.get(["seat", by]);
    if (seat) return [true, seat.cell];
    const start = seatStart(this.instanceId, by);
    if (cfg.seating === "random") {
      if (want !== null) return [false, "this instance seats at random"];
      for (let t = 0; t < cfg.cells; t++) { const c = (start % cfg.cells + t) % cfg.cells; if (!this.get(["cell", c])) return this.seatAt(by, pk, c, cfg); }
      return [false, "full"];
    }
    if (cfg.seating === "row") {
      if (!Number.isInteger(want) || want < 0 || want > 4) return [false, "row seating needs a row 0 to 4"];
      for (let t = 0; t < cfg.steps; t++) { const c = cellIndex((start % cfg.steps + t) % cfg.steps, want); if (!this.get(["cell", c])) return this.seatAt(by, pk, c, cfg); }
      return [false, "that row is full"];
    }
    if (!Number.isInteger(want)) return [false, "claim seating needs a cell index"];
    if (want < 0 || want >= cfg.cells) return [false, "off the grid"];
    if (this.get(["cell", want])) return [false, "taken"];
    return this.seatAt(by, pk, want, cfg);
  }

  setNote(by, note) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    if (this.inst.status !== "active") return [false, "the game is not active"];
    const seat = this.get(["seat", by]);
    if (!seat) return [false, "take a seat first"];
    const c = seat.cell;
    if (note !== null && !noteOk(c % 5, note, cfg.scale)) return [false, "not in this row's palette"];
    const cell = this.get(["cell", c]);
    this.put(["cell", c], { owner: by, note, at: this.ts, h: this.height, n: cell.n + 1 });
    this.put(["hist", c], [...(this.get(["hist", c]) ?? []), [this.height, this.ts, note]]);
    return [true, { cell: c, note, h: this.height }];
  }

  listen(by, bpm) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    if (!Number.isInteger(bpm)) return [false, "tempo must be a whole number of bpm"];
    if (bpm < 40 || bpm > 240) return [false, "tempo must be 40 to 240 bpm"];
    const seat = this.get(["seat", by]);
    if (!seat) return [false, "take a seat first"];
    this.put(["seat", by], { ...seat, listen: bpm });
    return [true, bpm];
  }

  say(by, to, envHex) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    if (this.inst.status === "closed") return [false, "instance is closed"];
    if (!Array.isArray(to) || to.length < 1 || to.length > 64 || new Set(to).size !== to.length || to.includes(by)) return [false, "recipients must be 1 to 64 distinct other players"];
    if (envHex.length / 2 > cfg.messageLimit) return [false, "message too long"];
    if (!to.every((a) => this.get(["seat", a]))) return [false, "every recipient must be seated"];
    const out = this.get(["out", by]) ?? [];
    this.put(["out", by], [...out, { to, env: envHex, at: this.ts, h: this.height }]);
    return [true, out.length];
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

  // -------------------------------------------------- reads
  grid() {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    const cells = [];
    for (let c = 0; c < cfg.cells; c++) {
      const v = this.get(["cell", c]);
      if (v) cells.push({ ...v, c });
      else if (cfg.seedMap.has(c)) cells.push({ c, note: cfg.seedMap.get(c), seeded: true });
    }
    return [true, { meter: cfg.meter, bars: cfg.bars, column: cfg.column[1], steps: cfg.steps, capacity: cfg.capacity, seating: cfg.seating,
      scale: cfg.scale, tempo: cfg.tempo, messageLimit: cfg.messageLimit, seed: cfg.seed?.play ?? null, status: this.inst.status, cells }];
  }
  seats() {
    const m = {};
    for (const a of Object.keys(this.inst.participants)) { const s = this.get(["seat", a]); if (s) m[a] = { cell: s.cell, pk: s.pk, listen: s.listen }; }
    return [true, m];
  }
  log(from, to) {
    const cfg = this.cfg();
    const out = [];
    for (let c = 0; c < cfg.cells; c++) {
      const v = this.get(["cell", c]), hist = this.get(["hist", c]);
      if (!v || !hist) continue;
      // The node's JSON drops Nil from lists: a set to nothing arrives without its last element.
      for (const [h, ts, note] of hist) if (h >= from && h < to) out.push(note === null ? [h, ts, v.owner, c] : [h, ts, v.owner, c, note]);
    }
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
    const plain = (v) => (!v || typeof v !== "object" || Array.isArray(v) ? v : "map" in v ? v.map : "bytes" in v ? v.bytes : v);
    const done = () => { if (autoBlock) this.block(); };
    return {
      hello: async () => ({ protocol: 2, address, publicKey: me.pk, profile: this.profiles[address], instance: structuredClone(this.inst) }),
      deploy: async (template, args) => {
        const a = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, plain(v)]));
        const r = { "f1r3beat.seat": () => this.seat(address, a.pk, a.want ?? null), "f1r3beat.set": () => this.setNote(address, a.note ?? null),
          "f1r3beat.listen": () => this.listen(address, a.bpm), "f1r3beat.say": () => this.say(address, a.to, a.envelope) }[template];
        if (!r) throw { code: "refused", message: `unknown template ${template}` };
        const out = r();
        done();
        if (!out[0]) this.lastError = out[1];
        return { deployId: `d${this.height}` };
      },
      read: async (template, args = {}, meta = false) => {
        const a = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, plain(v)]));
        const r = { "f1r3beat.grid": () => this.grid(), "f1r3beat.seats": () => this.seats(), "f1r3beat.log": () => this.log(a.from, a.to),
          "f1r3beat.mail": () => this.mail(a.address, a.cursor ?? {}), "f1r3beat.outbox": () => this.outbox(a.address, a.from ?? 0) }[template];
        if (!r) throw { code: "refused", message: `unknown template ${template}` };
        const value = structuredClone(unwrap(r()));
        return meta ? { value, blockNumber: this.height, blockHash: blockHashAt(this.height) } : value;
      },
      pay: async (to, amounts, memo) => {
        if (onPay && !(await onPay(to, amounts, memo))) throw { code: "declined", message: "not approved" };
        const v = unwrap(this.pay(address, to, amounts, memo));
        done();
        return { deployId: `d${this.height}`, results: v };
      },
      open: async (envHex) => openWith(me.sk, { game: "f1r3beat", instance: this.instanceId, address }, envHex),
      balance: async () => this.balances[address],
      payments: async (cursor) => unwrap(this.paymentsList(cursor)),
      profiles: async (addresses) => Object.fromEntries(addresses.map((a) => [a, this.profiles[a] ?? null])),
      publishPlay: async (kind, header, body) => {
        const id = `p${this.plays.length + 1}`;
        this.plays.push({ ...header, id, kind, game: "f1r3beat", instance: this.instanceId, authors: [address], createdAt: this.ts, links: [], body });
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
