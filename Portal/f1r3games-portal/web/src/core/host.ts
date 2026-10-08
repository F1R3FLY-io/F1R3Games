// The host side of the game protocol (design §9.2). A game runs in a
// sandboxed frame on its own origin and reaches identity, payment and the
// shard only through these messages; it never sees a key.
//
//   game → portal: { f1r3games: 1, id, method, params }
//   portal → game: { f1r3games: 1, id, result: ["ok", value] | ["err", code, message] }
//   portal → game: { f1r3games: 1, event, data }        (context, locked)
//
// In F1R3Gaze, the same methods become capabilities handed to the game's
// page (a game is then a f1r3lang page holding `portal` instead of a frame).

import type { GameManifest, Portal } from "./portal";
import { attempt, CapError, err, type Result } from "./result";
import type { Plain, Typed } from "./values";

export const PROTOCOL = 2;

/** Methods every game may call; anything else must be declared in the manifest's `capabilities`.
 *  `gallery`, `playBody` and `counts` (F1R3Beat design §10) read public chain data about the
 *  game's own plays, for in-game galleries and crosses. */
const BASE = new Set(["hello", "deploy", "read", "publishPlay", "linkPlays", "engage", "invite", "balance", "payments", "profiles", "gallery", "playBody", "counts"]);
/** Declarable capabilities (F1R3Pix design §8; `relay`, F1R3Ink design §8). */
export const CAPABILITIES = ["pay", "open", "relay"] as const;

export interface HostHooks {
  openInvite(): void;
}

export class GameHost {
  constructor(
    private portal: Portal,
    private game: GameManifest,
    private instance: string,
    private frame: () => Window | null,
    private hooks: HostHooks,
  ) {}

  get origin() {
    return new URL(this.game.entry).origin;
  }

  attach(target: Window = window) {
    const h = (e: MessageEvent) => void this.onMessage(e);
    target.addEventListener("message", h);
    return () => target.removeEventListener("message", h);
  }

  async onMessage(e: MessageEvent) {
    const m = e.data;
    if (!m || m.f1r3games !== PROTOCOL || typeof m.method !== "string") return;
    if (e.origin !== this.origin || e.source !== this.frame()) return; // only this game's frame
    const result = await this.dispatch(m.method, m.params ?? {});
    (e.source as Window).postMessage({ f1r3games: PROTOCOL, id: m.id, result }, this.origin);
  }

  /** Game templates take the instance as their first argument; the host
   *  supplies it when the game leaves it out. */
  private withInstance(template: string, args: { [k: string]: Typed } = {}): { [k: string]: Typed } {
    const t = this.game.templates.find((x) => x.id === template);
    if (t && t.source.includes("{{instance}}") && !("instance" in args)) return { ...args, instance: this.instance };
    return args;
  }

  async dispatch(method: string, p: any): Promise<Result<unknown>> {
    const P = this.portal;
    if (!BASE.has(method) && !(this.game.capabilities ?? []).includes(method)) {
      return (CAPABILITIES as readonly string[]).includes(method)
        ? err("refused", `${this.game.id} did not declare the ${method} capability`)
        : err("unknown-method", `no method ${method}`);
    }
    switch (method) {
      case "hello":
        return attempt("hello", async () => ({
          protocol: PROTOCOL,
          address: P.wallet.address,
          publicKey: P.wallet.publicKey,
          profile: await P.profile().catch(() => null),
          instance: await P.instance(this.instance),
        }));
      case "pay":
        // R5: refuse anyone outside the hosted instance before showing a prompt.
        return attempt("pay", async () => {
          const to: unknown = p.to, amounts: unknown = p.amounts;
          if (!Array.isArray(to) || !Array.isArray(amounts) || to.length !== amounts.length || to.length < 1 || to.length > 64) throw new Error("to and amounts must be lists of the same length, 1 to 64");
          if (!to.every((a) => typeof a === "string") || !amounts.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("bad recipients or amounts");
          if (p.memo !== null && p.memo !== undefined && (typeof p.memo !== "string" || p.memo.length > 140)) throw new Error("the memo must be text of at most 140 characters");
          try {
            const r = await P.pay(this.instance, to.map((a, i) => [a as string, amounts[i] as number]), p.memo ?? null);
            return { deployId: r.deployId };
          } catch (e: any) {
            if (e?.code === "not-participant") throw new CapError("not-participant", e.message);
            if (/not approved/.test(e?.message ?? "")) throw new CapError("declined", "the payment was not approved");
            if (/insufficient|balance/i.test(e?.message ?? "")) throw new CapError("insufficient", e.message);
            throw new CapError("node", e?.message ?? String(e));
          }
        });
      case "open":
        // R3: the host binds the game and instance; the game supplies only the envelope.
        return attempt("open", async () => {
          if (typeof p.envelope !== "string" || !/^([0-9a-f]{2})+$/i.test(p.envelope)) throw new Error("the envelope must be hex");
          try {
            return P.wallet.openEnvelope(this.game.id, this.instance, p.envelope);
          } catch (e: any) {
            if (e?.code === "rate-limited") throw new CapError("rate-limited", e.message);
            const m = String(e?.message ?? e);
            throw new CapError(/not addressed/.test(m) ? "not-addressed" : "corrupt", m);
          }
        });
      case "relay":
        // R5: signed under the relay domain, posted only to the relay the registered manifest names.
        return attempt("relay", async () => {
          if (typeof p.op !== "string" || !/^[a-z]{1,32}$/.test(p.op)) throw new Error("op must be a short lowercase name");
          const params = p.params ?? {};
          if (typeof params !== "object" || Array.isArray(params) || JSON.stringify(params).length > 4096) throw new Error("params must be an object of at most 4 KiB");
          try {
            return await P.relay(this.game, this.instance, p.op, params as Plain);
          } catch (e: any) {
            const code = e?.code === "no-relay" || e?.code === "allowance" ? e.code : "relay";
            throw new CapError(code, e?.message ?? String(e));
          }
        });
      case "balance":
        return attempt("balance", async () => {
          const b = await P.balance();
          return b?.value ?? b?.balance ?? b;
        });
      case "payments":
        return attempt("payments", () => P.payments(this.instance, p.cursor ?? {}));
      case "profiles":
        return attempt("profiles", async () => {
          const addrs: string[] = Array.isArray(p.addresses) ? p.addresses.slice(0, 256).filter((a: unknown) => typeof a === "string") : [];
          const inst = await P.instance(this.instance);
          const out: { [a: string]: unknown } = {};
          // Only the instance's participants: a game cannot use this to look up arbitrary addresses.
          for (const a of addrs.filter((a) => inst?.participants[a])) out[a] = await P.profile(a).catch(() => null);
          return out;
        });
      case "deploy":
        return attempt("deploy", () =>
          P.call(p.template, this.withInstance(p.template, p.args), { game: this.game.id, origin: this.game.id, instance: this.instance, phloLimit: p.phloLimit }),
        );
      case "read":
        return attempt("read", () =>
          p.meta
            ? P.readMeta(p.template, this.withInstance(p.template, p.args), this.game.id)
            : P.read(p.template, this.withInstance(p.template, p.args), this.game.id),
        );
      case "publishPlay":
        return attempt("publishPlay", () => P.publishPlay(this.instance, p.kind, p.header as Plain, p.body as string, this.game.id));
      case "linkPlays":
        return attempt("linkPlays", () => P.linkPlays(p.id, p.other));
      case "engage":
        return attempt("engage", () => P.engage(p.play, p.kind));
      case "gallery":
        // This game's plays of one of its own gallery kinds, newest first, over at most 60 days.
        return attempt("gallery", async () => {
          if (!(this.game.galleries ?? []).some((g) => g.kind === p.kind)) throw new Error(`${this.game.id} has no ${String(p.kind)} gallery`);
          const days = Number.isSafeInteger(p.days) ? Math.max(1, Math.min(60, p.days)) : 14;
          return P.gallery(this.game.id, p.kind, days);
        });
      case "playBody":
      case "counts":
        // Only plays of this game: a game cannot use these to read other games' plays.
        return attempt(method, async () => {
          if (typeof p.id !== "string") throw new Error("id must be a play id");
          const play = await P.play(p.id);
          if (!play || play.game !== this.game.id) throw new Error(`no ${this.game.id} play ${p.id}`);
          return method === "playBody" ? P.playBody(p.id) : P.counts(p.id);
        });
      case "invite":
        if (this.game.contactsDialogue === false) return err("refused", "this game does not use the contact dialogue");
        this.hooks.openInvite();
        return ["ok", true] as const;
      default:
        return err("unknown-method", `no method ${method}`);
    }
  }
}
