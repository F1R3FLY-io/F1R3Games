// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Portal, unescapeRho, type ConsentRequest } from "../core/portal";
import { GameHost } from "../core/host";
import { HttpService } from "../core/service";
import { MemoryStore } from "../core/store";
import type { WalletWasm } from "../core/wallet";
import { loadWalletNode, pixManifest, R, startTestbed, type Testbed } from "./harness";
// The F1R3Pix client's sealing, so an envelope made exactly as the game makes it is opened by this wallet.
// @ts-expect-error plain JavaScript module from the game client
import { seal } from "../../../../../F1R3Pix/client/src/core/envelope.js";
// F1R3Ink's sealed inks (version 2 envelopes, unlabelled wraps), made as its client makes them.
// @ts-expect-error plain JavaScript module from the game client
import { sealInk } from "../../../../../F1R3Ink/client/src/core/envelope.js";

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

  it("protocol 2: pay and open need declared capabilities", async () => {
    const p = await boot();
    await tb.canned('"games", "get"', R.ok(pixManifest()));
    const game = (await p.game("f1r3pix"))!;
    const host = new GameHost(p, game, "inst1", () => null, { openInvite: () => undefined });
    expect(await host.dispatch("pay", { to: ["x"], amounts: [1] })).toEqual(["err", "refused", "f1r3pix did not declare the pay capability"]);
    expect((await host.dispatch("open", { envelope: "00" }))[1]).toBe("refused");
    expect((await host.dispatch("teleport", {}))[1]).toBe("unknown-method");
  });

  it("protocol 2: pay refuses outsiders before any prompt, and prompts a payment to participants", async () => {
    const p = await boot();
    const me = p.wallet.address;
    const friend = "1111aqq7mDkxjtYmLanT2sPVZ67HcmhMdBwr8wjAhE2B4kVRxJHM7";
    await tb.canned('"games", "get"', R.ok({ ExprMap: { data: { ...(pixManifest() as any).ExprMap.data, capabilities: R.list([R.str("pay"), R.str("open")]) } } }));
    await tb.canned('"instances", "get"', R.ok(R.map({
      id: R.str("inst1"), game: R.str("f1r3pix"), host: R.str(me), status: R.str("active"), visibility: R.str("unlisted"), createdAt: R.int(1),
      config: R.map({}), participants: R.map({ [me]: R.map({ role: R.str("host"), joinedAt: R.int(1) }), [friend]: R.map({ role: R.str("player"), joinedAt: R.int(2) }) }),
    })));
    const game = (await p.game("f1r3pix"))!;
    p.enterGame(game, "inst1", 1_000_000);
    const host = new GameHost(p, game, "inst1", () => null, { openInvite: () => undefined });
    asked = [];
    const outsider = await host.dispatch("pay", { to: ["1111cPs1DgpVHU8bwXzvR4gG8tRxE4oD6NQ2c8SxbfTjK9uWzM2E"], amounts: [5], memo: null });
    expect(outsider[0]).toBe("err");
    expect(outsider[1]).toBe("not-participant");
    expect(asked).toHaveLength(0);
    expect(await tb.deploys()).toHaveLength(0);
    const ok = await host.dispatch("pay", { to: [friend], amounts: [5], memo: "go blue" });
    expect(ok[0]).toBe("ok");
    expect(asked).toHaveLength(1);
    expect(asked[0].origin).toBe("portal");
    expect(asked[0].summary).toMatch(/^PAYMENT of 5 from your vault to 1 player/);
    const [d] = await tb.deploys();
    expect(d.term).toContain(`@env!("payments", "send", "inst1", [["${friend}", 5]], "go blue", *deployId)`);
    answer = false;
    expect((await host.dispatch("pay", { to: [friend], amounts: [5] }))[1]).toBe("declined");
  });

  it("protocol 2: open reads an envelope sealed by the game, only under the hosted game and instance", async () => {
    const p = await boot();
    await tb.canned('"games", "get"', R.ok({ ExprMap: { data: { ...(pixManifest() as any).ExprMap.data, capabilities: R.list([R.str("pay"), R.str("open")]) } } }));
    const game = (await p.game("f1r3pix"))!;
    const me = { address: p.wallet.address, pk: p.wallet.publicKey };
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const env = hex(seal({ game: "f1r3pix", instance: "inst1", sender: me, recipients: [me], text: "five each if you turn blue" }));
    const host = new GameHost(p, game, "inst1", () => null, { openInvite: () => undefined });
    expect(await host.dispatch("open", { envelope: env })).toEqual(["ok", { sender: me.address, text: "five each if you turn blue" }]);
    const elsewhere = new GameHost(p, game, "inst2", () => null, { openInvite: () => undefined });
    expect((await elsewhere.dispatch("open", { envelope: env }))[0]).toBe("err");
    expect((await host.dispatch("open", { envelope: "zz" }))[0]).toBe("err");
    // The wallet rate-limits opening.
    p.wallet.openRate = 2;
    await host.dispatch("open", { envelope: env });
    expect((await host.dispatch("open", { envelope: env }))[1]).toBe("rate-limited");
  });

  it("opens an F1R3Ink sealed ink for a party and signs relay requests only for the active address", async () => {
    const p = await boot();
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const other = "04" + "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
    const { bytes, key } = sealInk({ game: "f1r3ink", instance: "inst1", target: "1111target", sid: p.wallet.address, seq: 2, parties: [other, p.wallet.publicKey], colour: 7 });
    const ink = { id: "f1r3ink", name: "F1R3Ink", entry: "https://ink.example/", galleries: [], templates: [], capabilities: ["pay", "open", "relay"] };
    const host = new GameHost(p, ink, "inst1", () => null, { openInvite: () => undefined });
    expect(await host.dispatch("open", { envelope: hex(bytes) })).toEqual(["ok", { kind: "ink", target: "1111target", sid: p.wallet.address, seq: 2, colour: 7, key: hex(key) }]);
    // Bound to its instance: the same envelope does not open elsewhere.
    const elsewhere = new GameHost(p, ink, "inst2", () => null, { openInvite: () => undefined });
    expect((await elsewhere.dispatch("open", { envelope: hex(bytes) }))[0]).toBe("err");
    const m = (address: string) => JSON.stringify({ v: 1, game: "f1r3ink", instance: "inst1", relay: "https://r.example/api/relay/f1r3ink", op: "ink", params: {}, address, at: 1 });
    const s = p.wallet.signRelay(m(p.wallet.address));
    expect(s.publicKey).toBe(p.wallet.publicKey);
    expect(s.signature).toMatch(/^30[0-9a-f]+$/);
    expect(() => p.wallet.signRelay(m("1111PXDQTDEd4XNuX4YWoB6XeL7ssWvhePGD2XmkENkG5sHfAMW9Q"))).toThrow();
    expect(() => p.wallet.signRelay("not a relay message")).toThrow();
  });

  it("accepts a template source read back with its escapes still in, but only if it matches the listed hash", async () => {
    expect(unescapeRho('@env!(\\"seat\\", {{instance}})')).toBe('@env!("seat", {{instance}})');
    expect(unescapeRho("a\\\\b")).toBe("a\\b");
    const p = await boot();
    const src = 'new deployId(`rho:system:deployId`) in { deployId!(("seat", {{x}})) }';
    const { hashHex } = await import("./harness");
    const escaped = src.replace(/"/g, '\\"');
    const game = { id: "g", name: "G", entry: "https://g.example/", galleries: [], templates: [{ id: "g.seat", kind: "deploy" as const, hash: hashHex(src), source: escaped, play: true }] };
    expect(() => p.enterGame(game, "inst", 1000)).not.toThrow();
    const forged = { ...game, templates: [{ ...game.templates[0], source: escaped.replace("seat", "steal") }] };
    expect(() => p.enterGame(forged, "inst", 1000)).toThrow();
  });
});
