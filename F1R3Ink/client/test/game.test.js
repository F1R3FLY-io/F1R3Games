import { describe, expect, it } from "vitest";
import { FakeShard, DEMO_CONFIG } from "../src/core/fake.js";
import { InkGame } from "../src/core/game.js";
import { decodeFlag, decodeRound, fromHex } from "../src/core/history.js";
import { sidKey } from "../src/core/ink.js";

function table(n = 5, config = DEMO_CONFIG) {
  const shard = new FakeShard({ config });
  const ps = Array.from({ length: n }, (_, i) => shard.addPlayer({ name: `P${i}` }, { host: i === 0 }));
  const games = ps.map((p) => new InkGame(shard.bridge(p.address), { instance: shard.instanceId, now: () => shard.ts }));
  return { shard, ps, games };
}

async function enterAll(games, flags) {
  for (const g of games) await g.start();
  for (let i = 0; i < games.length; i++) await games[i].enter(flags[i] ?? "public", []);
  for (const g of games) await g.refresh();
}

const all = async (games) => { for (const g of games) await g.refresh(); };

describe("a round of F1R3Ink", () => {
  it("asks each player to choose a visibility, then enters them", async () => {
    const { games, shard } = table(3);
    for (const g of games) await g.start();
    expect(games[0].needsEntry).toBe(true);
    await expect(games[0].enter("maybe")).rejects.toThrow(/public or private/);
    await games[0].enter("private", ["quiet", "new here"]);
    await games[0].refresh();
    expect(games[0].entered).toBe(true);
    expect(games[0].myFlag).toBe("private");
    expect(shard.get(["p", games[0].me]).tags).toEqual(["quiet", "new here"]);
  });

  it("inks only while active, one stripe per inker, mutable, with a pace (D3, D9)", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "public", "public"]);
    const [a, b] = games;
    await expect(a.ink(b.me, 2)).rejects.toThrow(/host starts/);
    shard.inst.status = "active";
    await all(games);
    await a.ink(b.me, 2);
    await all(games);
    expect(a.myStripe(b.me)).toMatchObject({ seq: 1, ink: { c: 2 }, by: a.me });
    await expect(a.ink(b.me, 3)).rejects.toThrow(/again in/);
    shard.ts += DEMO_CONFIG.minInterval;
    await a.ink(b.me, 3);
    await all(games);
    const s = (shard.flags()[1].stripes[b.me]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ seq: 2, ink: { c: 3 } });
    expect(b.view(b.me)).toEqual([expect.objectContaining({ key: a.me, colour: 3, alpha: 1 })]);
    await expect(a.ink(a.me, 1)).rejects.toThrow(/yourself/);
    await expect(a.ink(b.me, 99)).rejects.toThrow(/palette/);
  });

  it("seals inks on a private flag to its owner and the inker (D1)", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "private", "public"]);
    shard.inst.status = "active";
    await all(games);
    const [a, b, c] = games;
    await a.ink(b.me, 5);
    await all(games);
    const stripe = shard.flags()[1].stripes[b.me][0];
    expect(typeof stripe.ink.sealed).toBe("string");
    expect(b.view(b.me)[0]).toMatchObject({ colour: 5, sealed: true });
    expect(a.view(b.me)[0]).toMatchObject({ colour: 5, mine: true });
    expect(c.view(b.me)).toEqual([]); // a private flag: c sees only its own stripes, and has none
  });

  it("shows a private flag to others only as their own stripe, and a public flag in full", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "public", "private"]);
    shard.inst.status = "active";
    await all(games);
    const [a, b, c] = games;
    await a.ink(c.me, 1); await b.ink(c.me, 2); await b.ink(a.me, 4); await c.ink(a.me, 6);
    await all(games);
    expect(a.view(c.me).map((v) => v.key)).toEqual([a.me]);
    expect(b.view(c.me).map((v) => v.key)).toEqual([b.me]);
    expect(c.view(c.me).map((v) => v.colour).sort()).toEqual([1, 2]);
    expect(c.view(a.me).map((v) => v.colour).sort()).toEqual([4, 6]);
  });

  it("discloses current colours on going public, and seals again on going private", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "private", "public"]);
    shard.inst.status = "active";
    await all(games);
    const [a, b, c] = games;
    await a.ink(b.me, 7);
    await all(games);
    expect(c.view(b.me)).toEqual([]);
    await b.setVisibility("public");
    await all(games);
    expect(shard.get(["disc", b.me])).toHaveLength(1);
    expect(c.view(b.me)).toEqual([expect.objectContaining({ key: a.me, colour: 7, sealed: true })]);
    // From now on inks on b are in the clear.
    shard.ts += DEMO_CONFIG.minInterval;
    await a.ink(b.me, 8); await all(games);
    expect(shard.flags()[1].stripes[b.me][0].ink).toEqual({ c: 8 });
    await b.setVisibility("private"); await all(games);
    expect(c.view(b.me)).toEqual([]);
  });

  it("keeps anonymous stripes anonymous, through the relay, and reveals one way (D2, D10)", async () => {
    const { games, shard } = table(5);
    await enterAll(games, ["public", "public", "public", "public", "private"]);
    shard.inst.status = "active";
    await all(games);
    const [a, b, , , e] = games;
    await a.ink(b.me, 3, { anonymous: true });
    await a.ink(e.me, 4, { anonymous: true }).catch(() => {}); // queued behind the first
    for (let i = 0; i < 3; i++) { shard.block(); await all(games); }
    const onB = shard.flags()[1].stripes[b.me];
    expect(onB).toHaveLength(1);
    expect(onB[0].by).toBeNull();
    expect(Array.isArray(onB[0].sid) && onB[0].sid[0]).toBe("anon");
    expect(b.view(b.me)[0]).toMatchObject({ anon: true, by: null, colour: 3 });
    expect(a.view(b.me)[0]).toMatchObject({ mine: true });
    // The sealed anonymous ink on e opens for e and for a, and names no one.
    const onE = shard.flags()[1].stripes[e.me];
    expect(onE[0].ink.sealed).toBeTruthy();
    expect(e.view(e.me)[0]).toMatchObject({ anon: true, colour: 4 });
    expect(JSON.stringify(onE)).not.toContain(a.me);
    // Later inks follow the stripe's attribution.
    shard.ts += DEMO_CONFIG.minInterval;
    await a.ink(b.me, 5); shard.block(); await all(games);
    expect(shard.flags()[1].stripes[b.me]).toHaveLength(1);
    await a.reveal(b.me); await all(games);
    expect(b.view(b.me)[0]).toMatchObject({ by: a.me, colour: 5 });
  });

  it("refuses anonymity below anonMin", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "public", "public"]);
    shard.inst.status = "active"; await all(games);
    await expect(games[0].ink(games[1].me, 1, { anonymous: true })).rejects.toThrow(/needs 5 players/);
  });

  it("fades stripes with block time, and freezes at the close (D5)", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "public", "public"]);
    shard.inst.status = "active"; await all(games);
    const [a, b] = games;
    await a.ink(b.me, 1); await all(games);
    const unit = DEMO_CONFIG.decay.unit;
    shard.ts += unit * 3 + 10; shard.block(); await all(games);
    expect(b.view(b.me)[0].remaining).toBe(DEMO_CONFIG.decay.steps - 3);
    shard.inst.status = "closed"; await all(games); shard.block(); await all(games);
    const closedAt = shard.get(["closedAt"]);
    expect(closedAt).not.toBeNull();
    shard.ts += unit * 100; shard.block(); await all(games);
    expect(b.now).toBe(closedAt[1]);
    expect(b.view(b.me)[0].alpha).toBeGreaterThan(0);
  });

  it("veils a stripe from others' view of a public flag (D15)", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "public", "public"]);
    shard.inst.status = "active"; await all(games);
    const [a, b, c] = games;
    await a.ink(b.me, 2); await all(games);
    await b.setVeil([a.me]); await all(games);
    expect(c.view(b.me)[0]).toMatchObject({ veiled: true, colour: null });
    expect(b.view(b.me)[0]).toMatchObject({ veiled: false, colour: 2 });
    expect(a.view(b.me)[0]).toMatchObject({ mine: true, colour: 2 });
  });

  it("shows a stripe's history newest first (D3)", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "private", "public"]);
    shard.inst.status = "active"; await all(games);
    const [a, b] = games;
    for (const c of [1, 2, null, 4]) { await a.ink(b.me, c); await all(games); shard.ts += DEMO_CONFIG.minInterval; shard.block(); }
    const h = await b.stripeHistory(b.me, a.me);
    expect(h.map((x) => (x.lifted ? "lift" : x.colour))).toEqual([4, "lift", 2, 1]);
  });

  it("builds both aggregate views from what the viewer may see (D13)", async () => {
    const { games, shard } = table(4);
    await enterAll(games, ["public", "public", "private", "public"]);
    shard.inst.status = "active"; await all(games);
    const [a, b, c, d] = games;
    await a.ink(b.me, 1); await c.ink(b.me, 1); await d.ink(c.me, 2); await b.ink(c.me, 3);
    await all(games);
    const sp = a.spectrum();
    expect(sp.from).toBe(3); // a's own flag, b's and d's; c's is private
    expect(sp.of).toBe(4);
    expect(sp.weights[1]).toBe(2);
    expect(sp.weights[2]).toBe(0); // d's ink on c: not a's to see
    const events = await a.history();
    expect(a.volume(events).reduce((x, y) => x + y, 0)).toBe(4);
    expect(a.trend(c.me, events)).toBeNull();
    const tb = a.trend(b.me, events);
    expect(tb[tb.length - 1].shares[1]).toBe(1);
    expect(c.trend(c.me, await c.history()).at(-1).weights.slice(2, 4)).toEqual([1, 1]);
  });

  it("publishes a round of public data and a portrait that discloses its owner's inks", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "private", "public"]);
    shard.inst.status = "active"; await all(games);
    const [a, b, c] = games;
    await a.ink(b.me, 5); await c.ink(a.me, 2); await all(games);
    await c.history();
    const r = await c.publishRound("A round", 0, shard.height + 1);
    const round = decodeRound(fromHex(shard.plays.find((p) => p.id === r.playId).body));
    const sealed = round.events.find((e) => e.type === "ink" && e.target === b.me);
    expect(sealed.ink.colour).toBeNull(); // c may not know it, and the round does not disclose it
    const pr = await b.publishPortrait("Me", 0, shard.height + 1, r.playId);
    const p = decodeFlag(fromHex(shard.plays.find((x) => x.id === pr.playId).body));
    expect(p.owner).toBe(b.me);
    expect(p.keys).toHaveLength(1);
    expect(p.round.events.find((e) => e.type === "ink").ink.colour).toBe(5);
    expect(shard.plays.find((x) => x.id === pr.playId).links).toEqual([r.playId]);
  });

  it("seals messages to entered players, and pays through the Portal", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "public", "public"]);
    const [a, b] = games;
    await a.say("why yellow?", [b.me]);
    await all(games);
    expect(b.state.messages.map((m) => m.text)).toEqual(["why yellow?"]);
    await a.pay({ mode: "each", amount: 5, recipients: [b.me] });
    expect(shard.balances[b.me]).toBe(1005);
  });

  it("orders the wheel by recent interaction (D12)", async () => {
    const { games, shard } = table(4);
    await enterAll(games, ["public", "public", "public", "public"]);
    shard.inst.status = "active"; await all(games);
    const [a, b, c, d] = games;
    await d.ink(a.me, 1); await all(games); shard.ts += 5000; shard.block();
    await a.ink(b.me, 1); await all(games);
    expect(a.wheel("recent")).toEqual([b.me, d.me, c.me]);
    expect(a.wheel("newest")[0]).toBe(d.me);
  });

  it("marks fresh inks on me, on the inker or, when anonymous, on me", async () => {
    const { games, shard } = table(3);
    await enterAll(games, ["public", "public", "public"]);
    shard.inst.status = "active"; await all(games);
    const [a, b] = games;
    await a.ink(b.me, 1); await all(games);
    shard.ts += DEMO_CONFIG.minInterval; await a.ink(b.me, 2); await all(games);
    expect(b.state.fresh[a.me]).toBe(true);
    b.clearFresh(a.me);
    expect(b.state.fresh[a.me]).toBeUndefined();
    expect(sidKey(["anon", "ab"])).toBe("anon:ab");
  });
});
