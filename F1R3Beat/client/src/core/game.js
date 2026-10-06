// BeatGame: every operation the client performs, independent of React.
// React renders its snapshots; a f1r3lang page in F1R3Gaze would hold the
// same `bridge` capability and run the same steps (design §8, §13). It
// follows F1R3Pix's PixGame move for move: `set` plays the part of `paint`,
// and `listen` is new.
import { distance, noteOk, rowOf, shapeOfConfig } from "./grid.js";
import { seal } from "./envelope.js";
import { orderSets, decodePatternBody, fromHex } from "./history.js";
import { planPayment } from "./amounts.js";
import { patternOfGrid } from "./score.js";
import { crossBrood } from "./breed.js";
import { buildPattern } from "./publish.js";

const GAME = "f1r3beat";
const bytes = (hex) => ({ bytes: hex });
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const DEFAULT_CONFIG = { meter: [4, 4], bars: 2, column: [1, 16], capacity: 32, seating: "random", scale: null, tempo: 100, seed: null, messageLimit: 2048 };

export class BeatGame {
  constructor(bridge, { instance, pollMs = 3000, now = () => Date.now(), listenDelayMs = 2000 } = {}) {
    this.bridge = bridge;
    this.instanceId = instance;
    this.pollMs = pollMs;
    this.now = now;
    this.listenDelayMs = listenDelayMs;
    this.listeners = new Set();
    this.opened = new Map();
    this.s = {
      phase: "loading", error: null, me: null, instance: null, grid: null, height: 0, blockHash: null,
      seats: {}, names: {}, balance: null, messages: [], payments: [],
      pending: null, queued: null, notice: null, tempo: null,
    };
    this.mailCursor = {};
    this.outCursor = 0;
    this.payCursor = {};
  }

  // ------------------------------------------------------------ observation
  get state() { return this.s; }
  subscribe(f) { this.listeners.add(f); f(this.s); return () => this.listeners.delete(f); }
  set(patch) { this.s = { ...this.s, ...patch }; for (const f of this.listeners) f(this.s); }

  get shape() { return this.s.grid?.shape ?? null; }
  get myCell() { const c = this.s.me ? this.s.seats[this.s.me.address]?.cell : undefined; return c ?? null; }
  get isParticipant() { return !!(this.s.me && this.s.instance?.participants?.[this.s.me.address]); }
  get isHost() { return this.s.me && this.s.instance?.host === this.s.me.address; }
  get status() { return this.s.grid?.status ?? this.s.instance?.status ?? "lobby"; }
  get others() { const me = this.s.me?.address; return Object.keys(this.s.instance?.participants ?? {}).filter((a) => a !== me); }
  get pattern() { return this.s.grid ? patternOfGrid(this.s.grid.shape, this.s.grid.cells) : null; }
  /** The tempo this player hears (D7): local first, then what they last published, then the default. */
  get tempo() { return this.s.tempo ?? this.s.seats[this.s.me?.address]?.listen ?? this.s.grid?.tempo ?? 100; }
  noteOf(c) { return this.s.grid?.cells.get(c)?.note ?? null; }

  /** Other players for the wheel (D10): nearest on the looped grid first, by name, or by recent contact. */
  wheel(order = "near") {
    const mine = this.myCell, steps = this.shape?.steps ?? 1;
    const seat = (a) => this.s.seats[a]?.cell;
    const name = (a) => (this.s.names[a] ?? a).toLowerCase();
    const recent = (a) => Math.max(0, ...this.s.messages.filter((m) => m.from === a || m.to?.includes(a)).map((m) => m.at ?? 0),
      ...this.s.payments.filter((p) => p.from === a || p.to === a).map((p) => p.at ?? 0));
    const list = [...this.others];
    if (order === "name") return list.sort((a, b) => name(a).localeCompare(name(b)));
    if (order === "recent") return list.sort((a, b) => recent(b) - recent(a) || name(a).localeCompare(name(b)));
    return list.sort((a, b) => {
      const da = mine !== null && seat(a) !== undefined ? distance(mine, seat(a), steps) : Infinity;
      const db = mine !== null && seat(b) !== undefined ? distance(mine, seat(b), steps) : Infinity;
      return da - db || name(a).localeCompare(name(b));
    });
  }

  // ------------------------------------------------------------ lifecycle
  async start() {
    try {
      const h = await this.bridge.hello();
      this.set({ me: { address: h.address, publicKey: h.publicKey, profile: h.profile }, instance: h.instance });
      if (!h.instance) throw new Error("unknown instance");
      await this.refresh();
      if (await this.ensureSeat()) await this.refresh();
      this.set({ phase: "ready" });
    } catch (e) {
      this.set({ phase: "error", error: e.message ?? String(e) });
    }
  }
  startPolling() { this.stopPolling(); this.timer = setInterval(() => this.refresh().catch((e) => this.set({ notice: e.message ?? String(e) })), this.pollMs); }
  stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = null; clearTimeout(this.listenTimer); }

  /** Random seating happens on entry; claim and row seating wait for the player's choice. */
  async ensureSeat(want = null) {
    if (!this.isParticipant || this.myCell !== null || this.status === "closed") return null;
    const seating = this.s.grid?.seating;
    if ((seating === "claim" || seating === "row") && want === null) return null;
    const r = await this.bridge.deploy("f1r3beat.seat", { pk: bytes(this.s.me.publicKey), want });
    this.set({ notice: want !== null ? "taking that seat…" : "taking a seat…" });
    return r;
  }

  // ------------------------------------------------------------ reads
  async refresh() {
    const [g, seats, inst] = await Promise.all([
      this.bridge.read("f1r3beat.grid", {}, true),
      this.bridge.read("f1r3beat.seats", {}),
      this.bridge.hello().then((h) => h.instance).catch(() => this.s.instance),
    ]);
    const v = g.value ?? g;
    const shape = shapeOfConfig(v);
    const cells = new Map(v.cells.map((c) => [c.c, { ...c, note: c.note ?? null, owner: c.owner ?? null }]));
    const grid = { ...v, shape, cells, scale: v.scale ?? null };
    const patch = { grid, height: g.blockNumber ?? this.s.height, blockHash: g.blockHash ?? this.s.blockHash, seats: seats ?? {}, instance: inst ?? this.s.instance };
    const mine = this.s.me ? patch.seats[this.s.me.address]?.cell : undefined;
    if (this.s.pending && mine !== undefined) {
      const c = cells.get(mine);
      if (c && (c.note ?? null) === this.s.pending.note && c.n >= this.s.pending.after) patch.pending = null;
    }
    this.set(patch);
    if (!this.s.pending && this.s.queued) { const q = this.s.queued; this.set({ queued: null }); await this.setNote(q.note); }
    await Promise.all([this.refreshNames(), this.refreshMail(), this.refreshPayments(), this.refreshBalance()]);
  }

  async refreshNames() {
    const want = Object.keys(this.s.instance?.participants ?? {}).filter((a) => !(a in this.s.names));
    if (!want.length) return;
    const ps = await this.bridge.profiles(want).catch(() => ({}));
    const names = { ...this.s.names };
    for (const a of want) names[a] = ps?.[a]?.name || short(a);
    this.set({ names });
  }

  async refreshBalance() {
    const b = await this.bridge.balance().catch(() => null);
    if (b !== null && b !== undefined) this.set({ balance: typeof b === "object" ? b.balance ?? null : b });
  }

  async refreshPayments() {
    if (!this.bridge.payments) return;
    const list = await this.bridge.payments(this.payCursor).catch(() => []);
    if (!list?.length) return;
    for (const p of list) this.payCursor[p.from] = Math.max(this.payCursor[p.from] ?? -1, p.seq);
    this.set({ payments: [...this.s.payments, ...list].sort((a, b) => b.h - a.h || b.at - a.at) });
  }

  async refreshMail() {
    if (!this.s.me || !this.isParticipant) return;
    const [inbox, sent] = await Promise.all([
      this.bridge.read("f1r3beat.mail", { address: this.s.me.address, cursor: { map: this.mailCursor } }),
      this.bridge.read("f1r3beat.outbox", { address: this.s.me.address, from: this.outCursor }),
    ]);
    const fresh = [];
    for (const m of inbox ?? []) { this.mailCursor[m.from] = Math.max(this.mailCursor[m.from] ?? -1, m.seq); fresh.push({ ...m }); }
    for (const m of sent ?? []) { this.outCursor = Math.max(this.outCursor, m.seq + 1); fresh.push({ ...m, from: this.s.me.address }); }
    if (!fresh.length) return;
    await Promise.all(fresh.map((m) => this.openOne(m)));
    const seen = new Set(this.s.messages.filter((m) => !m.local).map((m) => `${m.from}:${m.seq}`));
    const keep = this.s.messages.filter((m) => !(m.local && fresh.some((f) => f.from === m.from && f.env === m.env)));
    const merged = [...keep, ...fresh.filter((m) => !seen.has(`${m.from}:${m.seq}`))].map((m) => ({ ...m, ...(this.opened.get(`${m.from}:${m.seq}`) ?? {}) }));
    this.set({ messages: merged.sort((a, b) => (a.h ?? Infinity) - (b.h ?? Infinity) || (a.at ?? 0) - (b.at ?? 0)) });
  }

  async openOne(m) {
    const k = `${m.from}:${m.seq}`;
    if (this.opened.has(k)) return;
    try {
      const r = await this.bridge.open(m.env);
      if (r.sender !== m.from) throw new Error("envelope sender does not match its outbox");
      this.opened.set(k, { text: r.text });
    } catch (e) {
      this.opened.set(k, { error: e.message ?? "could not open" });
    }
  }

  // ------------------------------------------------------------ moves
  /** Set the player's own cell to `note` (or null for nothing). One set in flight; later choices replace a single queued one. */
  async setNote(note) {
    const v = note ?? null;
    if (this.status !== "active") throw new Error("playing opens when the host starts the game");
    const c = this.myCell;
    if (c === null) throw new Error("take a seat first");
    if (v !== null && !noteOk(rowOf(c), v, this.s.grid?.scale ?? null)) throw new Error("that note is not in this row's palette");
    if (this.s.pending) { this.set({ queued: { note: v } }); return { queued: true }; }
    const mine = this.s.grid.cells.get(c);
    this.set({ pending: { note: v, after: (mine?.n ?? 0) + 1, since: this.now() } });
    try {
      return await this.bridge.deploy("f1r3beat.set", { note: v });
    } catch (e) {
      this.set({ pending: null, notice: e.message ?? String(e) });
      throw e;
    }
  }

  /** Change the tempo this player hears (D7): immediate here, published once the control rests. */
  setTempo(bpm) {
    const b = Math.max(40, Math.min(240, Math.round(bpm)));
    this.set({ tempo: b });
    clearTimeout(this.listenTimer);
    if (this.myCell === null || this.status === "closed") return b;
    this.listenTimer = setTimeout(() => {
      this.bridge.deploy("f1r3beat.listen", { bpm: b }).catch((e) => this.set({ notice: e.message ?? String(e) }));
    }, this.listenDelayMs);
    return b;
  }

  async say(text, recipients) {
    const t = text.trim();
    if (!t) throw new Error("write something first");
    const to = recipients.filter((a) => a !== this.s.me.address);
    if (!to.length) throw new Error("select at least one player");
    if (to.some((a) => !this.s.seats[a]?.pk)) throw new Error("messages can go only to seated players");
    const env = seal({ game: GAME, instance: this.instanceId, sender: { address: this.s.me.address, pk: this.s.me.publicKey },
      recipients: to.map((a) => ({ address: a, pk: this.s.seats[a].pk })), text: t });
    const limit = this.s.grid?.messageLimit ?? 2048;
    if (env.length > limit) throw new Error(`that message is ${env.length - limit} bytes over the limit; shorten it or send to fewer players`);
    const envHex = toHex(env);
    const local = { local: true, from: this.s.me.address, to, env: envHex, text: t, at: this.now() };
    this.set({ messages: [...this.s.messages, local] });
    try {
      return await this.bridge.deploy("f1r3beat.say", { to, envelope: bytes(envHex) });
    } catch (e) {
      this.set({ messages: this.s.messages.filter((m) => m !== local), notice: e.message ?? String(e) });
      throw e;
    }
  }

  async pay({ mode, amount, recipients, memo = null }) {
    const plan = planPayment({ mode, amount, recipients });
    if (plan.error) throw Object.assign(new Error(plan.error), { plan });
    if (this.s.balance !== null && plan.total > this.s.balance) throw new Error(`that needs ${plan.total} F1R3Cap; your balance is ${this.s.balance}`);
    const r = await this.bridge.pay(plan.transfers.map((t) => t[0]), plan.transfers.map((t) => t[1]), memo || null);
    this.set({ notice: `payment sent: ${plan.line}` });
    return r;
  }

  // ------------------------------------------------------------ the record and the gallery
  async history(from = 0, to = (this.s.height ?? 0) + 1) {
    return orderSets((await this.bridge.read("f1r3beat.log", { from, to })) ?? []);
  }

  /** Seeded cells no one has taken, as the grid's starting point (D16). */
  get seedBase() {
    const m = new Map();
    for (const [c, v] of this.s.grid?.cells ?? []) if (v.seeded) m.set(c, v.note);
    return m;
  }

  /** Credits for the current pattern: who sits at each sounding cell. */
  credits(pattern = this.pattern) {
    const m = new Map();
    pattern?.cells.forEach((v, c) => { const o = this.s.grid.cells.get(c)?.owner; if (v && o) m.set(c, o); });
    return m;
  }

  async publishPattern(title) {
    const { header, bodyHex } = buildPattern({ pattern: this.pattern, credits: this.credits(), title, tempo: this.tempo, origin: "game",
      ...(this.s.grid.seed ? { parents: [this.s.grid.seed] } : {}), instance: this.instanceId, blockHash: this.s.blockHash });
    const r = await this.bridge.publishPlay("pattern", header, bodyHex);
    if (this.s.grid.seed) await this.bridge.linkPlays(r.playId, this.s.grid.seed).catch(() => {});
    return r;
  }

  /** This game's pattern plays, newest first, with engagement counts. */
  async patterns(days = 14) {
    const list = (await this.bridge.gallery("pattern", days)) ?? [];
    return Promise.all(list.map(async (p) => ({ ...p, counts: (await this.bridge.counts(p.id).catch(() => ({}))) ?? {} })));
  }

  async loadPattern(id) {
    const hex = await this.bridge.playBody(id);
    return decodePatternBody(fromHex(hex.startsWith("0x") ? hex.slice(2) : hex)).pattern;
  }

  /** Cross two gallery patterns (D15): publish the four children, each linked to both parents. */
  async cross(idA, idB) {
    const [a, b] = await Promise.all([this.loadPattern(idA), this.loadPattern(idB)]);
    if (!this.s.blockHash) throw new Error("no block to draw from yet");
    const kids = crossBrood(this.s.blockHash, this.s.me.address, a, b);
    if (!kids) throw new Error("only patterns with the same meter and column can breed");
    const ids = { [kids[0].parents[0]]: idA, [kids[0].parents[1]]: idB };
    const out = [];
    for (const k of kids) {
      const { header, bodyHex } = buildPattern({ pattern: k.pattern, title: `Cross ${k.operator} of ${idA.slice(0, 6)} × ${idB.slice(0, 6)}`, tempo: this.tempo,
        origin: "cross", parents: k.parents.map((d) => ids[d]), operator: k.operator, seed: { block: this.s.blockHash, crosser: this.s.me.address },
        instance: this.instanceId, blockHash: this.s.blockHash });
      const r = await this.bridge.publishPlay("pattern", header, bodyHex);
      for (const p of [idA, idB]) await this.bridge.linkPlays(r.playId, p).catch(() => {});
      out.push(r.playId);
    }
    this.set({ notice: `published ${out.length} crosses` });
    return out;
  }

  engage(play, kind) { return this.bridge.engage(play, kind); }

  get capacityLine() {
    const g = this.s.grid;
    if (!g) return "";
    const s = g.shape;
    return `${Object.keys(this.s.seats).length} of ${g.capacity} seats · ${s.n}/${s.d} · ${s.bars} bar${s.bars > 1 ? "s" : ""} in 1/${s.k}`;
  }
}

export const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
