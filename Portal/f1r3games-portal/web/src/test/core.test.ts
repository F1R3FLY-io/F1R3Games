// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Portal, type ConsentRequest } from "../core/portal";
import { GameHost } from "../core/host";
import { HttpService } from "../core/service";
import { MemoryStore } from "../core/store";
import type { WalletWasm } from "../core/wallet";
import { loadWalletNode, pixManifest, R, startTestbed, type Testbed } from "./harness";

let tb: Testbed;
let wasm: WalletWasm;
let asked: ConsentRequest[] = [];
let answer = true;
const consent = { ask: async (r: ConsentRequest) => (asked.push(r), answer) };

async function boot(service = new HttpService(tb.service)) {
  const p = await Portal.boot({ wasm, service, store: new MemoryStore(), consent, iterations: 1000 });
  await p.createIdentity("correct horse battery");
  return p;
}

beforeAll(async () => {
  tb = await startTestbed(47101, 47102);
  wasm = await loadWalletNode();
});
afterAll(() => tb.stop());
beforeEach(async () => {
  await tb.reset();
  asked = [];
  answer = true;
});

describe("the portal core against the real service and a verifying node", () => {
  it("signs on, saves a profile, launches an unlisted instance", async () => {
    const p = await boot();
    expect(p.signedOn).toBe(true);
    expect(wasm.isAddress(p.wallet.address)).toBe(true);
    await p.saveProfile("Ada", ["painter"]);
    const r = await p.launch("f1r3pix");
    const ds = await tb.deploys();
    expect(ds).toHaveLength(2);
    expect(ds[0].term).toContain('@env!("profiles", "save", {"name": "Ada", "tags": ["painter"]}, *deployId)');
    expect(ds[1].term).toContain(`@env!("instances", "create", "${r.instanceId}", "f1r3pix", "unlisted", {}, *deployId)`);
    expect(asked.map((a) => a.template)).toEqual(["profiles.save", "instances.create"]);
    expect(await p.waitFor(r.deployId, 2000, 50)).toBe(true);
  });

  it("refuses to send what the person did not approve", async () => {
    const p = await boot();
    answer = false;
    await expect(p.saveProfile("Eve")).rejects.toThrow("not approved");
    expect(await tb.deploys()).toHaveLength(0);
  });

  it("refuses a service that alters the arguments it was given", async () => {
    const honest = new HttpService(tb.service);
    const evil = Object.assign(Object.create(honest), {
      prepare: async (r: any) => {
        const out = await honest.prepare(r);
        out.args.profile = { map: { name: "Mallory" } };
        return out;
      },
    });
    const p = await boot(evil);
    await expect(p.saveProfile("Ada")).rejects.toThrow("changed argument profile");
    expect(await tb.deploys()).toHaveLength(0);
  });

  it("invites, and a newcomer redeems with a signature bound to their address", async () => {
    const host = await boot();
    const { instanceId } = await host.launch("f1r3pix");
    const { link } = await host.invite(instanceId, { uses: 1 });
    expect(link).toMatch(new RegExp(`/i/${instanceId}#i=`));
    const hostAddress = host.wallet.address;
    // One wallet per page: booting the guest replaces the host's in this module.
    const guest = await boot();
    expect(guest.wallet.address).not.toBe(hostAddress);
    const r = await guest.redeem(link);
    expect(r.instanceId).toBe(instanceId);
    const ds = await tb.deploys();
    expect(ds.at(-2)!.term).toContain('@env!("invites", "issue"');
    expect(ds.at(-1)!.term).toContain('@env!("invites", "redeem"');
    expect(ds.at(-1)!.deployer).not.toBe(ds.at(-2)!.deployer);
  });

  it("reads galleries and games from the shard", async () => {
    const p = await boot();
    await tb.canned('"games", "list"', R.ok(R.map({ f1r3pix: pixManifest() })));
    await tb.canned('"plays", "list"', R.ok(R.list([R.map({ id: R.str("p1"), game: R.str("f1r3pix"), kind: R.str("canvas"), instance: R.str("i"), authors: R.list([]), createdAt: R.int(5), version: R.int(0), links: R.list([]), bodyHash: R.str("") })])));
    const games = await p.games();
    expect(games[0].name).toBe("F1R3Pix");
    const feed = await p.feed(2, games);
    expect(feed.length).toBe(2); // one per day queried
    expect(feed[0].id).toBe("p1");
  });

  it("keeps contacts encrypted locally and backs them up as ciphertext only on request", async () => {
    const p = await boot();
    const { book } = p.wallet.contactsImport({ mode: "clientOnly", contacts: [] }, "csv", "Bob, email, bob@example.org\n");
    await p.saveContacts(book);
    expect((await p.contacts()).contacts[0].name).toBe("Bob");
    await expect(p.backupContacts(book)).rejects.toThrow("on this device only");
    await p.backupContacts({ ...book, mode: "onChainBackup" });
    const [d] = await tb.deploys();
    expect(d.term).toContain('@env!("contacts", "save"');
    expect(d.term).not.toContain("bob@example.org");
  });

  it("hosts a game: its play templates are signed within the allowance, without a prompt", async () => {
    const p = await boot();
    await tb.canned('"games", "get"', R.ok(pixManifest()));
    const game = (await p.game("f1r3pix"))!;
    p.enterGame(game, "inst1", 1_000_000);
    const host = new GameHost(p, game, "inst1", () => null, { openInvite: () => undefined });
    asked = [];
    const r = await host.dispatch("deploy", { template: "pix.place", args: { x: 3, y: 4, colour: "#F3D630" } });
    expect(r[0]).toBe("ok");
    expect(asked).toHaveLength(0);
    const [d] = await tb.deploys();
    expect(d.term).toBe('new deployId(`rho:system:deployId`) in { deployId!((3, 4, "#F3D630")) }');
    // A template the game did not register is refused.
    const bad = await host.dispatch("deploy", { template: "pix.steal", args: {} });
    expect(bad[0]).toBe("err");
  });
});
