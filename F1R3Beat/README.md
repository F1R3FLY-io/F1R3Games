# F1R3Beat

One step each. Make a groove together.

F1R3Beat is a multiplayer game on a grid: five rows (drums, bass, guitar,
keys, sax) by as many columns as the meter, bars and subdivision chosen at
setup give. Each player controls exactly one cell, and the only move on the
grid is choosing what it plays: one pitch from its row's palette (the kit, for
the drum row), or nothing. Every note lasts one column. Each player hears the
loop at a tempo of their own. Players message one another and send one
another F1R3Cap, so any groove larger than one cell has to be negotiated.
Published patterns breed: the ones people engage with most are crossed, and
a bred pattern can seed the next game. The design is `docs/f1r3beat-design.pdf`
(version 2, 6 October 2026).

## Where the parts live

| Part | Path | Language |
|---|---|---|
| Game environment (state, moves, reads, breeder) | `Portal/f1r3games-portal/templates/games/f1r3beat.rho` | f1r3lang |
| Shape, palettes, seating, score bridge, encodings, reproduction | `Portal/f1r3games-portal/crates/games/src/beat.rs` | Rust |
| The breeder (`f1r3games beat …`) | `Portal/f1r3games-portal/crates/cli/src/beat.rs` | Rust |
| Host protocol: `gallery`, `playBody`, `counts` | `Portal/f1r3games-portal/web/src/core/host.ts` | TypeScript |
| Game client and gallery renderers | `F1R3Beat/client` | JavaScript, React |
| Shared test vectors | `F1R3Beat/vectors/beat-vectors.json` | JSON |

`F1R3Beat/UI` and `F1R3Beat/Shard` are the March 2026 prototype. They are kept
as research and are superseded; do not deploy them.

## The client

```sh
cd F1R3Beat/client
npm install
npm test          # core (held to the vectors), game logic against an in-memory shard, and UI
npm run dev       # without ?portal=… it runs a demo with seven simulated players
npm run build     # dist/ is served at <entry-base>/f1r3beat/
npm run vectors   # regenerate ../vectors/beat-vectors.json (then rerun the Rust tests)
```

Framed by the Portal it is loaded as `<entry>?instance=<id>&portal=<origin>`
and speaks host protocol 2 (`src/core/sdk.js`). It never sees a key. The
core (`src/core/`) is framework-free: grid, seating, the score bridge,
bodies, reproduction, sound and the `BeatGame` model; `src/ui/` only renders.

## Configuration

Launch an instance with a configuration of exactly these keys; the client's
default is:

```json
{ "meter": [4, 4], "bars": 2, "column": [1, 16], "capacity": 32, "seating": "random",
  "scale": null, "tempo": 100, "seed": null, "messageLimit": 2048 }
```

`column` is `[1, k]` with k in 4, 8, 16, 32, 6, 12, 24; the meter and column
must give a whole number of columns per bar, and at most 64 columns in all.
`seating` is `random`, `row` or `claim`. `scale` is null or a kind and tonic,
such as `["minor-pentatonic", "E"]`. `seed` is null or
`{"play", "digest", "cells": [[cell, note], ...]}` (D16).

## Installing on a shard

From `Portal/f1r3games-portal` (see `docs/GAMES.md`):

```sh
# The host protocol gains gallery, playBody and counts: rebuild and redeploy the web shell.
# Raise the game environments' version so F1R3Beat's new body replaces the sequencer.
f1r3games-service -c f1r3games.toml games-install --keys game-keys --version <installed + 1>
f1r3games-service games-manifests --keys game-keys --entry-base https://<where clients live> --out manifests.json
f1r3games register-games manifests.json      # with the Cooperative's key active
```

Then name the breeder and run epochs as `docs/GAMES.md` describes.

## Status

Verified:
* the environment and every F1R3Beat call template parse with the node's own parser;
* every play template passes the wallet's rule that game templates bind no deployer authority;
* Rust and JavaScript agree on every shared vector: shapes, palettes, seating,
  canonical scores and digests, both bodies, the generator (which is
  F1R3Score's, checked against `score-chance`), broods, crosses and epochs;
* with `F1R3SCORE=<path to f1r3score>`, F1R3Score accepts every canonical
  score and plays exactly the grid's notes;
* an epoch recomputes from its record;
* the client plays full games against an in-memory shard that mirrors the
  environment, and the host's gallery methods answer only for the game's own plays.

Not yet verified: the environment running on a shard, and its phlo costs.
Install and try one `seat`, one `set` and one `grid` read first; then one
epoch with `--dry-run`.
