# F1R3Games Portal — Rust implementation

Implements *The F1R3Games Portal: Design Document* v0.1 (5 October 2026) with
the decisions taken on it:

| Decision | Where it lives |
|---|---|
| A wallet specific to F1R3Games, informed by Embers but its own implementation | `crates/wallet` (shares only the portable key file format with F1R3Sky / F1R3Gaze) |
| Keystore unlock by passphrase **and** passkey | `wallet::keystore` — one data key, wrapped by PBKDF2 (passphrase) and by HKDF over the WebAuthn PRF output (passkey) |
| Large bodies on chain | `plays.publish` / `plays.saveVersion` keep bodies on chain by version; the storage call is one place in `templates/env.rho` for the F1R3Drive large-file work to refine |
| Contacts: on-chain backup available, client-only by choice | `wallet::contacts` (`StorageMode::ClientOnly` default, `OnChainBackup` opt-in; ciphertext only, padded) and `contacts.save/get/delete` |
| Stipends and sponsorships | `sponsors.*` in `templates/env.rho`: escrow vaults held by the environment, terms with creative, targeted games, stipend, per-address cap, expiry; claimed on joining or on redeeming an invitation; withdrawable after expiry |
| Governance by the F1R3FLY.io Cooperative | `games.register` / `games.retire` accept only `coop_address` |
| Unlisted by default | `f1r3games launch` defaults to `unlisted`; unlisted and public instances admit anyone with the id, private ones only by invitation |

## Layout

```
templates/env.rho          the `games` environment (insertSigned, versioned)
templates/transfer.rho     the wallet's vault transfer
templates/env_probe.rho    reads the registered environment version
crates/core                addresses, key files, deploys, registry signing, typed Rholang,
                           template catalogue (every env method's call template), invites, ids
crates/wallet              keystore, signing policy, allowances, contacts; `wasm` feature = browser bindings
crates/node                F1R3Node-Rust HTTP client (validator for deploys, observer for reads)
crates/service             axum service: prepare/send, explore/read routes, env bootstrap, testnet faucet
crates/cli                 `f1r3games`, a Rust client using the wallet
crates/games               the five games: their environments, call templates and manifests (docs/GAMES.md)
templates/games/           each game's environment (prelude.rho + one body per game)
crates/rholint             parses every template with the node's own Rholang parser
web/                       the portal shell: React + TypeScript over the Rust wallet (WASM)
  src/core/                framework-free operations and the capabilities they use (see docs/GAZE-MAPPING.md)
  src/ui/                  pages: feed, sign-on, games, galleries, play, launch, lobby, game frame,
                           invitation redemption, wallet, contacts, sponsors; consent and invite dialogs
  src/game-sdk.ts          what a game includes to talk to the portal that frames it
  src/test/                core and UI tests against the real service + a verifying mock node
```

## Build and test

Requires Rust ≥ 1.85.

```sh
cargo test                                   # core, wallet, node, service, cli
RUSTC_BOOTSTRAP=1 cargo test -p f1r3games-rholint   # the node's parser needs this on stable
cargo check -p f1r3games-wallet --features wasm     # browser bindings (type-check)
```

## The web shell

```sh
cd web && npm install
npm run wasm          # builds crates/wallet to WebAssembly + bindings (needs wasm32 target, wasm-bindgen-cli 0.2.129)
cargo build -p f1r3games-service --example testbed   # (from the workspace root) for the tests
npm test              # 10 tests: core against the real service, and the UI in jsdom
npm run dev           # Vite on :5173, proxying /api to the service on :8640
npm run build         # web/dist, which f1r3games-service serves (static_dir)
```

Pages: `/` feed · `/signon` · `/games` · `/games/:id/gallery` · `/games/:id/launch` ·
`/plays/:id` · `/instances/:id` (lobby, invite, start/close, claim stipends) ·
`/instances/:id/play` (game frame + host protocol) · `/i/:id#i=…` (redeem) ·
`/wallet` · `/contacts` · `/sponsors`.

A game registers a manifest (by the Cooperative) listing its entry URL, gallery
kinds with optional preview renderers, and its templates with their hashes;
the service renders a game's templates only from that manifest, and the
wallet signs them only as registered, within the allowance set at launch.

## Registering the games

See `docs/GAMES.md`: `games-keygen`, `games-install`, `games-manifests`, then
`f1r3games register-games manifests.json` with the Cooperative's key.

## Run against a local shard (ign1t10n)

```sh
f1r3games-service keygen --dir .             # service-key.json, env-key.json, token-secret.hex
# fund the service key's address from the shard's genesis/faucet wallet, then:
cp examples/f1r3games.toml . && $EDITOR f1r3games.toml
f1r3games-service -c f1r3games.toml          # installs the environment, then serves on :8640
F1R3GAMES_PASSPHRASE=… f1r3games init        # keystore + first key; pins the environment
f1r3games faucet && f1r3games profile --name Ada
f1r3games launch f1r3pix                     # unlisted instance; prints its id
f1r3games invite create <instance-id>        # prints the invitation link
```

See `docs/IMPLEMENTATION.md` for conformance evidence and what remains to be
verified on a live shard.
