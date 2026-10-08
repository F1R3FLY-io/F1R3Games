// The portal's operations, independent of any UI framework. React renders
// them; a f1r3lang page in F1R3Gaze would compose the same capabilities
// (shard, wallet, store, consent) the same way — see docs/GAZE-MAPPING.md.

import { HttpService, type EnvInfo, type Service } from "./service";
import type { Store } from "./store";
import { Wallet, type ContactBook, type WalletWasm } from "./wallet";
import { plain, T, typed, type Plain, type Typed } from "./values";

/** The `consent` capability: ask the person to approve a signature. */
export interface ConsentRequest {
  origin: string;
  template: string;
  summary: string;
  maxFee: number;
  estimatedCost: number | null;
}
export interface Consent {
  ask(r: ConsentRequest): Promise<boolean>;
}

export type Visibility = "public" | "unlisted" | "private";

export interface GalleryKind {
  kind: string;
  label?: string;
  renderer?: string;
}
export interface GameTemplate {
  id: string;
  kind: "deploy" | "explore";
  hash: string;
  source: string;
  play?: boolean;
}
export interface GameManifest {
  id: string;
  name: string;
  tagline?: string;
  entry: string;
  platforms?: string[];
  galleries: GalleryKind[];
  templates: GameTemplate[];
  contactsDialogue?: boolean;
  readerTier?: boolean;
  status?: string;
  /** Host-protocol capabilities beyond the base set (protocol 2: "pay", "open", "relay"). */
  capabilities?: string[];
  /** The relay a game with the `relay` capability posts to (F1R3Ink design §8). */
  relay?: string;
}
/** A payment between participants of an instance, as `payments.list` answers it. */
export interface Payment {
  from: string;
  seq: number;
  to: string;
  amount: number;
  ok: boolean;
  reason: string;
  at: number;
  h: number;
  memo: string | null;
}
export interface Instance {
  id: string;
  game: string;
  host: string;
  createdAt: number;
  visibility: Visibility;
  status: "lobby" | "active" | "closed";
  participants: { [address: string]: { role: string; joinedAt: number } };
  config: Plain;
}
export interface PlayHeader {
  id: string;
  game: string;
  kind: string;
  instance: string;
  title?: string;
  preview?: Plain;
  authors: string[];
  createdAt: number;
  version: number;
  links: string[];
  bodyHash: string;
}
export interface Sponsorship {
  id: string;
  sponsor: string;
  terms: { name: string; message?: string; link?: string; games: string[]; stipend: number; maxPerAddress: number; expiresAt: number };
  escrow: string;
  funded: number;
  paid: number;
  status: string;
}

export const DAY_MS = 86_400_000;

/** Undo the Rholang string escaping (`\"` and `\\`) the portal writes; see crates/core/src/rho.rs `unescape`. */
export function unescapeRho(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}
export const today = (now = Date.now()) => Math.floor(now / DAY_MS);

/** Canonical JSON for comparing typed values. */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
}

export interface CallOptions {
  game?: string;
  origin?: string;
  instance?: string;
  derive?: string[];
  phloLimit?: number;
}

export class Portal {
  private constructor(public service: Service, public wallet: Wallet, public store: Store, public consent: Consent, public env: EnvInfo) {}

  static async boot(opts: { service?: Service; wasm: WalletWasm; store: Store; consent: Consent; iterations?: number }): Promise<Portal> {
    const service = opts.service ?? new HttpService();
    const env = await service.env();
    const wallet = new Wallet(opts.wasm, opts.store, env.shardId, env.envUri);
    if (opts.iterations) wallet.iterations = opts.iterations;
    const pinned = await opts.store.get("envUri");
    if (pinned && pinned !== env.envUri) {
      throw new Error(`this wallet pinned environment ${pinned}; the service now serves ${env.envUri}`);
    }
    await opts.store.set("envUri", env.envUri);
    await wallet.open();
    return new Portal(service, wallet, opts.store, opts.consent, env);
  }

  get signedOn() {
    return this.wallet.unlocked;
  }

  // ------------------------------------------------------------ the core write path

  /** prepare → check → review → (consent) → sign → send. */
  async call(template: string, args: { [k: string]: Typed }, o: CallOptions = {}): Promise<{ deployId: string; derived: { [k: string]: string } }> {
    const p = await this.service.prepare({
      template,
      game: o.game,
      args,
      deployer: this.wallet.publicKey,
      derive: o.derive,
      phloLimit: o.phloLimit,
    });
    // The service may add env_uri and the identifiers it was asked to derive; nothing else.
    for (const [k, v] of Object.entries(args)) {
      if (canon(p.args[k]) !== canon(v)) throw new Error(`the service changed argument ${k}; refusing to sign`);
    }
    for (const k of Object.keys(p.args)) {
      if (!(k in args) && k !== "env_uri" && !(o.derive ?? []).includes(k)) throw new Error(`the service added argument ${k}; refusing to sign`);
    }
    const input = { origin: o.origin ?? "portal", template, args: p.args, prepared: p.prepared, instance: o.instance };
    const decision = this.wallet.review(input);
    let approved = true;
    if (decision.kind === "prompt") {
      approved = await this.consent.ask({
        origin: input.origin,
        template,
        summary: decision.summary,
        maxFee: decision.maxFee,
        estimatedCost: p.estimatedCost,
      });
      if (!approved) throw new Error("not approved");
    }
    const s = this.wallet.sign(input, approved);
    const r = await this.service.send({ prepared: p.prepared, deployer: s.deployer, signature: s.signature, token: p.token });
    return { deployId: r.deployId, derived: p.derived };
  }

  /** Poll until the deploy is in a block (or time runs out). */
  async waitFor(deployId: string, timeoutMs = 60_000, intervalMs = 1500): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await this.service.get(`/api/deploys/${deployId}`).catch(() => ({ found: false }));
      if (r.found) return true;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
    return false;
  }

  async read<P = Plain>(template: string, args: { [k: string]: Typed } = {}, game?: string): Promise<P> {
    const r = await this.service.explore(template, args, game);
    if (!r.ok) throw new Error(r.error ?? "read failed");
    return plain(r.value) as P;
  }

  /** A read together with the block it reflects. */
  async readMeta<P = Plain>(template: string, args: { [k: string]: Typed } = {}, game?: string): Promise<{ value: P; blockHash: string | null; blockNumber: number | null; blockTimestamp: number | null }> {
    const r: any = await this.service.explore(template, args, game);
    if (!r.ok) throw new Error(r.error ?? "read failed");
    return { value: plain(r.value) as P, blockHash: r.blockHash ?? null, blockNumber: r.blockNumber ?? null, blockTimestamp: r.blockTimestamp ?? null };
  }

  /** Relay a request for a hosted game (F1R3Ink design §8, R5). The game id,
   *  the instance and the relay URL come from the host and the registered
   *  manifest, never from the game; the wallet signs under the relay domain.
   *  Needs a live allowance for the instance, as play does; costs the player no phlo. */
  async relay(g: GameManifest, instance: string, op: string, params: Plain, now = Date.now()) {
    if (!g.relay || !(g.capabilities ?? []).includes("relay")) throw Object.assign(new Error(`${g.id} names no relay`), { code: "no-relay" });
    if (!this.service.relay) throw Object.assign(new Error("this portal cannot reach a relay"), { code: "no-relay" });
    const live = this.wallet.allowances().some((a) => a.game === g.id && a.instance === instance && a.expiresAt > now);
    if (!live) throw Object.assign(new Error("no allowance for this game here; reopen it from the portal"), { code: "allowance" });
    const message = JSON.stringify({ v: 1, game: g.id, instance, relay: g.relay, op, params, address: this.wallet.address, at: now });
    const { publicKey, signature } = this.wallet.signRelay(message);
    try {
      return await this.service.relay(g.relay, { message, publicKey, signature });
    } catch (e: any) {
      throw Object.assign(new Error(e?.message ?? String(e)), { code: "relay", status: e?.status });
    }
  }

  private async readPath<P = Plain>(path: string): Promise<P> {
    const r = await this.service.get(path);
    if (!r.ok) throw new Error(r.error ?? "read failed");
    return plain(r.value) as P;
  }

  // ------------------------------------------------------------ identity

  async createIdentity(passphrase: string) {
    return this.wallet.create(passphrase);
  }
  async importIdentity(passphrase: string, keyFile: string) {
    return this.wallet.import(passphrase, keyFile);
  }
  profile(address = this.wallet.address) {
    return this.readPath<{ name?: string; tags?: string[] } | null>(`/api/profiles/${address}`);
  }
  saveProfile(name: string, tags: string[] = []) {
    return this.call("profiles.save", { profile: T.map({ name, tags }) });
  }
  balance(address = this.wallet.address) {
    return this.service.get(`/api/balance/${address}`);
  }
  fund(address = this.wallet.address) {
    return this.service.fund(address);
  }
  transfer(to: string, amount: number) {
    return this.call("wallet.transfer", { from: this.wallet.address, to, amount: T.int(amount) });
  }

  // ------------------------------------------------------------ payments between participants

  /** Pay participants of an instance (F1R3Pix design §7). Always prompted; the
   *  wallet signs this only from the portal. The environment checks again on chain. */
  async pay(instance: string, transfers: [string, number][], memo: string | null = null) {
    const inst = await this.instance(instance);
    if (!inst) throw new Error("unknown instance");
    const outsiders = transfers.map((t) => t[0]).filter((a) => !inst.participants[a] || a === this.wallet.address);
    if (outsiders.length) throw Object.assign(new Error("every recipient must be another participant of this game"), { code: "not-participant" });
    return this.call("payments.send", { instance, transfers: transfers.map(([to, amount]) => [to, T.int(amount)]), memo }, { instance });
  }
  async payments(instance: string, cursor: { [payer: string]: number } = {}): Promise<Payment[]> {
    return (await this.read<Payment[]>("payments.list", { instance, cursor: T.map(cursor) })) ?? [];
  }

  // ------------------------------------------------------------ games and instances

  async games(): Promise<GameManifest[]> {
    const m = (await this.readPath<{ [id: string]: GameManifest } | null>("/api/games")) ?? {};
    return Object.values(m).filter((g) => g.status !== "retired");
  }
  game(id: string) {
    return this.readPath<GameManifest | null>(`/api/games/${id}`);
  }
  /** The Cooperative registers a game (its key must be the active one). */
  registerGame(manifest: GameManifest) {
    return this.call("games.register", { manifest: typed(manifest as unknown as Plain) });
  }

  async launch(game: string, visibility: Visibility = "unlisted", config: Plain = {}): Promise<{ instanceId: string; deployId: string }> {
    const r = await this.call("instances.create", { game, visibility, config: typed(config) }, { derive: ["id"] });
    return { instanceId: r.derived.id, deployId: r.deployId };
  }
  instance(id: string) {
    return this.readPath<Instance | null>(`/api/instances/${id}`);
  }
  publicInstances(game: string) {
    return this.readPath<Instance[]>(`/api/games/${game}/instances`);
  }
  join(id: string) {
    return this.call("instances.join", { id });
  }
  leave(id: string) {
    return this.call("instances.leave", { id });
  }
  setStatus(id: string, status: Instance["status"]) {
    return this.call("instances.setStatus", { id, status });
  }

  /** Before opening a game frame: register the game's templates with the
   *  wallet and grant the allowance within which play is signed unprompted. */
  enterGame(g: GameManifest, instance: string, budget: number, hours = 4) {
    for (const t of g.templates.filter((t) => t.kind === "deploy")) {
      // The node keeps string literals verbatim, so a source read back from the
      // manifest may still carry the escapes it was written with. The listed hash
      // decides: the wallet accepts whichever text matches it, and nothing else.
      try {
        this.wallet.registerGameTemplate(g.id, t.id, t.source, t.hash);
      } catch (e) {
        const unescaped = unescapeRho(t.source);
        if (unescaped === t.source) throw e;
        this.wallet.registerGameTemplate(g.id, t.id, unescaped, t.hash);
      }
    }
    const play = g.templates.filter((t) => t.play && t.kind === "deploy").map((t) => t.id);
    this.wallet.grantAllowance(g.id, instance, play, budget, Date.now() + hours * 3_600_000);
  }

  // ------------------------------------------------------------ galleries

  playsOn(game: string, kind: string, day: number) {
    return this.readPath<PlayHeader[]>(`/api/games/${game}/plays/${kind}/${day}`);
  }

  /** Recent plays of every game and gallery kind, newest first. */
  async feed(days = 7, games?: GameManifest[]): Promise<PlayHeader[]> {
    const gs = games ?? (await this.games());
    const t = today();
    const queries: Promise<PlayHeader[]>[] = [];
    for (const g of gs) for (const k of g.galleries ?? []) for (let d = t; d > t - days; d--) queries.push(this.playsOn(g.id, k.kind, d).catch(() => []));
    const all = (await Promise.all(queries)).flat().filter(Boolean);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async gallery(game: string, kind: string, days = 14): Promise<PlayHeader[]> {
    const t = today();
    const lists = await Promise.all(Array.from({ length: days }, (_, i) => this.playsOn(game, kind, t - i).catch(() => [])));
    return lists.flat().sort((a, b) => b.createdAt - a.createdAt);
  }
  play(id: string) {
    return this.readPath<PlayHeader | null>(`/api/plays/${id}`);
  }
  playBody(id: string, version = -1) {
    return this.readPath<string | null>(`/api/plays/${id}/body?version=${version}`);
  }
  async publishPlay(instance: string, kind: string, header: Plain, bodyHex: string, origin = "portal"): Promise<{ playId: string; deployId: string }> {
    const r = await this.call("plays.publish", { instance, kind, header: typed(header), body: T.bytes(bodyHex) }, { derive: ["id"], origin, instance });
    return { playId: r.derived.id, deployId: r.deployId };
  }
  linkPlays(id: string, other: string) {
    return this.call("plays.link", { id, other });
  }
  engage(play: string, kind: string) {
    return this.call("engagement.record", { play, kind });
  }
  counts(play: string) {
    return this.readPath<{ [kind: string]: number }>(`/api/engagement/${play}`);
  }

  // ------------------------------------------------------------ invitations

  /** Issue an invitation; returns the link to deliver. */
  async invite(instance: string, o: { uses?: number; expiresAt?: number; sponsorship?: string | null } = {}): Promise<{ link: string; deployId: string }> {
    const base = this.env.portalBaseUrl || (typeof location !== "undefined" ? location.origin : "https://games.f1r3fly.io");
    const inv = this.wallet.newInvitation(base, instance);
    const r = await this.call("invites.issue", {
      invitePk: T.bytes(inv.publicKey),
      instance,
      uses: T.int(o.uses ?? 1),
      expiresAt: T.int(o.expiresAt ?? Number.MAX_SAFE_INTEGER),
      sponsorship: o.sponsorship ?? null,
    });
    return { link: inv.link, deployId: r.deployId };
  }

  async redeem(link: string): Promise<{ instanceId: string; deployId: string }> {
    const r = this.wallet.redeemInvitation(link);
    const d = await this.call("invites.redeem", { invitePk: T.bytes(r.invitePublicKey), sig: T.bytes(r.signature) });
    return { instanceId: r.instanceId, deployId: d.deployId };
  }
  invitation(pkHex: string) {
    return this.readPath(`/api/invites/${pkHex}`);
  }

  // ------------------------------------------------------------ sponsorships

  async sponsorships(): Promise<Sponsorship[]> {
    return (await this.readPath<Sponsorship[]>("/api/sponsorships")) ?? [];
  }
  async sponsor(terms: Sponsorship["terms"] & { creativeHex?: string }, amount: number): Promise<{ id: string; deployId: string }> {
    const t = T.map({
      name: terms.name,
      message: terms.message ?? "",
      link: terms.link ?? "",
      creative: T.bytes(terms.creativeHex ?? ""),
      games: T.set(terms.games),
      stipend: T.int(terms.stipend),
      maxPerAddress: T.int(terms.maxPerAddress),
      expiresAt: T.int(terms.expiresAt),
    });
    const r = await this.call("sponsors.create", { terms: t, amount: T.int(amount) }, { derive: ["id"] });
    return { id: r.derived.id, deployId: r.deployId };
  }
  fundSponsorship(id: string, amount: number) {
    return this.call("sponsors.fund", { id, amount: T.int(amount) });
  }
  claim(id: string, instance: string) {
    return this.call("sponsors.claim", { id, instance });
  }
  withdraw(id: string) {
    return this.call("sponsors.withdraw", { id });
  }

  // ------------------------------------------------------------ contacts

  async contacts(): Promise<ContactBook> {
    const h = await this.store.get("contacts");
    return h ? this.wallet.contactsDecrypt(h) : { mode: "clientOnly", contacts: [] };
  }
  async saveContacts(book: ContactBook) {
    await this.store.set("contacts", this.wallet.contactsEncrypt(book));
  }
  async backupContacts(book: ContactBook) {
    if (book.mode !== "onChainBackup") throw new Error("contacts are kept on this device only; choose on-chain backup first");
    return this.call("contacts.save", { ciphertext: T.bytes(this.wallet.contactsEncrypt(book)) });
  }
  async restoreContacts(): Promise<ContactBook> {
    const r = await this.readPath<{ ciphertext: string } | null>(`/api/contacts/${this.wallet.address}`);
    if (!r?.ciphertext) throw new Error("no backup on chain for this address");
    const book = this.wallet.contactsDecrypt(r.ciphertext);
    await this.saveContacts(book);
    return book;
  }
  deleteContactsBackup() {
    return this.call("contacts.delete", {});
  }
}
