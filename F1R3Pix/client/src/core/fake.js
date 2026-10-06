// An in-memory shard that answers as the F1R3Pix environment and the Portal's
// payments domain do, and a bridge onto it per player. Used by the tests and
// by the standalone demo (open the client without ?portal=…). It mirrors
// templates/games/f1r3pix.rho rule for rule; it is not a substitute for
// running the environment on a shard.
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { cellsFor, idxToCell, onBoard, radiusFor, key } from "./hex.js";
import { isColour } from "./colour.js";
import { label, uncbor } from "./envelope.js";
import { seatStart } from "./seating.js";

/** A stand-in for an address: base58-looking text derived from the public key. */
export function fakeAddress(pkHex) {
  const h = blake2b(hexToBytes(pkHex), { dkLen: 20 });
  return "1111" + bytesToHex(h);
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
  const text = new TextDecoder().decode(gcm(K, m.n, aad).decrypt(m.c));
  return { sender: m.s, text };
}

export class FakeShard {
  constructor({ instance = "inst-demo", config = { capacity: 37, seating: "random", palette: null, messageLimit: 2048 }, host } = {}) {
    this.instanceId = instance;
    this.inst = { id: instance, game: "f1r3pix", host: null, status: "lobby", visibility: "unlisted", config, participants: {} };
    this.state = new Map();
    this.height = 1;
    this.ts = 1_700_000_000_000;
    this.balances = {};
    this.profiles = {};
    this.payments = {}; // payer -> [record]
    this.players = {};
    if (host) this.addPlayer(host, { host: true });
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
    if (!c || !Number.isInteger(c.capacity) || c.capacity < 7 || c.capacity > 469 || !["random", "claim"].includes(c.seating)
      || !Number.isInteger(c.messageLimit) || c.messageLimit < 1 || c.messageLimit > 65536) return null;
    if (c.palette !== null && (!Array.isArray(c.palette) || c.palette.length < 1 || c.palette.length > 32 || !c.palette.every(isColour))) return null;
    const radius = radiusFor(c.capacity);
    return { ...c, radius, cells: cellsFor(radius) };
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
    let cell = null;
    if (cfg.seating === "random") {
      if (want !== null) return [false, "this instance seats at random"];
      const start = seatStart(this.instanceId, by);
      for (let t = 0; t < cfg.cells && !cell; t++) {
        const [q, r] = idxToCell((start + t) % cfg.cells);
        if (!this.get(["cell", q, r])) cell = [q, r];
      }
      if (!cell) return [false, "full"];
    } else {
      if (!Array.isArray(want) || want.length !== 2) return [false, "claim seating needs a cell [q, r]"];
      if (!onBoard(want[0], want[1], cfg.radius)) return [false, "off the board"];
      if (this.get(["cell", ...want])) return [false, "taken"];
      cell = want;
    }
    this.put(["seat", by], { cell, pk, at: this.ts, h: this.height });
    this.put(["cell", ...cell], { owner: by, colour: null, at: this.ts, h: this.height, n: 0 });
    return [true, cell];
  }

  paint(by, colour) {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    if (!this.inst.participants[by]) return [false, "join the instance first"];
    if (this.inst.status !== "active") return [false, "the game is not active"];
    if (!isColour(colour) || (cfg.palette && !cfg.palette.includes(colour))) return [false, "colour must be #RRGGBB, upper case, in the palette"];
    const seat = this.get(["seat", by]);
    if (!seat) return [false, "take a seat first"];
    const [q, r] = seat.cell;
    const c = this.get(["cell", q, r]);
    this.put(["cell", q, r], { owner: by, colour, at: this.ts, h: this.height, n: c.n + 1 });
    const hist = this.get(["hist", q, r]) ?? [];
    this.put(["hist", q, r], [...hist, [this.height, this.ts, colour]]);
    return [true, { cell: [q, r], colour, h: this.height }];
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
    if (memo !== null && memo.length > 140) return [false, "memo too long"];
    const seen = new Set();
    for (let i = 0; i < to.length; i++) {
      if (!this.inst.participants[to[i]]) return [false, "every recipient must be a participant"];
      if (to[i] === by) return [false, "you cannot pay yourself"];
      if (seen.has(to[i])) return [false, "recipients must be distinct"];
      if (!Number.isInteger(amounts[i]) || amounts[i] < 1) return [false, "amounts must be positive"];
      seen.add(to[i]);
    }
    const list = this.payments[by] ?? (this.payments[by] = []);
    const results = to.map((a, i) => {
      const ok = this.balances[by] >= amounts[i];
      if (ok) { this.balances[by] -= amounts[i]; this.balances[a] += amounts[i]; }
      list.push({ seq: list.length, to: a, amount: amounts[i], ok, reason: ok ? "" : "Insufficient funds", at: this.ts, h: this.height, memo });
      return { to: a, amount: amounts[i], ok };
    });
    return [true, results];
  }

  // -------------------------------------------------- reads
  board() {
    const cfg = this.cfg();
    if (!cfg) return [false, "bad config"];
    const cells = [];
    for (let i = 0; i < cfg.cells; i++) {
      const [q, r] = idxToCell(i);
      const v = this.get(["cell", q, r]);
      if (v) cells.push({ ...v, q, r, i });
    }
    return [true, { radius: cfg.radius, capacity: cfg.capacity, seating: cfg.seating, palette: cfg.palette, messageLimit: cfg.messageLimit, status: this.inst.status, cells }];
  }
  seats() {
    const m = {};
    for (const a of Object.keys(this.inst.participants)) { const s = this.get(["seat", a]); if (s) m[a] = { cell: s.cell, pk: s.pk }; }
    return [true, m];
  }
  log(from, to) {
    const cfg = this.cfg();
    const out = [];
    for (let i = 0; i < cfg.cells; i++) {
      const [q, r] = idxToCell(i);
      const v = this.get(["cell", q, r]);
      const hist = this.get(["hist", q, r]);
      if (!v || !hist) continue;
      for (const [h, ts, c] of hist) if (h >= from && h < to) out.push([h, ts, v.owner, q, r, c]);
    }
    return [true, out];
  }
  mail(address, cursor = {}) {
    const out = [];
    for (const s of Object.keys(this.inst.participants)) {
      (this.get(["out", s]) ?? []).forEach((m, seq) => {
        if (seq > (cursor[s] ?? -1) && m.to.includes(address)) out.push({ ...m, from: s, seq });
      });
    }
    return [true, out];
  }
  outbox(address, from) {
    return [true, (this.get(["out", address]) ?? []).map((m, seq) => ({ ...m, seq })).filter((m) => m.seq >= from)];
  }
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
    const done = (r) => { if (autoBlock) this.block(); return r; };
    return {
      hello: async () => ({ protocol: 2, address, publicKey: me.pk, profile: this.profiles[address], instance: structuredClone(this.inst) }),
      deploy: async (template, args) => {
        const a = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, plain(v)]));
        const r = { "f1r3pix.seat": () => this.seat(address, a.pk, a.want ?? null),
          "f1r3pix.paint": () => this.paint(address, a.colour),
          "f1r3pix.say": () => this.say(address, a.to, a.envelope) }[template];
        if (!r) throw { code: "refused", message: `unknown template ${template}` };
        const out = r();
        done();
        if (!out[0]) this.lastError = out[1];
        return { deployId: `d${this.height}` };
      },
      read: async (template, args = {}, meta = false) => {
        const a = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, plain(v)]));
        const r = { "f1r3pix.board": () => this.board(), "f1r3pix.seats": () => this.seats(),
          "f1r3pix.log": () => this.log(a.from, a.to), "f1r3pix.mail": () => this.mail(a.address, a.cursor ?? {}),
          "f1r3pix.outbox": () => this.outbox(a.address, a.from ?? 0) }[template];
        if (!r) throw { code: "refused", message: `unknown template ${template}` };
        const value = structuredClone(unwrap(r()));
        return meta ? { value, blockNumber: this.height, blockHash: `b${this.height}` } : value;
      },
      pay: async (to, amounts, memo) => {
        if (onPay && !(await onPay(to, amounts, memo))) throw { code: "declined", message: "not approved" };
        const v = unwrap(this.pay(address, to, amounts, memo));
        done();
        return { deployId: `d${this.height}`, results: v };
      },
      open: async (envHex) => openWith(me.sk, { game: "f1r3pix", instance: this.instanceId, address }, envHex),
      balance: async () => this.balances[address],
      payments: async (cursor) => unwrap(this.paymentsList(cursor)),
      profiles: async (addresses) => Object.fromEntries(addresses.map((a) => [a, this.profiles[a] ?? null])),
      publishPlay: async (kind, header, body) => { this.published = [...(this.published ?? []), { kind, header, body }]; return { playId: `p${this.published.length}` }; },
      linkPlays: async () => true,
      engage: async () => true,
      invite: async () => true,
      on: () => () => {},
    };
  }
}
