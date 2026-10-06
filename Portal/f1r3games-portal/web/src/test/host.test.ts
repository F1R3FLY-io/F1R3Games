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
