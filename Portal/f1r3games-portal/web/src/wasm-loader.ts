import type { WalletWasm } from "./core/wallet";

/** Load the Rust wallet compiled to WebAssembly (see scripts/build-wasm.sh). */
export async function loadWallet(): Promise<WalletWasm> {
  const m: any = await import("./wasm/f1r3games_wallet.js");
  await m.default();
  return m as WalletWasm;
}
