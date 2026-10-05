// Test harness: the real Rust wallet (WASM, loaded in Node), the real
// f1r3games-service, and a mock node that verifies every deploy signature
// (crates/service/examples/testbed.rs).

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import type { WalletWasm } from "../core/wallet";

// vitest runs from web/; the workspace root is one level up.
const root = resolve(process.cwd(), "..");

export async function loadWalletNode(): Promise<WalletWasm> {
  const m: any = await import("../wasm/f1r3games_wallet.js");
  m.initSync({ module: readFileSync(resolve(process.cwd(), "src/wasm/f1r3games_wallet_bg.wasm")) });
  return m as WalletWasm;
}

export interface Testbed {
  service: string;
  node: string;
  stop(): void;
  canned(needle: string, expr: unknown): Promise<void>;
  deploys(): Promise<{ id: string; term: string; deployer: string; timestamp: number }[]>;
  reset(): Promise<void>;
}

export const COOP = "1111PXDQTDEd4XNuX4YWoB6XeL7ssWvhePGD2XmkENkG5sHfAMW9Q";

export async function startTestbed(np: number, sp: number): Promise<Testbed> {
  const proc: ChildProcess = spawn(`${root}/target/debug/examples/testbed`, [String(np), String(sp), COOP], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on("data", (d: Buffer) => String(d).includes("testbed ready") && resolve());
    proc.on("exit", (c: number | null) => reject(new Error(`testbed exited ${c}`)));
  });
  const node = `http://127.0.0.1:${np}`;
  return {
    service: `http://127.0.0.1:${sp}`,
    node,
    stop: () => proc.kill(),
    canned: async (needle, expr) => {
      await fetch(`${node}/__mock/explore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ needle, expr }) });
    },
    deploys: async () => (await fetch(`${node}/__mock/deploys`)).json(),
    reset: async () => {
      await fetch(`${node}/__mock/reset`, { method: "POST" });
    },
  };
}

// ---- RhoExpr builders, as the node returns values

export const R = {
  str: (s: string) => ({ ExprString: { data: s } }),
  int: (n: number) => ({ ExprInt: { data: n } }),
  bool: (b: boolean) => ({ ExprBool: { data: b } }),
  list: (xs: unknown[]) => ({ ExprList: { data: xs } }),
  map: (o: Record<string, unknown>) => ({ ExprMap: { data: o } }),
  ok: (v: unknown) => ({ ExprTuple: { data: [{ ExprBool: { data: true } }, v] } }),
};

export function hashHex(source: string): string {
  return Array.from(blake2b(new TextEncoder().encode(source), { dkLen: 32 }), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const PLACE = "new deployId(`rho:system:deployId`) in { deployId!(({{x}}, {{y}}, {{colour}})) }";

/** A game manifest as RhoExpr, with one play template. */
export function pixManifest(entry = "https://pix.example") {
  return R.map({
    id: R.str("f1r3pix"),
    name: R.str("F1R3Pix"),
    tagline: R.str("Collective visual intelligence"),
    entry: R.str(entry),
    status: R.str("active"),
    contactsDialogue: R.bool(true),
    galleries: R.list([R.map({ kind: R.str("canvas") })]),
    templates: R.list([R.map({ id: R.str("pix.place"), kind: R.str("deploy"), hash: R.str(hashHex(PLACE)), source: R.str(PLACE), play: R.bool(true) })]),
  });
}

export function playHeader(id: string, title: string, createdAt: number) {
  return R.map({
    id: R.str(id),
    game: R.str("f1r3pix"),
    kind: R.str("canvas"),
    instance: R.str("inst0"),
    title: R.str(title),
    authors: R.list([R.str(COOP)]),
    createdAt: R.int(createdAt),
    version: R.int(0),
    links: R.list([]),
    bodyHash: R.str("00"),
  });
}
