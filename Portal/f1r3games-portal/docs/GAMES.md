# The games

`crates/games` registers the five games already contemplated for F1R3Games.
Each has its own environment on the shard (live state per instance), call
templates that pin that environment by URI, and a manifest for
`games.register`. The earlier F1R3Games contracts were the research behind
the moves; their global state on public channels is replaced by per-instance
state behind an environment that checks membership against the portal.

| Game | Moves (play templates, signed within the allowance) | Prompted | Reads | Galleries |
|---|---|---|---|---|
| F1R3Pix | `seat(instance, pk, want)`; `paint(instance, colour)` (your own cell; names no cell); `say(instance, to, envelope)` | — (payments go through the portal's `payments.send`, always prompted) | `board`, `seats`, `log`, `mail`, `outbox` | canvas (whole game or a moment; body = encoded history) |
| F1R3Beat | `seat(instance, pk, want)` (random, row or claim); `set(instance, note)` (your own cell: a pitch from its row's palette, or Nil); `listen(instance, bpm)`; `say(instance, to, envelope)` | `setBreeder(address)` (F1R3Beat's key only); `epoch(epoch, record)` (the breeder only) | `grid`, `seats`, `log`, `mail`, `outbox`, `population`, `epochRecord`, `member` | pattern (the grid at a block as its canonical F1R3Score score; bred by the breeder), session (body = encoded history) |
| F1R3Ink | `tags(instance, tags)`; `ink(instance, target, colour)` | — | `state` (tags and inks per player) | round |
| F1R3SideChat | `addCharacter`, `takeWheel`, `release`, `addChapter`, `write(instance, chapter, charId, text)` as the character you drive, `comment` (any keyholder) | `meta`, `publishChapter` (host) | `state`, `chapter` (anyone: reader tier) | story |
| F1R3Skein | `setScale`, `setDistribution(instance, "pitch"\|"duration", machine)`, `perform(instance, device)` | — | `session` | performance, tune (cross-linked; tune header `parents`) |

Template ids are `<game>.<method>`. Galleries are filled by the game clients
through the host protocol (`publishPlay`, `linkPlays`); engagement
(`engage`) feeds Beat's and Skein's selection; F1R3Beat's breeder is
described below. SideChat tips move funds and
are left to the wallet and to sponsorships. Skein's tune bodies are opaque
bytes until the skein Theory lands with the f1r3lang DDL.

## Installing and registering

```sh
f1r3games-service games-keygen --dir game-keys            # one registry key per game
f1r3games-service -c f1r3games.toml games-install --keys game-keys
f1r3games-service games-manifests --keys game-keys \
    --entry-base https://games.example/play --out manifests.json
# with the F1R3FLY.io Cooperative's key active in the CLI:
f1r3games register-games manifests.json
```

Each environment URI is fixed by its key, and the URI is inside every call
template, so the template hashes in the manifest change if a key changes:
keep `game-keys/` safe, and re-register if you rotate one.

`--entry-base` is where the game clients are served: the game frame loads
`<base>/<id>/`, and the gallery loads `<base>/<id>/preview/<kind>.html`.
The game clients themselves are still to be rebuilt against
`web/src/game-sdk.ts`; until then, the games are playable from the CLI
(`f1r3games call f1r3pix.paint --game f1r3pix --args '{"instance": "…", "colour": "#F3D630"}'`).
F1R3Pix has its client: `F1R3Pix/client` (see its README), served at
`<base>/f1r3pix/` with the gallery renderer at `<base>/f1r3pix/preview/canvas.html`.

## Verified so far

* Every environment and every call template parses with the node's parser.
* Every play template passes the wallet's rule for game templates (no deployer
  authority in the term), and the environments bind no vault authority.
* The service renders a game's move only from the registered manifest and
  refuses a manifest whose source does not match its listed hash; the wallet
  signs the move within the allowance without a prompt; the node mock
  verifies the signature (`crates/service/tests/games.rs`).
* Not yet: the environments' behaviour on a live shard. Install and exercise
  F1R3Pix first (one `place`, one `state`), then the others.

## F1R3Pix (design v1, 5 October 2026)

F1R3Pix follows `F1R3Pix-design.pdf`. One hexagon per player on a board of
fixed radius; `paint` names no cell, so no one can paint another's. Messages
are sealed to their recipients (`crates/wallet/src/envelope.rs` opens them;
`F1R3Pix/client/src/core/envelope.js` seals them). Payments are the portal's
`payments.send`, which only the portal may have signed, always after a prompt.

The instance's `config` (fixed at `instances.create`) must be exactly
`{capacity: 7..=469, seating: "random" | "claim", palette: Nil | [up to 32 "#RRGGBB"], messageLimit: 1..=65536}`;
the environment refuses every move on any other configuration (R1). The
client's launch default is `{capacity: 61, seating: "random", palette: Nil, messageLimit: 2048}`.

Manifests now carry `capabilities` (F1R3Pix: `["pay", "open"]`); the host
refuses capability methods a game did not declare. Host protocol is 2.

## F1R3Beat's breeder

Patterns breed (F1R3Beat design v2 §10). A breeder key, named once by the
holder of F1R3Beat's own environment key, runs one epoch at a time and records
it on the chain together with its inputs, so anyone can recompute it.

```sh
# 1. With F1R3Beat's environment key imported and active (it needs a little phlo):
f1r3games key import game-keys/f1r3beat-env-key.json && f1r3games key use <its address>
f1r3games beat set-breeder <breeder address>
# 2. With the breeder key active: launch a nursery instance for the brood, then run epochs.
f1r3games key use <breeder address>
f1r3games launch f1r3beat --visibility public           # the nursery; note its instance id
f1r3games beat epoch --nursery <instance> --dry-run     # look first
f1r3games -y beat epoch --nursery <instance>            # publish the brood and record the epoch
# 3. Anyone:
f1r3games beat verify --epoch 0
```

Run an epoch about once a day (Phase 4 of the design sets the interval from
measurements). Each epoch admits the game patterns published since the last
one and crossed patterns with at least two likes, draws two parents by weight
(1 + plays + 3 · likes), publishes their brood, and culls one to three of the
least weighted members older than three epochs, never below sixteen.
