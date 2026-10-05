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
import { attempt, err, type Result } from "./result";
import type { Plain, Typed } from "./values";

export const PROTOCOL = 1;

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

  async dispatch(method: string, p: any): Promise<Result<unknown>> {
    const P = this.portal;
    switch (method) {
      case "hello":
        return attempt("hello", async () => ({
          protocol: PROTOCOL,
          address: P.wallet.address,
          profile: await P.profile().catch(() => null),
          instance: await P.instance(this.instance),
        }));
      case "deploy":
        return attempt("deploy", () =>
          P.call(p.template, p.args as { [k: string]: Typed }, { game: this.game.id, origin: this.game.id, instance: this.instance, phloLimit: p.phloLimit }),
        );
      case "read":
        return attempt("read", () => P.read(p.template, p.args as { [k: string]: Typed }, this.game.id));
      case "publishPlay":
        return attempt("publishPlay", () => P.publishPlay(this.instance, p.kind, p.header as Plain, p.body as string, this.game.id));
      case "linkPlays":
        return attempt("linkPlays", () => P.linkPlays(p.id, p.other));
      case "engage":
        return attempt("engage", () => P.engage(p.play, p.kind));
      case "invite":
        if (this.game.contactsDialogue === false) return err("refused", "this game does not use the contact dialogue");
        this.hooks.openInvite();
        return ["ok", true] as const;
      default:
        return err("unknown-method", `no method ${method}`);
    }
  }
}
