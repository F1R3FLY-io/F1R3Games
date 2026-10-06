// PixGame: every operation the client performs, independent of React.
// React renders its snapshots; a f1r3lang page in F1R3Gaze would hold the
// same `bridge` capability and run the same steps (design §9, §14).
import { cellsFor, distance, key } from "./hex.js";
import { isColour, normalise } from "./colour.js";
import { seal } from "./envelope.js";
import { orderPaints } from "./history.js";
import { planPayment } from "./amounts.js";

const GAME = "f1r3pix";
const bytes = (hex) => ({ bytes: hex });
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const DEFAULT_CONFIG = { capacity: 61, seating: "random", palette: null, messageLimit: 2048 };

export class PixGame {
  constructor(bridge, { instance, pollMs = 3000, now = () => Date.now() } = {}) {
    this.bridge = bridge;
    this.instanceId = instance;
    this.pollMs = pollMs;
    this.now = now;
    this.listeners = new Set();
    this.opened = new Map(); // "from:seq" -> {text} | {error}
    this.s = {
      phase: "loading", error: null, me: null, instance: null, board: null, height: 0,
      seats: {}, names: {}, balance: null, messages: [], payments: [],
      pending: null, queued: null, notice: null,
    };
    this.mailCursor = {};
    this.outCursor = 0;
    this.payCursor = {};
  }

  // ------------------------------------------------------------ observation
  get state() { return this.s; }
  subscribe(f) { this.listeners.add(f); f(this.s); return () => this.listeners.delete(f); }
  set(patch) { this.s = { ...this.s, ...patch }; for (const f of this.listeners) f(this.s); }

  get myCell() { return this.s.me ? this.s.seats[this.s.me.address]?.cell ?? null : null; }
  get isParticipant() { return !!(this.s.me && this.s.instance?.participants?.[this.s.me.address]); }
  get isHost() { return this.s.me && this.s.instance?.host === this.s.me.address; }
  get status() { return this.s.board?.status ?? this.s.instance?.status ?? "lobby"; }
  get others() {
    const me = this.s.me?.address;
    return Object.keys(this.s.instance?.participants ?? {}).filter((a) => a !== me);
  }
  ownerOf(q, r) { return this.s.board?.cells.get(key(q, r))?.owner ?? null; }

  /** Other players for the wheel (D8): nearest on the board first, by name, or by recent contact. */
  wheel(order = "near") {
    const mine = this.myCell;
    const seat = (a) => this.s.seats[a]?.cell;
    const name = (a) => (this.s.names[a] ?? a).toLowerCase();
    const recent = (a) => Math.max(0, ...this.s.messages.filter((m) => m.from === a || m.to?.includes(a)).map((m) => m.at ?? 0),
      ...this.s.payments.filter((p) => p.from === a || p.to === a).map((p) => p.at ?? 0));
    const list = [...this.others];
    if (order === "name") return list.sort((a, b) => name(a).localeCompare(name(b)));
    if (order === "recent") return list.sort((a, b) => recent(b) - recent(a) || name(a).localeCompare(name(b)));
    return list.sort((a, b) => {
      const da = mine && seat(a) ? distance(mine, seat(a)) : Infinity;
      const db = mine && seat(b) ? distance(mine, seat(b)) : Infinity;
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

  startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => this.refresh().catch((e) => this.set({ notice: e.message ?? String(e) })), this.pollMs);
  }
  stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async ensureSeat(want = null) {
    if (!this.isParticipant || this.myCell || this.status === "closed") return null;
    if (this.s.board?.seating === "claim" && !want) return null; // the player picks a free cell
    const r = await this.bridge.deploy("f1r3pix.seat", { pk: bytes(this.s.me.publicKey), want: want ? [want[0], want[1]] : null });
    this.set({ notice: want ? "taking that seat…" : "taking a seat…" });
    return r;
  }

  // ------------------------------------------------------------ reads
  async refresh() {
    const [b, seats, inst] = await Promise.all([
      this.bridge.read("f1r3pix.board", {}, true),
      this.bridge.read("f1r3pix.seats", {}),
      this.bridge.hello().then((h) => h.instance).catch(() => this.s.instance),
    ]);
    const boardV = b.value ?? b;
    const cells = new Map(boardV.cells.map((c) => [key(c.q, c.r), c]));
    const board = { ...boardV, cells };
    const patch = { board, height: b.blockNumber ?? this.s.height, blockHash: b.blockHash ?? this.s.blockHash, seats: seats ?? {}, instance: inst ?? this.s.instance };
    // Settle a pending paint once the board shows it.
    const mine = this.s.me && patch.seats[this.s.me.address]?.cell;
    if (this.s.pending && mine) {
      const c = cells.get(key(mine[0], mine[1]));
      if (c && c.colour === this.s.pending.colour && c.n >= (this.s.pending.after ?? 0)) patch.pending = null;
    }
    this.set(patch);
    if (!this.s.pending && this.s.queued) { const q = this.s.queued; this.set({ queued: null }); await this.paint(q); }
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
    const all = [...this.s.payments, ...list].sort((a, b) => b.h - a.h || b.at - a.at);
    this.set({ payments: all });
  }

  async refreshMail() {
    if (!this.s.me || !this.isParticipant) return;
    const [inbox, sent] = await Promise.all([
      this.bridge.read("f1r3pix.mail", { address: this.s.me.address, cursor: { map: this.mailCursor } }),
      this.bridge.read("f1r3pix.outbox", { address: this.s.me.address, from: this.outCursor }),
    ]);
    const fresh = [];
    for (const m of inbox ?? []) {
      this.mailCursor[m.from] = Math.max(this.mailCursor[m.from] ?? -1, m.seq);
      fresh.push({ ...m });
    }
    for (const m of sent ?? []) {
      this.outCursor = Math.max(this.outCursor, m.seq + 1);
      fresh.push({ ...m, from: this.s.me.address });
    }
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
  /** Paint the player's own cell. One paint in flight; later choices replace a single queued one. */
  async paint(colour) {
    const c = normalise(colour);
    if (!isColour(c)) throw new Error("colour must be #RRGGBB");
    const pal = this.s.board?.palette;
    if (pal && !pal.includes(c)) throw new Error("that colour is not in this game's palette");
    if (this.status !== "active") throw new Error("painting opens when the host starts the game");
    if (!this.myCell) throw new Error("take a seat first");
    if (this.s.pending) { this.set({ queued: c }); return { queued: true }; }
    const mine = this.s.board.cells.get(key(...this.myCell));
    this.set({ pending: { colour: c, after: (mine?.n ?? 0) + 1, since: this.now() } });
    try {
      return await this.bridge.deploy("f1r3pix.paint", { colour: c });
    } catch (e) {
      this.set({ pending: null, notice: e.message ?? String(e) });
      throw e;
    }
  }

  /** Seal `text` to the selected players and the sender, and send it. */
  async say(text, recipients) {
    const t = text.trim();
    if (!t) throw new Error("write something first");
    const to = recipients.filter((a) => a !== this.s.me.address);
    if (!to.length) throw new Error("select at least one player");
    const missing = to.filter((a) => !this.s.seats[a]?.pk);
    if (missing.length) throw new Error("messages can go only to seated players");
    const env = seal({
      game: GAME,
      instance: this.instanceId,
      sender: { address: this.s.me.address, pk: this.s.me.publicKey },
      recipients: to.map((a) => ({ address: a, pk: this.s.seats[a].pk })),
      text: t,
    });
    const limit = this.s.board?.messageLimit ?? 2048;
    if (env.length > limit) throw new Error(`that message is ${env.length - limit} bytes over the limit; shorten it or send to fewer players`);
    const envHex = toHex(env);
    const local = { local: true, from: this.s.me.address, to, env: envHex, text: t, at: this.now() };
    this.set({ messages: [...this.s.messages, local] });
    try {
      return await this.bridge.deploy("f1r3pix.say", { to, envelope: bytes(envHex) });
    } catch (e) {
      this.set({ messages: this.s.messages.filter((m) => m !== local), notice: e.message ?? String(e) });
      throw e;
    }
  }

  /** Ask the Portal for a payment (always prompted there). */
  async pay({ mode, amount, recipients, memo = null }) {
    const plan = planPayment({ mode, amount, recipients });
    if (plan.error) throw Object.assign(new Error(plan.error), { plan });
    if (this.s.balance !== null && plan.total > this.s.balance) throw new Error(`that needs ${plan.total} F1R3Cap; your balance is ${this.s.balance}`);
    const r = await this.bridge.pay(plan.transfers.map((t) => t[0]), plan.transfers.map((t) => t[1]), memo || null);
    this.set({ notice: `payment sent: ${plan.line}` });
    return r;
  }

  // ------------------------------------------------------------ the record
  async history(from = 0, to = (this.s.height ?? 0) + 1) {
    const entries = await this.bridge.read("f1r3pix.log", { from, to });
    return orderPaints(entries ?? []);
  }

  get capacityLine() {
    const b = this.s.board;
    if (!b) return "";
    return `${Object.keys(this.s.seats).length} of ${b.capacity} seats · board of ${cellsFor(b.radius)} cells`;
  }
}

export const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
