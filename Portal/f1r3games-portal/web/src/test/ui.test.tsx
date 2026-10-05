import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../ui/App";
import { PortalProvider } from "../ui/PortalContext";
import { HttpService } from "../core/service";
import { MemoryStore } from "../core/store";
import { loadWalletNode, pixManifest, playHeader, R, startTestbed, type Testbed } from "./harness";

let tb: Testbed;
beforeAll(async () => {
  tb = await startTestbed(47201, 47202);
});
afterAll(() => tb.stop());
beforeEach(async () => {
  await tb.reset();
  await tb.canned('"games", "list"', R.ok(R.map({ f1r3pix: pixManifest() })));
  await tb.canned('"games", "get"', R.ok(pixManifest()));
});

function mount(path: string, store = new MemoryStore()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PortalProvider loadWasm={loadWalletNode} service={new HttpService(tb.service)} store={store} iterations={1000}>
        <App />
      </PortalProvider>
    </MemoryRouter>,
  );
}

describe("the portal shell", () => {
  it("shows the feed of recent plays without signing on", async () => {
    await tb.canned('"plays", "list"', R.ok(R.list([playHeader("p1", "Sunrise over the grid", Date.now())])));
    mount("/");
    expect(await screen.findByText("Play together on the shard.")).toBeInTheDocument();
    expect((await screen.findAllByText("Sunrise over the grid")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Sign on" }).length).toBeGreaterThan(0);
  });

  it("creates a key, insists it is saved, then signs on", async () => {
    const u = userEvent.setup();
    mount("/signon");
    await u.click(await screen.findByRole("button", { name: "Create a key" }));
    const [p1, p2] = screen.getAllByLabelText(/Passphrase|Again/);
    await u.type(p1, "correct horse battery");
    await u.type(p2, "correct horse battery");
    await u.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("Your key")).toBeInTheDocument();
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    await u.click(screen.getByRole("checkbox"));
    await u.click(cont);
    expect(await screen.findByRole("button", { name: "Lock" })).toBeInTheDocument();
  });

  it("launches an unlisted instance after consent and opens its lobby", async () => {
    const u = userEvent.setup();
    const store = new MemoryStore();
    mount("/signon", store);
    await u.click(await screen.findByRole("button", { name: "Create a key" }));
    const [p1, p2] = screen.getAllByLabelText(/Passphrase|Again/);
    await u.type(p1, "correct horse battery");
    await u.type(p2, "correct horse battery");
    await u.click(screen.getByRole("button", { name: "Create key" }));
    await u.click(await screen.findByRole("checkbox"));
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: "Lock" });

    await u.click(await screen.findByRole("link", { name: "Launch" }));
    expect(await screen.findByText("Launch F1R3Pix")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Unlisted/ })).toBeChecked();
    await u.click(screen.getByRole("button", { name: "Launch" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("instances.create");
    expect(dialog).toHaveTextContent('visibility = "unlisted"');
    await u.click(screen.getByRole("button", { name: "Sign and send" }));
    await waitFor(async () => expect((await tb.deploys()).some((d) => d.term.includes('"instances", "create"'))).toBe(true));
    // The lobby reads the instance; the mock has none yet, so it says so.
    expect(await screen.findByText(/not on the shard yet/, {}, { timeout: 10000 })).toBeInTheDocument();
  });
});
