import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeShard, DEMO_CONFIG } from "../src/core/fake.js";
import { InkGame } from "../src/core/game.js";
import { App } from "../src/ui/App.jsx";
import { Playback } from "../src/preview.jsx";

function setup({ entered = true, flags = ["public", "public", "private", "public", "public"] } = {}) {
  const shard = new FakeShard({ config: DEMO_CONFIG });
  const names = ["Abed Nadir", "Britta Perry", "Troy Barnes", "Annie Edison", "Shirley Bennett"];
  const ps = names.map((name, i) => shard.addPlayer({ name }, { host: i === 0 }));
  for (let i = 1; i < ps.length; i++) shard.enter(ps[i].address, ps[i].pk, flags[i]);
  if (entered) shard.enter(ps[0].address, ps[0].pk, flags[0]);
  shard.inst.status = "active";
  shard.block();
  const game = new InkGame(shard.bridge(ps[0].address, { onPay: async () => true }), { instance: shard.instanceId, pollMs: 60_000, now: () => shard.ts });
  return { shard, ps, game };
}

describe("the F1R3Ink client", () => {
  it("asks for a visibility on entry, with nothing preselected", async () => {
    const { shard, ps, game } = setup({ entered: false });
    render(<App game={game} />);
    const dialog = await screen.findByRole("dialog", { name: "Enter the round" });
    const enter = within(dialog).getByRole("button", { name: "Enter" });
    expect(enter).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: /Public/ })).not.toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Private/ })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Private/ }));
    await userEvent.type(within(dialog).getByLabelText("entry tags"), "quiet, new here");
    await userEvent.click(enter);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Enter the round" })).toBeNull());
    expect(shard.get(["p", ps[0].address])).toMatchObject({ flag: "private", tags: ["quiet", "new here"] });
  });

  it("lays out you and the wheel; inks the one selected player from the palette", async () => {
    const { shard, ps, game } = setup();
    render(<App game={game} />);
    await screen.findByLabelText("You");
    expect(screen.getByLabelText("Players")).toBeInTheDocument();
    expect(screen.getByLabelText("Messages")).toBeInTheDocument();
    expect(screen.getByLabelText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Britta Perry/ }));
    const control = await screen.findByLabelText("ink Britta Perry");
    await userEvent.click(within(control).getByRole("radio", { name: "colour 4, #BFEF45" }));
    await userEvent.click(within(control).getByRole("button", { name: "Ink" }));
    await act(() => game.refresh());
    expect(shard.get(["s", ps[1].address, ps[0].address])).toMatchObject({ seq: 1, ink: { c: 3 }, by: ps[0].address });
    // Her flag now carries my stripe, described by number and hex, with steps left.
    expect(screen.getAllByRole("img", { name: /colour 4, #BFEF45, your stripe, 10 of 10 steps left/ }).length).toBeGreaterThan(0);
    // A private flag shows a lock, and only my stripe.
    await userEvent.click(screen.getByRole("button", { name: /Britta Perry/ }));
    await userEvent.click(screen.getByRole("button", { name: /Troy Barnes/ }));
    const troy = await screen.findByLabelText("ink Troy Barnes");
    expect(within(troy).getByText(/sealed to them and you/)).toBeInTheDocument();
  });

  it("opens a stripe's history on right-click", async () => {
    const { shard, ps, game } = setup();
    shard.ink(ps[1].address, ps[0].address, { c: 2 }); shard.block(DEMO_CONFIG.minInterval);
    shard.ink(ps[1].address, ps[0].address, { c: 5 }); shard.block();
    render(<App game={game} />);
    await screen.findByLabelText("You");
    await act(() => game.refresh());
    const stripe = within(screen.getByLabelText("You")).getByRole("img", { name: /colour 6, #42D4F4, by Britta Perry/ });
    fireEvent.contextMenu(stripe);
    const pop = await screen.findByRole("dialog", { name: "stripe history" });
    await within(pop).findByText("6 · #42D4F4");
    expect(within(pop).getByText("3 · #FFE119")).toBeInTheDocument();
  });

  it("switches the wheel to the spectrum and the trend", async () => {
    const { shard, ps, game } = setup();
    shard.ink(ps[1].address, ps[3].address, { c: 0 }); shard.block();
    render(<App game={game} />);
    await screen.findByLabelText("You");
    await act(() => game.refresh());
    await userEvent.click(screen.getByRole("tab", { name: "spectrum" }));
    const sp = await screen.findByLabelText("Spectrum");
    expect(within(sp).getByText("4 of 5 flags")).toBeInTheDocument();
    expect(within(sp).getByText(/1 private flag is not in the picture/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "trend" }));
    expect(await screen.findByLabelText("Trend")).toBeInTheDocument();
  });

  it("renders a published round", async () => {
    const { shard, ps, game } = setup();
    await game.start();
    shard.ink(ps[1].address, ps[3].address, { c: 0 }); shard.block();
    await game.refresh();
    await game.publishRound("A round", 1, shard.height + 1);
    const p = shard.plays[0];
    render(<Playback kind="round" header={p} body={p.body} />);
    expect(screen.getByText("A round")).toBeInTheDocument();
    expect(screen.getByLabelText("block")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /colour 1, #E6194B/ }).length).toBeGreaterThan(0);
  });
});
