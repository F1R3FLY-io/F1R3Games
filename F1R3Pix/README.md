# F1R3Pix

One hexagon each. Make something together.

F1R3Pix is a multiplayer game on a hexagonal board. Each player controls
exactly one hexagon, and the only move on the board is changing its colour.
Players can also message one another and send one another F1R3Cap, so any
image larger than one cell has to be negotiated. The design is
`docs/f1r3pix-design.pdf` (5 October 2026).

## Where the parts live

| Part | Path | Language |
|---|---|---|
| Game environment (state, moves, reads) | `Portal/f1r3games-portal/templates/games/f1r3pix.rho` | f1r3lang |
| Payments between participants | `payments` domain in `Portal/f1r3games-portal/templates/env.rho` | f1r3lang |
| Game client and gallery renderer | `F1R3Pix/client` | JavaScript, React |
| Envelope opening (wallet) | `Portal/f1r3games-portal/crates/wallet/src/envelope.rs` | Rust → WASM |
| Host protocol 2 (`pay`, `open`, …) | `Portal/f1r3games-portal/web/src/core/host.ts` | TypeScript |
| Board, seating, encodings for verification | `Portal/f1r3games-portal/crates/games/src/pix.rs` | Rust |
| Shared test vectors | `F1R3Pix/vectors/pix-vectors.json` | JSON |

`F1R3Pix/UI` and `F1R3Pix/Shard` are the March 2026 prototype. They are kept as
research and are superseded; do not deploy them.

## The client

```sh
cd F1R3Pix/client
npm install
npm test          # core, game logic against an in-memory shard, and UI
npm run dev       # without ?portal=… it runs a demo with five simulated players
npm run build     # dist/ is served at <entry-base>/f1r3pix/
npm run vectors   # regenerate ../vectors/pix-vectors.json (then rerun the Rust tests)
```

Framed by the Portal it is loaded as `<entry>?instance=<id>&portal=<origin>`
and speaks host protocol 2 (`src/core/sdk.js`). It never sees a key:
moves are signed by the Portal wallet within the launch allowance, payments
are prompted in the Portal, and envelopes are opened by the wallet.

`src/core/` is framework-free (board, seating, colours, amounts, history and
encodings, envelopes, the `PixGame` model); `src/ui/` only renders. A
f1r3lang page in F1R3Gaze would hold the same bridge capability and run the
same steps.

## Installing on a shard

From `Portal/f1r3games-portal` (see `docs/GAMES.md`):

```sh
# 1. The portal environment gains `payments`: raise env_version in f1r3games.toml.
#    An upgrade re-initialises the portal environment's state (docs/IMPLEMENTATION.md).
f1r3games-service -c f1r3games.toml bootstrap
# 2. Raise the game environments' version so F1R3Pix's new body replaces the canvas.
f1r3games-service -c f1r3games.toml games-install --keys game-keys --version 2
# 3. Regenerate and re-register the manifests (template hashes changed).
f1r3games-service games-manifests --keys game-keys --entry-base https://<where clients live> --out manifests.json
f1r3games register-games manifests.json      # with the Cooperative's key active
```

Launch an instance with a configuration of exactly
`{capacity, seating, palette, messageLimit}`; the client's default is
`{capacity: 61, seating: "random", palette: null, messageLimit: 2048}`.

## Status

Verified: every template parses with the node's own parser; Rust and
JavaScript agree on every shared vector; an envelope sealed by the client
opens in the Rust wallet only for its parties and only under its game and
instance; the wallet refuses payments from game frames; the client's tests
play full games against an in-memory shard that mirrors the environment.

Not yet verified: the environment running on a shard, and its phlo costs.
Install and try one `seat`, one `paint` and one `board` read first.
