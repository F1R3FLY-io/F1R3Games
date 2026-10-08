// @vitest-environment node
// The read-only gallery methods of the host protocol (F1R3Beat design §10),
// against a stub portal: they answer only for the hosted game's own plays.
import { describe, expect, it } from "vitest";
import { GameHost } from "../core/host";

const plays: { [id: string]: { id: string; game: string; kind: string } } = {
  p1: { id: "p1", game: "f1r3beat", kind: "pattern" },
  q1: { id: "q1", game: "f1r3pix", kind: "canvas" },
};
const portal: any = {
  gallery: async (game: string, kind: string, days: number) => [{ game, kind, days }],
  play: async (id: string) => plays[id] ?? null,
  playBody: async (id: string) => `body of ${id}`,
  counts: async (id: string) => ({ like: id.length }),
};
const beat: any = { id: "f1r3beat", name: "F1R3Beat", entry: "https://beat.example/", templates: [], galleries: [{ kind: "pattern" }, { kind: "session" }], capabilities: ["pay", "open"] };
const host = new GameHost(portal, beat, "inst1", () => null, { openInvite: () => undefined });

describe("the gallery methods of the host protocol", () => {
  it("lists the game's own gallery kinds, within 60 days", async () => {
    expect(await host.dispatch("gallery", { kind: "pattern", days: 400 })).toEqual(["ok", [{ game: "f1r3beat", kind: "pattern", days: 60 }]]);
    expect(await host.dispatch("gallery", { kind: "session" })).toEqual(["ok", [{ game: "f1r3beat", kind: "session", days: 14 }]]);
    expect((await host.dispatch("gallery", { kind: "canvas" }))[0]).toBe("err");
  });
  it("reads bodies and counts of the game's own plays only", async () => {
    expect(await host.dispatch("playBody", { id: "p1" })).toEqual(["ok", "body of p1"]);
    expect(await host.dispatch("counts", { id: "p1" })).toEqual(["ok", { like: 2 }]);
    expect((await host.dispatch("playBody", { id: "q1" }))[0]).toBe("err");
    expect((await host.dispatch("counts", { id: "nope" }))[0]).toBe("err");
  });
});

import { Portal } from "../core/portal";

describe("the relay capability (F1R3Ink design §8)", () => {
  const ink: any = { id: "f1r3ink", name: "F1R3Ink", entry: "https://ink.example/", templates: [], galleries: [], capabilities: ["pay", "open", "relay"], relay: "https://portal.example/api/relay/f1r3ink" };
  const posted: any[] = [];
  const fake = (allowances: any[]) => ({
    service: { relay: async (url: string, body: any) => { posted.push({ url, body }); return { queued: true, handle: "ab" }; } },
    wallet: {
      address: "1111me",
      allowances: () => allowances,
      signRelay: (message: string) => ({ publicKey: "04aa", signature: `sig(${message.length})` }),
    },
  });
  const relayOf = (p: any) => (g: any, i: string, op: string, params: any) => Portal.prototype.relay.call(p, g, i, op, params, 1000);

  it("signs the host's game, instance and the manifest's relay, and posts only there", async () => {
    const p = fake([{ game: "f1r3ink", instance: "inst1", budget: 1, spent: 0, expiresAt: 5000 }]);
    const h = new GameHost({ relay: relayOf(p) } as any, ink, "inst1", () => null, { openInvite: () => undefined });
    expect(await h.dispatch("relay", { op: "ink", params: { target: "1111b", ink: { c: 2 } }, game: "other", relay: "https://evil.example" })).toEqual(["ok", { queued: true, handle: "ab" }]);
    expect(posted[0].url).toBe(ink.relay);
    const m = JSON.parse(posted[0].body.message);
    expect(m).toEqual({ v: 1, game: "f1r3ink", instance: "inst1", relay: ink.relay, op: "ink", params: { target: "1111b", ink: { c: 2 } }, address: "1111me", at: 1000 });
    expect(posted[0].body.signature).toBe(`sig(${posted[0].body.message.length})`);
  });
  it("refuses without an allowance, a relay or the capability", async () => {
    const none = new GameHost({ relay: relayOf(fake([])) } as any, ink, "inst1", () => null, { openInvite: () => undefined });
    expect((await none.dispatch("relay", { op: "ink", params: {} }))[1]).toBe("allowance");
    const noRelay = new GameHost({ relay: relayOf(fake([{ game: "f1r3ink", instance: "inst1", expiresAt: 5000 }])) } as any, { ...ink, relay: undefined }, "inst1", () => null, { openInvite: () => undefined });
    expect((await noRelay.dispatch("relay", { op: "ink", params: {} }))[1]).toBe("no-relay");
    const beatHost = new GameHost({} as any, beat, "inst1", () => null, { openInvite: () => undefined });
    expect(await beatHost.dispatch("relay", { op: "ink" })).toEqual(["err", "refused", "f1r3beat did not declare the relay capability"]);
    expect((await none.dispatch("relay", { op: "Bad Op" }))[0]).toBe("err");
  });
});
