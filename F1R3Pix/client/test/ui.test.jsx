import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeShard } from "../src/core/fake.js";
import { PixGame } from "../src/core/game.js";
import { App } from "../src/ui/App.jsx";
import { Playback } from "../src/preview.jsx";
import { buildPlay } from "../src/core/publish.js";
import { orderPaints } from "../src/core/history.js";
import { key } from "../src/core/hex.js";

function setup() {
  const shard = new FakeShard({ config: { capacity: 19, seating: "random", palette: null, messageLimit: 2048 } });
  const me = shard.addPlayer({ name: "Abed Nadir" }, { host: true });
  const others = ["Britta Perry", "Troy Barnes"].map((name) => shard.addPlayer({ name }));
  for (const p of others) shard.seat(p.address, p.pk, null);
  shard.inst.status = "active";
  const approvals = [];
  const game = new PixGame(shard.bridge(me.address, { onPay: async (to, amounts) => { approvals.push([to, amounts]); return true; } }), { instance: shard.instanceId, pollMs: 60_000 });
  return { shard, me, others, game, approvals };
}

describe("the F1R3Pix client", () => {
  it("lays out tokens, the board and players, and paints your own cell", async () => {
    const { shard, game, me } = setup();
    render(<App game={game} />);
    await screen.findByLabelText("Tokens");
    await waitFor(() => expect(game.myCell).not.toBeNull());
    await act(() => game.refresh());
    expect(screen.getByLabelText("Board")).toBeInTheDocument();
    expect(screen.getByLabelText("Players")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    const mine = screen.getByRole("gridcell", { name: /your cell/ });
    await userEvent.click(mine);
    await userEvent.click(screen.getByRole("button", { name: "#3FA9F5" }));
    await act(() => game.refresh());
    expect(shard.get(["cell", ...game.myCell]).colour).toBe("#3FA9F5");
    expect(screen.getByRole("gridcell", { name: /your cell, #3FA9F5/ })).toBeInTheDocument();
  });

  it("selects players from the wheel or the board, highlights them, and messages and pays them", async () => {
    const { shard, game, others, approvals } = setup();
    render(<App game={game} />);
    await waitFor(() => expect(game.myCell).not.toBeNull());
    await act(() => game.refresh());
    const players = screen.getByRole("region", { name: "Players" });
    await userEvent.click(within(players).getByRole("button", { name: /Britta Perry/ }));
    const troyCell = shard.get(["seat", others[1].address]).cell;
    await userEvent.click(document.querySelector(`[data-cell="${key(...troyCell)}"]`));
    expect(document.querySelectorAll(".sel-outline")).toHaveLength(2);
    await userEvent.type(screen.getByLabelText("message"), "blue for five each?");
    await userEvent.click(within(players).getByRole("button", { name: "Send" }));
    await act(() => game.refresh());
    expect(shard.mail(others[0].address)[1]).toHaveLength(1);
    expect(screen.getAllByText("blue for five each?").length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText("amount"), "5");
    expect(screen.getByText("5 each to 2 players: 10 F1R3Cap")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("region", { name: "Tokens" })).getByRole("button", { name: "Send" }));
    await act(() => game.refresh());
    expect(approvals).toHaveLength(1);
    expect(shard.balances[others[0].address]).toBe(1005);
    expect(within(screen.getByRole("region", { name: "Tokens" })).getAllByText(/5 →/).length).toBe(2);
  });

  it("plays a published body back in the gallery renderer", async () => {
    const paints = orderPaints([[1, 0, "a", 0, 0, "#000000"], [2, 0, "b", 1, 0, "#F3D630"], [3, 0, "a", 0, 0, "#FFFFFF"]]);
    const { header, bodyHex } = buildPlay({ radius: 1, seats: { a: { cell: [0, 0] }, b: { cell: [1, 0] } }, paints, from: 1, to: 4, title: "A rose", players: 2 });
    render(<Playback header={header} body={bodyHex} />);
    expect(screen.getByText("A rose")).toBeInTheDocument();
    expect(screen.getByLabelText("block")).toBeInTheDocument();
    expect(document.querySelectorAll("polygon[fill='#FFFFFF']")).toHaveLength(1);
  });
});
