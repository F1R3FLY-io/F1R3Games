// InkGame: every operation the client performs, independent of React. React
// renders its snapshots; a f1r3lang page in F1R3Gaze would hold the same
// `bridge` capability and run the same steps (design §11, §16). It follows
// F1R3Pix's PixGame and F1R3Beat's BeatGame move for move: `ink` plays the
// part of `paint`, and entering, tags, visibility, veils and the relay are new.
import { seal, sealInk, openInkWithKey } from "./envelope.js";
import { configOk, isAnon, remaining, sidKey, sidOf, tagsOk } from "./ink.js";
import { eventsOf, orderEvents, envelopeHash, fromHex, toHex, decodeRound, decodeFlag } from "./history.js";
import { flagView, spectrum, trend, volume } from "./flags.js";
import { planPayment } from "./amounts.js";
import { buildFlag, buildRound } from "./publish.js";

const GAME = "f1r3ink";
const bytes = (hex) => ({ bytes: hex });
/** An ink as the environment takes it, typed for the host protocol. */
export const typedInk = (ink) => (ink === null ? null : Number.isInteger(ink.c) ? { map: { c: ink.c } } : { map: { sealed: bytes(ink.sealed) } });

export class InkGame {
  constructor(bridge, { instance, pollMs = 3000, now = () => Date.now(), pendingTimeoutMs = 30_000 } = {}) {
    this.bridge = bridge;
    this.instanceId = instance;
    this.pollMs = pollMs;
    this.clock = now;
    this.pendingTimeoutMs = pendingTimeoutMs;
    this.listeners = new Set();
    this.opened = new Map(); // envelope hash → {colour, key} | {error}
    this.s = {
      phase: "loading", error: null, me: null, instance: null, round: null, players: {}, stripes: {}, disc: {},
      height: 0, blockHash: null, blockTime: null, names: {}, balance: null, messages: [], payments: [],
      colours: new Map(), handles: {}, pending: null, queued: null, notice: null, fresh: {}, events: null,
    };
    this.seen = new Map(); // stripe on me (key) → seq seen
    this.mailCursor = {};
    this.outCursor = 0;
    this.payCursor = {};
    this.closing = false;
  }

  // ------------------------------------------------------------ observation
  get state() { return this.s; }
  subscribe(f) { this.listeners.add(f); f(this.s); return () => this.listeners.delete(f); }
  set(patch) { this.s = { ...this.s, ...patch }; for (const f of this.listeners) f(this.s); }

  get me() { return this.s.me?.address ?? null; }
  get cfg() { return this.s.round; }
  get status() { return this.s.round?.status ?? this.s.instance?.status ?? "lobby"; }
  get isParticipant() { return !!(this.me && this.s.instance?.participants?.[this.me]); }
  get isHost() { return this.me && this.s.instance?.host === this.me; }
  get entered() { return !!(this.me && this.s.players[this.me]); }
  get needsEntry() { return this.isParticipant && !this.entered && this.status !== "closed"; }
  get myFlag() { return this.s.players[this.me]?.flag ?? null; }
  get others() { return Object.keys(this.s.players).filter((a) => a !== this.me); }
  /** The clock decay runs on (D5): the block's time, frozen at the close. */
  get now() {
    const closed = this.s.round?.closedAt;
    if (this.status === "closed" && Array.isArray(closed)) return closed[1];
    return this.s.blockTime ?? this.clock();
  }
  /** My stripes, as "target|sidKey". */
  get mine() {
    const m = new Set();
    for (const [t, ss] of Object.entries(this.s.stripes)) for (const s of ss) if (sidKey(s.sid) === this.me) m.add(`${t}|${this.me}`);
    for (const [t, h] of Object.entries(this.s.handles)) m.add(`${t}|anon:${h}`);
    return m;
  }

  /** My stripe on `target`, if any. */
  myStripe(target) {
    const h = this.s.handles[target];
    return (this.s.stripes[target] ?? []).find((s) => sidKey(s.sid) === this.me || (h && sidKey(s.sid) === `anon:${h}`)) ?? null;
  }

  view(target, viewer = this.me) {
    return flagView({ viewer, target, players: this.s.players, stripes: this.s.stripes, colours: this.s.colours, mine: this.mine,
      decay: this.cfg?.decay ?? null, now: this.now, reciprocity: !!this.cfg?.reciprocity });
  }

  /** Other players for the wheel (D12): most recent interaction first, by name, or newest stripe on you. */
  wheel(order = "recent") {
    const me = this.me;
    const name = (a) => (this.s.names[a] ?? a).toLowerCase();
    const onMe = (a) => Math.max(0, ...(this.s.stripes[me] ?? []).filter((s) => sidKey(s.sid) === a || s.by === a).map((s) => s.last[1]));
    const recent = (a) => Math.max(0, onMe(a), this.myStripe(a)?.last[1] ?? 0,
      ...this.s.messages.filter((m) => m.from === a || m.to?.includes(a)).map((m) => m.at ?? 0),
      ...this.s.payments.filter((p) => p.from === a || p.to === a).map((p) => p.at ?? 0));
    const list = this.others.filter((a) => !this.s.players[a].left);
    const by = (f) => list.sort((a, b) => f(b) - f(a) || name(a).localeCompare(name(b)));
    if (order === "name") return list.sort((a, b) => name(a).localeCompare(name(b)));
    if (order === "newest") return by(onMe);
    return by(recent);
  }

  // ------------------------------------------------------------ lifecycle
  async start() {
    try {
      const h = await this.bridge.hello();
      this.set({ me: { address: h.address, publicKey: h.publicKey, profile: h.profile }, instance: h.instance });
      if (!h.instance) throw new Error("unknown instance");
      await this.refresh();
      this.set({ phase: "ready" });
      await this.loadHandles();
    } catch (e) {
      this.set({ phase: "error", error: e.message ?? String(e) });
    }
  }
  startPolling() { this.stopPolling(); this.timer = setInterval(() => this.refresh().catch((e) => this.set({ notice: e.message ?? String(e) })), this.pollMs); }
  stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The relay's handles for my anonymous stripes (design §8), once. */
  async loadHandles() {
    if (!this.entered || !this.cfg?.anonymous || !this.bridge.relay || !this.cfg?.relay) return;
    try { const r = await this.bridge.relay("handles", {}); this.set({ handles: r?.handles ?? {} }); } catch { /* no relay: anonymous ink unavailable */ }
  }

  // ------------------------------------------------------------ reads
  async refresh() {
    const [p, f, inst] = await Promise.all([
      this.bridge.read("f1r3ink.players", {}, true),
      this.bridge.read("f1r3ink.flags", {}),
      this.bridge.hello().then((h) => h.instance).catch(() => this.s.instance),
    ]);
    const v = p.value ?? p;
    const { players, ...round } = v;
    const patch = {
      round: { ...round, decay: round.decay ?? null, closedAt: round.closedAt ?? null, relay: round.relay ?? null },
      players: players ?? {}, stripes: f?.stripes ?? {}, disc: f?.disc ?? {}, instance: inst ?? this.s.instance,
      height: p.blockNumber ?? this.s.height, blockHash: p.blockHash ?? this.s.blockHash,
      blockTime: p.blockTimestamp ?? this.latestTime(f?.stripes ?? {}) ?? this.s.blockTime,
    };
    const wasEntered = this.entered;
    if (this.s.pending) {
      const mineNow = this.myStripeIn(patch.stripes, this.s.pending.target);
      if ((mineNow?.seq ?? 0) >= this.s.pending.after) patch.pending = null;
      else if (this.clock() - this.s.pending.since > this.pendingTimeoutMs) { patch.pending = null; patch.notice = "that ink did not land; try again"; }
    }
    if (this.s.notice === "entering the round…" && this.me && patch.players[this.me]) patch.notice = null;
    this.set(patch);
    this.noticeFresh();
    if (!wasEntered && this.entered) await this.loadHandles();
    if (!this.s.pending && this.s.queued) { const q = this.s.queued; this.set({ queued: null }); await this.ink(q.target, q.colour, { anonymous: q.anonymous }).catch((e) => this.set({ notice: e.message ?? String(e) })); }
    if (this.status === "closed" && !this.s.round.closedAt && this.isParticipant && !this.closing) {
      this.closing = true;
      this.bridge.deploy("f1r3ink.close", {}).catch(() => { this.closing = false; });
    }
    await Promise.all([this.refreshColours(), this.refreshNames(), this.refreshMail(), this.refreshPayments(), this.refreshBalance()]);
  }

  latestTime(stripes) {
    let t = null;
    for (const ss of Object.values(stripes)) for (const s of ss) t = Math.max(t ?? 0, s.last[1]);
    return t;
  }
  myStripeIn(stripes, target) {
    const h = this.s.handles[target];
    return (stripes[target] ?? []).find((s) => sidKey(s.sid) === this.me || (h && sidKey(s.sid) === `anon:${h}`)) ?? null;
  }

  /** Mark stripes on me that changed since I last looked (badges). */
  noticeFresh() {
    const fresh = { ...this.s.fresh };
    for (const s of this.s.stripes[this.me] ?? []) {
      const k = sidKey(s.sid);
      if (!this.seen.has(k)) { this.seen.set(k, s.seq); continue; }
      if (s.seq > this.seen.get(k)) { fresh[isAnon(k) && !s.by ? "anon" : s.by ?? k] = true; this.seen.set(k, s.seq); }
    }
    this.set({ fresh });
  }
  clearFresh(a) { if (this.s.fresh[a]) { const f = { ...this.s.fresh }; delete f[a]; this.set({ fresh: f }); } }

  /**
   * Colours of sealed stripes the viewer may know: those the wallet opens
   * (stripes on me, and my own stripes), and disclosed ones, checked against
   * their envelopes (design §7).
   */
  async refreshColours() {
    const colours = new Map(this.s.colours);
    const jobs = [];
    for (const [target, ss] of Object.entries(this.s.stripes)) {
      for (const s of ss) {
        const ink = s.ink;
        if (!ink || typeof ink.sealed !== "string") continue;
        const key = sidKey(s.sid), at = `${target}|${key}|${s.seq}`;
        if (colours.has(at)) continue;
        const party = target === this.me || this.mine.has(`${target}|${key}`);
        if (party) jobs.push(this.openSealed(ink.sealed, { target, sid: key, seq: s.seq }).then((o) => { if (o && !o.error) colours.set(at, o.colour); }));
        else {
          const d = (this.s.disc[target] ?? []).find((x) => sidKey(x[0]) === key && x[1] === s.seq);
          if (d) {
            try {
              const o = openInkWithKey({ game: GAME, instance: this.instanceId }, fromHex(ink.sealed), fromHex(d[2]));
              if (o.target === target && o.sid === key && o.seq === s.seq) colours.set(at, o.colour);
            } catch { /* a false disclosure: drawn veiled */ }
          }
        }
      }
    }
    await Promise.all(jobs);
    this.set({ colours });
  }

  /** Open a sealed ink with the wallet, once per envelope, and check where it says it belongs. */
  async openSealed(hex, where = null) {
    const k = envelopeHash(hex);
    if (this.opened.has(k)) return this.opened.get(k);
    let r;
    try {
      const o = await this.bridge.open(hex);
      if (o.kind !== "ink") throw new Error("not a sealed ink");
      if (where && (o.target !== where.target || o.sid !== where.sid || o.seq !== where.seq)) throw new Error("the envelope belongs to another stripe");
      r = { colour: o.colour, key: o.key, target: o.target, sid: o.sid, seq: o.seq };
    } catch (e) {
      r = { error: e.message ?? String(e) };
    }
    this.opened.set(k, r);
    return r;
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
    if (!this.me || !this.isParticipant) return;
    const [inbox, sent] = await Promise.all([
      this.bridge.read("f1r3ink.mail", { address: this.me, cursor: { map: this.mailCursor } }),
      this.bridge.read("f1r3ink.outbox", { address: this.me, from: this.outCursor }),
    ]);
    const fresh = [];
    for (const m of inbox ?? []) { this.mailCursor[m.from] = Math.max(this.mailCursor[m.from] ?? -1, m.seq); fresh.push({ ...m }); }
    for (const m of sent ?? []) { this.outCursor = Math.max(this.outCursor, m.seq + 1); fresh.push({ ...m, from: this.me }); }
    if (!fresh.length) return;
    await Promise.all(fresh.map((m) => this.openMessage(m)));
    const seen = new Set(this.s.messages.filter((m) => !m.local).map((m) => `${m.from}:${m.seq}`));
    const keep = this.s.messages.filter((m) => !(m.local && fresh.some((f) => f.from === m.from && f.env === m.env)));
    const merged = [...keep, ...fresh.filter((m) => !seen.has(`${m.from}:${m.seq}`))].map((m) => ({ ...m, ...(this.opened.get(`msg:${m.from}:${m.seq}`) ?? {}) }));
    this.set({ messages: merged.sort((a, b) => (a.h ?? Infinity) - (b.h ?? Infinity) || (a.at ?? 0) - (b.at ?? 0)) });
  }

  async openMessage(m) {
    const k = `msg:${m.from}:${m.seq}`;
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
  /** Enter the round (D1): the flag's visibility is the player's choice; nothing is preselected. */
  async enter(flag, tags = []) {
    if (!["public", "private"].includes(flag)) throw new Error("choose whether your flag is public or private");
    if (!tagsOk(tags)) throw new Error("at most 12 tags, each 1 to 24 characters");
    if (!this.isParticipant) throw new Error("join the instance first");
    const r = await this.bridge.deploy("f1r3ink.enter", { pk: bytes(this.s.me.publicKey), flag });
    if (tags.length) await this.bridge.deploy("f1r3ink.tags", { tags });
    this.set({ notice: "entering the round…" });
    return r;
  }

  async setTags(tags) {
    if (!tagsOk(tags)) throw new Error("at most 12 tags, each 1 to 24 characters");
    if (!this.entered) throw new Error("enter the round first");
    return this.bridge.deploy("f1r3ink.tags", { tags });
  }

  /**
   * Ink `target` with palette colour `colour`, or lift my stripe (null). The
   * first ink on someone chooses attribution (D2); later inks follow the
   * stripe. One ink in flight; later choices replace a single queued one (D9).
   */
  async ink(target, colour, { anonymous = false } = {}) {
    if (this.status !== "active") throw new Error("inking opens when the host starts the round");
    if (!this.entered) throw new Error("enter the round first");
    if (target === this.me) throw new Error("you cannot ink yourself");
    const them = this.s.players[target];
    if (!them) throw new Error("they have not entered the round");
    if (colour !== null && (!Number.isInteger(colour) || colour < 0 || colour >= this.cfg.palette.length)) throw new Error("not a colour of this round's palette");
    const existing = this.myStripe(target);
    if (colour === null && !existing) throw new Error("nothing to lift");
    const anon = existing ? isAnon(sidKey(existing.sid)) : anonymous;
    if (anon && !existing) {
      if (!this.cfg.anonymous) throw new Error("this round does not allow anonymous ink");
      const n = Object.values(this.s.players).filter((p) => !p.left).length;
      if (n < this.cfg.anonMin) throw new Error(`anonymous ink needs ${this.cfg.anonMin} players in the round`);
      if (!this.s.handles[target]) await this.loadHandles();
      if (!this.s.handles[target]) throw new Error("the relay is not available, so anonymous ink is not either");
    }
    const t = Math.max(this.now, this.clock());
    if (existing && this.cfg.minInterval && t < existing.last[1] + this.cfg.minInterval && !this.s.pending) {
      const wait = Math.ceil((existing.last[1] + this.cfg.minInterval - t) / 1000);
      throw new Error(`you can change this stripe again in ${wait} s`);
    }
    if (this.s.pending) { this.set({ queued: { target, colour, anonymous: anon } }); return { queued: true }; }
    const sid = anon ? `anon:${this.s.handles[target]}` : this.me;
    const seq = (existing?.seq ?? 0) + 1;
    let ink = null;
    if (colour !== null) {
      if (them.flag === "public") ink = { c: colour };
      else ink = { sealed: toHex(sealInk({ game: GAME, instance: this.instanceId, target, sid, seq, parties: [them.pk, this.s.me.publicKey], colour }).bytes) };
    }
    this.set({ pending: { target, colour, after: seq, since: this.clock(), anonymous: anon } });
    try {
      if (anon) return await this.bridge.relay("ink", { target, ink });
      return await this.bridge.deploy("f1r3ink.ink", { target, ink: typedInk(ink) });
    } catch (e) {
      this.set({ pending: null, notice: e.message ?? String(e) });
      throw e;
    }
  }

  /** Refresh my stripe on `target`: the same colour again restarts its decay (D3). */
  async refreshStripe(target) {
    const s = this.myStripe(target);
    if (!s) throw new Error("you have no stripe on them");
    const v = this.view(target).find((x) => x.mine);
    if (!v || v.colour === null) throw new Error("this stripe has no colour to refresh");
    return this.ink(target, v.colour);
  }

  /** Reveal my anonymous stripe on `target` (D2). There is no way back. */
  async reveal(target) {
    const s = this.myStripe(target);
    if (!s || !isAnon(sidKey(s.sid))) throw new Error("you have no anonymous stripe on them");
    return this.bridge.relay("reveal", { target });
  }

  /**
   * Make my flag public or private (D1). Going public discloses the content
   * key of each stripe's current sealed ink on me; earlier history stays sealed.
   */
  async setVisibility(flag) {
    if (!this.entered) throw new Error("enter the round first");
    if (flag === "private") return this.bridge.deploy("f1r3ink.visibility", { flag, keys: null });
    if (flag !== "public") throw new Error("a flag is public or private");
    const keys = [];
    for (const s of this.s.stripes[this.me] ?? []) {
      if (!s.ink || typeof s.ink.sealed !== "string") continue;
      const o = await this.openSealed(s.ink.sealed, { target: this.me, sid: sidKey(s.sid), seq: s.seq });
      if (o.error) throw new Error(`could not open a stripe to disclose it: ${o.error}`);
      keys.push([typeof s.sid === "string" ? s.sid : s.sid, s.seq, bytes(o.key)]);
    }
    return this.bridge.deploy("f1r3ink.visibility", { flag, keys });
  }

  /** Veil stripes on my public flag from other players' view (D15). */
  async setVeil(keys) {
    if (!this.entered) throw new Error("enter the round first");
    return this.bridge.deploy("f1r3ink.veil", { sids: keys.map(sidOf) });
  }

  async say(text, recipients) {
    const t = text.trim();
    if (!t) throw new Error("write something first");
    const to = recipients.filter((a) => a !== this.me);
    if (!to.length) throw new Error("select at least one player");
    if (to.some((a) => !this.s.players[a]?.pk)) throw new Error("messages can go only to players who have entered the round");
    const env = seal({ game: GAME, instance: this.instanceId, sender: { address: this.me, pk: this.s.me.publicKey },
      recipients: to.map((a) => ({ address: a, pk: this.s.players[a].pk })), text: t });
    const limit = this.cfg?.messageLimit ?? 2048;
    if (env.length > limit) throw new Error(`that message is ${env.length - limit} bytes over the limit; shorten it or send to fewer players`);
    const envHex = toHex(env);
    const local = { local: true, from: this.me, to, env: envHex, text: t, at: this.clock() };
    this.set({ messages: [...this.s.messages, local] });
    try {
      return await this.bridge.deploy("f1r3ink.say", { to, envelope: bytes(envHex) });
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

  // ------------------------------------------------------------ history, aggregates and the gallery
  /** A stripe's history (D3): entries newest first, with the colour the viewer may know. */
  async stripeHistory(target, key) {
    const out = [];
    let from = 0, size = Infinity;
    while (from < size) {
      const r = await this.bridge.read("f1r3ink.history", { target, sid: sidOf(key), from });
      size = r.size; out.push(...r.entries); from += r.entries.length;
      if (!r.entries.length) break;
    }
    const party = target === this.me || this.mine.has(`${target}|${key}`);
    const view = this.view(target).find((v) => v.key === key);
    const disc = this.s.disc[target] ?? [];
    const entries = await Promise.all(out.map(async (e, i) => {
      const [h, t, ink] = e;
      const seq = i + 1;
      if (ink === undefined || ink === null) return { h, t, seq, lifted: true, colour: null };
      if (Number.isInteger(ink.c)) return { h, t, seq, colour: view?.veiled ? null : ink.c };
      let colour = null;
      if (party) { const o = await this.openSealed(ink.sealed, { target, sid: key, seq }); if (!o.error) colour = o.colour; }
      else {
        const d = disc.find((x) => sidKey(x[0]) === key && x[1] === seq);
        if (d) try { colour = openInkWithKey({ game: GAME, instance: this.instanceId }, fromHex(ink.sealed), fromHex(d[2])).colour; } catch { /* undisclosed */ }
      }
      return { h, t, seq, sealed: true, colour: view?.veiled ? null : colour };
    }));
    return entries.reverse();
  }

  /** The round's history, in order (sealed colours filled in where this player may know them). */
  async history(from = 0, to = (this.s.height ?? 0) + 1) {
    const events = orderEvents(eventsOf((await this.bridge.read("f1r3ink.log", { from, to })) ?? []));
    const seq = new Map();
    for (const e of events) {
      if (e.type !== "ink") continue;
      const k = `${e.target}|${e.sid}`;
      const n = (seq.get(k) ?? 0) + 1;
      seq.set(k, n);
      e.seq = n;
      if (e.ink.sealed) {
        const at = `${e.target}|${e.sid}|${n}`;
        if (e.target === this.me || this.mine.has(`${e.target}|${e.sid}`)) {
          const o = await this.openSealed(e.ink.sealed, { target: e.target, sid: e.sid, seq: n });
          if (!o.error) { e.ink.colour = o.colour; e.ink.key = o.key; }
        } else if (this.s.colours.has(at)) e.ink.colour = this.s.colours.get(at);
        else {
          const d = (this.s.disc[e.target] ?? []).find((x) => sidKey(x[0]) === e.sid && x[1] === n);
          if (d) try { e.ink.colour = openInkWithKey({ game: GAME, instance: this.instanceId }, fromHex(e.ink.sealed), fromHex(d[2])).colour; } catch { /* undisclosed */ }
        }
      }
    }
    this.set({ events });
    return events;
  }

  spectrum() {
    return spectrum({ viewer: this.me, players: this.s.players, stripes: this.s.stripes, colours: this.s.colours, mine: this.mine,
      decay: this.cfg?.decay ?? null, now: this.now, reciprocity: !!this.cfg?.reciprocity, palette: this.cfg?.palette ?? [] });
  }

  /** Inks per decay unit (or per hour) across the round. */
  volume(events = this.s.events ?? []) {
    if (!events.length) return [];
    const bucketMs = this.cfg?.decay?.unit ?? 3_600_000;
    return volume(events, { start: events[0].t, end: Math.max(this.now, events[events.length - 1].t + 1), bucketMs });
  }

  /** One flag over time (D13); null when the viewer may not see that flag in full. */
  trend(target, events = this.s.events ?? [], samples = 24) {
    if (!events.length) return null;
    const full = target === this.me || (this.s.players[target]?.flag === "public" && (!this.cfg?.reciprocity || this.myFlag === "public"));
    if (!full) return null;
    const veil = new Set(target === this.me ? [] : (this.s.players[target]?.veil ?? []).map(sidKey));
    const evs = events.filter((e) => !(e.type === "ink" && veil.has(e.sid)));
    return trend(evs, { target, start: events[0].t, end: Math.max(this.now, events[events.length - 1].t + 1), samples,
      decay: this.cfg?.decay ?? null, palette: this.cfg?.palette ?? [], colourOf: (e) => (Number.isInteger(e.ink.colour) ? e.ink.colour : null) });
  }

  async publishRound(title, from, to) {
    const events = this.s.events ?? (await this.history());
    const pub = events.map((e) => (e.type === "ink" && e.ink.sealed && !this.isDisclosed(e) ? { ...e, ink: { sealed: e.ink.sealed } } : e));
    const { header, bodyHex } = buildRound({ events: pub, from, to, palette: this.cfg.palette, decay: this.cfg.decay, title, blockHash: this.s.blockHash,
      now: this.now, names: this.s.names, players: Object.keys(this.s.players).length });
    return this.bridge.publishPlay("round", header, bodyHex);
  }
  /** A sealed ink's colour may go in a round only if its owner disclosed it. */
  isDisclosed(e) { return (this.s.disc[e.target] ?? []).some((x) => sidKey(x[0]) === e.sid && x[1] === e.seq); }

  /** My portrait (D14): my flag over the span, disclosing the sealed inks on it. Only the owner may. */
  async publishPortrait(title, from, to, roundPlay = null) {
    const events = await this.history();
    const span = events.filter((e) => e.h >= from && e.h < to && (e.type === "ink" || e.type === "reveal" ? e.target === this.me : e.player === this.me));
    const keys = span.map((e, i) => (e.type === "ink" && e.ink.sealed && e.ink.key ? [i, e.ink.key] : null)).filter(Boolean);
    const { header, bodyHex } = buildFlag({ owner: this.me, events: span, from, to, palette: this.cfg.palette, decay: this.cfg.decay, title,
      blockHash: this.s.blockHash, now: this.now, keys, name: this.s.names[this.me] ?? null });
    const r = await this.bridge.publishPlay("flag", header, bodyHex);
    if (roundPlay) await this.bridge.linkPlays(r.playId, roundPlay).catch(() => {});
    return r;
  }

  /** This game's plays of a kind, newest first, with engagement counts. */
  async plays(kind, days = 14) {
    const list = (await this.bridge.gallery(kind, days)) ?? [];
    return Promise.all(list.map(async (p) => ({ ...p, counts: (await this.bridge.counts(p.id).catch(() => ({}))) ?? {} })));
  }
  async loadPlay(kind, id) {
    const hex = await this.bridge.playBody(id);
    return kind === "flag" ? decodeFlag(fromHex(hex)) : decodeRound(fromHex(hex));
  }
  engage(play, kind) { return this.bridge.engage(play, kind); }

  get capacityLine() {
    const c = this.cfg;
    if (!c) return "";
    const d = c.decay ? `fades over ${spanOf(c.decay.unit * c.decay.steps)}` : "no fading";
    return `${Object.keys(this.s.players).length} of ${c.capacity} players · ${c.palette.length} colours · ${d}`;
  }
  /** Steps left on my stripe on `target` (null without decay). */
  stepsLeft(target) { const s = this.myStripe(target); return s ? remaining(this.cfg?.decay, s.last[1], this.now) : null; }
}

/** "10 minutes", "a day", "6 hours". */
export function spanOf(ms) {
  const [n, w] = ms % 86_400_000 === 0 ? [ms / 86_400_000, "day"] : ms % 3_600_000 === 0 ? [ms / 3_600_000, "hour"] : [Math.max(1, Math.round(ms / 60_000)), "minute"];
  return n === 1 ? (w === "hour" ? "an hour" : `a ${w}`) : `${n} ${w}s`;
}
export const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export { configOk };
