import { describe, expect, it } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeShard, DEMO_CONFIG } from "../src/core/fake.js";
import { BeatGame } from "../src/core/game.js";
import { App } from "../src/ui/App.jsx";
import { Playback } from "../src/preview.jsx";
import { buildPattern, buildSession } from "../src/core/publish.js";
import { shapeOf, rowOf } from "../src/core/grid.js";
import vectors from "../../vectors/beat-vectors.json";

const quiet = { playing: false, setPattern() {}, setTempo() {}, start() { this.playing = true; }, stop() { this.playing = false; } };

function setup(config = { ...DEMO_CONFIG, seating: "row" }) {
  const shard = new FakeShard({ config });
  const me = shard.addPlayer({ name: "Abed Nadir" }, { host: true });
  const others = ["Britta Perry", "Troy Barnes"].map((name) => shard.addPlayer({ name }));
  shard.seat(others[0].address, others[0].pk, 0);
  shard.seat(others[1].address, others[1].pk, 1);
  shard.inst.status = "active";
  const game = new BeatGame(shard.bridge(me.address, { onPay: async () => true }), { instance: shard.instanceId, pollMs: 60_000 });
  return { shard, me, others, game };
}

describe("the F1R3Beat client", () => {
  it("lays out tokens, the grid and players; takes a row; plays your cell", async () => {
    const { shard, game } = setup();
    render(<App game={game} player={{ ...quiet }} />);
    await screen.findByLabelText("Tokens");
    expect(screen.getByLabelText("Grid")).toBeInTheDocument();
    expect(screen.getByLabelText("Players")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    // Row seating: choose the sax row by clicking any of its cells.
    await userEvent.click(screen.getAllByRole("gridcell").find((c) => Number(c.dataset.cell) % 5 === 4));
    await act(() => game.refresh());
    expect(rowOf(game.myCell)).toBe(4);
    await userEvent.click(screen.getByRole("gridcell", { name: /your cell/ }));
    await userEvent.click(screen.getByRole("button", { name: "E4" }));
    await act(() => game.refresh());
    expect(shard.get(["cell", game.myCell]).note).toBe("E4");
    expect(screen.getByRole("gridcell", { name: /your cell, sax, step \d+, E4/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "C#4" })).toBeEnabled();
    // The strip spans the sax's range only: G#2 to D#5.
    expect(screen.queryByRole("button", { name: "G2" })).toBeNull();
    expect(screen.getByRole("button", { name: "G#2" })).toBeEnabled();
  });

  it("changes the listening tempo locally", async () => {
    const { game } = setup();
    render(<App game={game} player={{ ...quiet }} />);
    const bpm = await screen.findByLabelText("bpm");
    await userEvent.clear(bpm);
    await userEvent.type(bpm, "88{Enter}");
    expect(game.tempo).toBe(88);
  });

  it("renders a published pattern and a session", async () => {
    const p = { shape: shapeOf(...vectors.scores.mother.shape), cells: vectors.scores.mother.cells };
    const { header, bodyHex } = buildPattern({ pattern: p, title: "Mother", tempo: 92 });
    render(<Playback kind="pattern" header={header} body={bodyHex} player={{ ...quiet }} />);
    expect(screen.getByText("Mother")).toBeInTheDocument();
    expect(screen.getAllByText("snare")).toHaveLength(2);
    const s = buildSession({ shape: shapeOf(4, 4, 2, 16), from: 10, to: 16, sets: vectors.session.sets, title: "A session", players: 3 });
    render(<Playback kind="session" header={s.header} body={s.bodyHex} player={{ ...quiet }} />);
    expect(screen.getByText("A session")).toBeInTheDocument();
    expect(screen.getByLabelText("block")).toBeInTheDocument();
  });
});
