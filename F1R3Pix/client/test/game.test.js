import { describe, expect, it } from "vitest";
import { FakeShard } from "../src/core/fake.js";
import { PixGame } from "../src/core/game.js";
import { cellsFor, key } from "../src/core/hex.js";

function table(n = 4, config) {
  const shard = new FakeShard({ config: config ?? { capacity: 19, seating: "random", palette: null, messageLimit: 2048 } });
  const ps = Array.from({ length: n }, (_, i) => shard.addPlayer({ name: `P${i}` }, { host: i === 0 }));
  const games = ps.map((p) => new PixGame(shard.bridge(p.address), { instance: shard.instanceId }));
  return { shard, ps, games };
}

describe("a game of F1R3Pix", () => {
  it("seats every player at a distinct cell", async () => {
    const { games, shard } = table(5);
    for (const g of games) await g.start();
    for (const g of games) await g.refresh();
    const cells = games.map((g) => key(...g.myCell));
    expect(new Set(cells).size).toBe(5);
    expect(games[0].state.board.cells.size).toBe(5);
    expect(shard.board()[1].radius).toBe(2);
  });

  it("paints only your own cell, only while active", async () => {
    const { games, shard } = table(3);
    for (const g of games) await g.start();
    await expect(games[1].paint("#F3D630")).rejects.toThrow(/host starts/);
    shard.inst.status = "active";
    for (const g of games) await g.refresh();
    await games[1].paint("#f3d630");
    await games[1].refresh();
    const mine = games[1].state.board.cells.get(key(...games[1].myCell));
    expect(mine).toMatchObject({ colour: "#F3D630", owner: games[1].state.me.address, n: 1 });
    expect(games[1].state.pending).toBeNull();
    // Every other cell is untouched.
    for (const [k, c] of games[1].state.board.cells) if (k !== key(...games[1].myCell)) expect(c.colour).toBeNull();
  });

  it("keeps one paint in flight and one queued", async () => {
    const { games, shard } = table(2);
    for (const g of games) await g.start();
    shard.inst.status = "active";
    const g = games[0];
    await g.refresh();
    const sent = [];
    const deploy = g.bridge.deploy;
    g.bridge.deploy = async (t, a) => { sent.push(a.colour); return deploy(t, a); };
    await g.paint("#000000");
    await g.paint("#111111");
    await g.paint("#222222");
    expect(sent).toEqual(["#000000"]);
    expect(g.state.queued).toBe("#222222");
    await g.refresh();
    expect(sent).toEqual(["#000000", "#222222"]);
    await g.refresh();
    expect(g.state.board.cells.get(key(...g.myCell)).colour).toBe("#222222");
  });

  it("enforces the host's palette", async () => {
    const { games, shard } = table(2, { capacity: 7, seating: "random", palette: ["#000000", "#FFFFFF"], messageLimit: 2048 });
    for (const g of games) await g.start();
    shard.inst.status = "active";
    await games[0].refresh();
    await expect(games[0].paint("#F3D630")).rejects.toThrow(/palette/);
    await games[0].paint("#FFFFFF");
    expect(shard.paint(games[0].state.me.address, "#F3D630")).toEqual([false, "colour must be #RRGGBB, upper case, in the palette"]);
  });

  it("seats by claim when the host chose it", async () => {
    const { games, shard } = table(2, { capacity: 7, seating: "claim", palette: null, messageLimit: 2048 });
    for (const g of games) await g.start();
    expect(games[0].myCell).toBeNull();
    await games[0].ensureSeat([1, -1]);
    await games[0].refresh();
    expect(games[0].myCell).toEqual([1, -1]);
    expect(shard.seat(games[1].state.me.address, shard.players[games[1].state.me.address].pk, [1, -1])).toEqual([false, "taken"]);
    expect(shard.seat(games[1].state.me.address, shard.players[games[1].state.me.address].pk, [5, 0])).toEqual([false, "off the board"]);
  });

  it("delivers sealed messages to the selected players and back to the sender", async () => {
    const { games } = table(4);
    for (const g of games) await g.start();
    for (const g of games) await g.refresh();
    const [a, b, c, d] = games.map((g) => g.state.me.address);
    await games[0].say("five each if you turn blue", [b, c]);
    for (const g of games) await g.refresh();
    expect(games[1].state.messages.map((m) => m.text)).toEqual(["five each if you turn blue"]);
    expect(games[2].state.messages[0]).toMatchObject({ from: a, text: "five each if you turn blue" });
    expect(games[3].state.messages).toEqual([]);
    expect(games[0].state.messages.filter((m) => !m.local).map((m) => m.text)).toEqual(["five each if you turn blue"]);
    expect(games[0].state.messages.some((m) => m.local)).toBe(false);
  });

  it("refuses messages over the configured limit", async () => {
    const { games } = table(2, { capacity: 7, seating: "random", palette: null, messageLimit: 300 });
    for (const g of games) await g.start();
    await games[0].refresh();
    await expect(games[0].say("x".repeat(400), [games[1].state.me.address])).rejects.toThrow(/over the limit/);
  });

  it("pays the selected players and lists the payments for everyone", async () => {
    const { games, shard } = table(3);
    for (const g of games) await g.start();
    for (const g of games) await g.refresh();
    const [, b, c] = games.map((g) => g.state.me.address);
    await games[0].pay({ mode: "each", amount: 5, recipients: [b, c], memo: "go blue" });
    for (const g of games) await g.refresh();
    expect(shard.balances[b]).toBe(1005);
    expect(games[2].state.payments.map((p) => [p.to, p.amount, p.ok])).toEqual(expect.arrayContaining([[b, 5, true], [c, 5, true]]));
    expect(games[0].state.balance).toBe(990);
    await expect(games[0].pay({ mode: "split", amount: 7, recipients: [b, c] })).rejects.toThrow(/split evenly/);
    await expect(games[0].pay({ mode: "each", amount: 5000, recipients: [b] })).rejects.toThrow(/balance/);
  });

  it("refuses payments to anyone outside the instance", async () => {
    const { shard, ps } = table(2);
    expect(shard.pay(ps[0].address, ["1111outsider"], [5], null)).toEqual([false, "every recipient must be a participant"]);
    expect(shard.pay(ps[0].address, [ps[0].address], [5], null)).toEqual([false, "you cannot pay yourself"]);
  });

  it("orders the wheel by distance from your cell", async () => {
    const { games } = table(6, { capacity: 37, seating: "random", palette: null, messageLimit: 2048 });
    for (const g of games) await g.start();
    await games[0].refresh();
    const g = games[0];
    const d = g.wheel("near").map((a) => {
      const [q, r] = g.state.seats[a].cell, [mq, mr] = g.myCell;
      return Math.max(Math.abs(q - mq), Math.abs(r - mr), Math.abs(q - mq + r - mr));
    });
    expect(d).toEqual([...d].sort((x, y) => x - y));
    expect(g.wheel("name")).toHaveLength(5);
  });

  it("freezes a closed game and keeps its full history", async () => {
    const { games, shard } = table(2);
    for (const g of games) await g.start();
    shard.inst.status = "active";
    await games[0].refresh();
    await games[0].paint("#000000"); await games[0].refresh(); await games[0].paint("#FFFFFF"); await games[0].refresh();
    shard.inst.status = "closed";
    await games[0].refresh();
    await expect(games[0].paint("#F3D630")).rejects.toThrow();
    const h = await games[0].history();
    expect(h.map((p) => p.colour)).toEqual(["#000000", "#FFFFFF"]);
    expect(cellsFor(games[0].state.board.radius)).toBe(19);
  });
});
