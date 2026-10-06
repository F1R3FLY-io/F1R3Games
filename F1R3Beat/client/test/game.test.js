import { describe, expect, it, vi } from "vitest";
import { FakeShard, DEMO_CONFIG } from "../src/core/fake.js";
import { BeatGame } from "../src/core/game.js";
import { rowOf } from "../src/core/grid.js";
import { decodeSession, decodePatternBody, fromHex } from "../src/core/history.js";

function table(n = 4, config = DEMO_CONFIG) {
  const shard = new FakeShard({ config });
  const ps = Array.from({ length: n }, (_, i) => shard.addPlayer({ name: `P${i}` }, { host: i === 0 }));
  const games = ps.map((p) => new BeatGame(shard.bridge(p.address), { instance: shard.instanceId, listenDelayMs: 0 }));
  return { shard, ps, games };
}

describe("a game of F1R3Beat", () => {
  it("seats every player at a distinct cell", async () => {
    const { games } = table(5);
    for (const g of games) await g.start();
    for (const g of games) await g.refresh();
    expect(new Set(games.map((g) => g.myCell)).size).toBe(5);
    expect(games[0].state.grid.cells.size).toBe(5);
    expect(games[0].shape.steps).toBe(32);
  });

  it("sets only your own cell, only while active, only from the row's palette", async () => {
    const { games, shard } = table(3);
    for (const g of games) await g.start();
    await expect(games[1].setNote("kick")).rejects.toThrow(/host starts/);
    shard.inst.status = "active";
    for (const g of games) await g.refresh();
    const g = games[1], row = rowOf(g.myCell);
    const ok = row === 0 ? "snare" : ["", "E2", "E3", "C4", "E4"][row];
    await expect(g.setNote(row === 0 ? "E2" : "kick")).rejects.toThrow(/palette/);
    await g.setNote(ok);
    await g.refresh();
    expect(g.state.grid.cells.get(g.myCell)).toMatchObject({ note: ok, owner: g.state.me.address, n: 1 });
    expect(g.state.pending).toBeNull();
    await g.setNote(null);
    await g.refresh();
    expect(g.noteOf(g.myCell)).toBeNull();
    for (const [c, v] of g.state.grid.cells) if (c !== g.myCell) expect(v.note).toBeNull();
  });

  it("keeps one set in flight and one queued", async () => {
    const { games, shard } = table(2, { ...DEMO_CONFIG, seating: "row" });
    for (const g of games) await g.start();
    shard.inst.status = "active";
    const g = games[0];
    await g.ensureSeat(1); await g.refresh();
    expect(rowOf(g.myCell)).toBe(1);
    const sent = [];
    const deploy = g.bridge.deploy;
    g.bridge.deploy = async (t, a) => { sent.push(a.note); return deploy(t, a); };
    await g.setNote("E2"); await g.setNote("G2"); await g.setNote("A2");
    expect(sent).toEqual(["E2"]);
    expect(g.state.queued).toEqual({ note: "A2" });
    await g.refresh();
    expect(sent).toEqual(["E2", "A2"]);
    await g.refresh();
    expect(g.noteOf(g.myCell)).toBe("A2");
  });

  it("enforces the host's scale", async () => {
    const { games, shard } = table(1, { ...DEMO_CONFIG, seating: "row", scale: ["minor-pentatonic", "E"] });
    await games[0].start(); shard.inst.status = "active";
    await games[0].ensureSeat(1); await games[0].refresh();
    await expect(games[0].setNote("F2")).rejects.toThrow(/palette/);
    await games[0].setNote("G2"); await games[0].refresh();
    expect(games[0].noteOf(games[0].myCell)).toBe("G2");
  });

  it("claims a chosen cell, refusing a taken one", async () => {
    const { games, shard } = table(2, { ...DEMO_CONFIG, seating: "claim" });
    for (const g of games) await g.start();
    expect(games[0].myCell).toBeNull();
    await games[0].ensureSeat(7); await games[1].ensureSeat(7);
    expect(shard.lastError).toBe("taken");
    for (const g of games) await g.refresh();
    expect(games[0].myCell).toBe(7);
    expect(games[1].myCell).toBeNull();
  });

  it("starts from a seed, which the first player at a seeded cell inherits", async () => {
    const seed = { play: "p9", digest: "ab", cells: [[0, "kick"], [6, "E2"]] };
    const { games, shard } = table(1, { ...DEMO_CONFIG, seating: "claim", seed });
    await games[0].start(); await games[0].refresh();
    expect(games[0].state.grid.cells.get(0)).toMatchObject({ note: "kick", seeded: true });
    await games[0].ensureSeat(6); await games[0].refresh();
    expect(games[0].state.grid.cells.get(6)).toMatchObject({ note: "E2", owner: games[0].state.me.address });
    expect(shard.cfg()).not.toBeNull();
    shard.inst.config = { ...shard.inst.config, seed: { ...seed, cells: [[0, "E2"]] } };
    expect(shard.cfg()).toBeNull(); // a pitch on the drum row is a bad seed
  });

  it("publishes the tempo a player listens at, once the control rests (D7)", async () => {
    vi.useFakeTimers();
    try {
      const { games, shard } = table(2);
      for (const g of games) await g.start();
      const g = games[0];
      g.setTempo(90); g.setTempo(96);
      expect(g.tempo).toBe(96);
      await vi.runAllTimersAsync();
      expect(shard.get(["seat", g.state.me.address]).listen).toBe(96);
      await games[1].refresh();
      expect(games[1].state.seats[g.state.me.address].listen).toBe(96);
      expect(games[1].tempo).toBe(100); // the other player still hears the default
    } finally { vi.useRealTimers(); }
  });

  it("orders the wheel nearest on the looped grid first", async () => {
    const { games, shard } = table(4, { ...DEMO_CONFIG, seating: "claim" });
    for (const g of games) await g.start();
    await games[0].ensureSeat(0); await games[1].ensureSeat(5 * 30); await games[2].ensureSeat(5 * 16 + 4); await games[3].ensureSeat(1);
    await games[0].refresh();
    expect(games[0].wheel("near")).toEqual([games[3], games[1], games[2]].map((g) => g.state.me.address));
  });

  it("seals messages to seated players, and pays through the Portal", async () => {
    const { games, shard } = table(3);
    for (const g of games) await g.start();
    for (const g of games) await g.refresh();
    const [a, b, c] = games;
    await a.say("kick on every beat, 5 each?", [b.state.me.address]);
    await b.refresh(); await c.refresh();
    expect(b.state.messages.map((m) => m.text)).toEqual(["kick on every beat, 5 each?"]);
    expect(c.state.messages).toEqual([]);
    await a.pay({ mode: "each", amount: 5, recipients: [b.state.me.address, c.state.me.address] });
    expect(shard.balances[b.state.me.address]).toBe(1005);
  });

  it("publishes a session and a pattern that rebuild from the chain", async () => {
    const { games, shard } = table(2, { ...DEMO_CONFIG, seating: "row" });
    for (const g of games) await g.start();
    shard.inst.status = "active";
    await games[0].ensureSeat(0); await games[1].ensureSeat(1);
    for (const g of games) await g.refresh();
    await games[0].setNote("kick"); await games[1].setNote("E2");
    await games[0].refresh(); await games[0].setNote(null); await games[0].refresh(); await games[0].setNote("snare");
    for (const g of games) await g.refresh();
    const r = await games[0].publishPattern("ours");
    const play = shard.plays.find((p) => p.id === r.playId);
    const { pattern, credits } = decodePatternBody(fromHex(play.body));
    expect(pattern.cells.filter(Boolean).sort()).toEqual(["E2", "snare"]);
    expect([...credits.values()].sort()).toEqual([games[0].state.me.address, games[1].state.me.address].sort());
    const sets = await games[0].history();
    expect(sets.map((s) => s.note)).toContain(null);
  });

  it("crosses two gallery patterns into four linked children", async () => {
    const { games, shard } = table(2, { ...DEMO_CONFIG, seating: "row" });
    for (const g of games) await g.start();
    shard.inst.status = "active";
    await games[0].ensureSeat(0); await games[1].ensureSeat(1);
    for (const g of games) await g.refresh();
    await games[0].setNote("kick"); await games[1].setNote("E2");
    for (const g of games) await g.refresh();
    const p1 = await games[0].publishPattern("one");
    await games[1].setNote("G2"); await games[0].refresh();
    const p2 = await games[0].publishPattern("two");
    const kids = await games[0].cross(p1.playId, p2.playId);
    expect(kids).toHaveLength(4);
    const list = await games[0].patterns();
    const crossed = list.filter((p) => p.origin === "cross");
    expect(crossed).toHaveLength(4);
    expect(crossed.every((p) => p.parents.length === 2 && p.links.includes(p1.playId) && p.links.includes(p2.playId))).toBe(true);
    expect(crossed.map((p) => p.operator).sort()).toEqual(["V", "V", "X", "X"]);
  });
});
