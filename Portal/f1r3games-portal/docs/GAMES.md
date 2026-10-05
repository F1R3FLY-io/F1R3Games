# The games

`crates/games` registers the five games already contemplated for F1R3Games.
Each has its own environment on the shard (live state per instance), call
templates that pin that environment by URI, and a manifest for
`games.register`. The earlier F1R3Games contracts were the research behind
the moves; their global state on public channels is replaced by per-instance
state behind an environment that checks membership against the portal.

| Game | Moves (play templates, signed within the allowance) | Prompted | Reads | Galleries |
|---|---|---|---|---|
| F1R3Pix | `place(instance, x, y, colour)` on a 64×64 canvas | — | `state` | canvas |
| F1R3Beat | `toggle(instance, voice, step, on)` on 8×16; `tempo(instance, bpm)` | — | `state` | pattern (header `parents` for lineage) |
| F1R3Ink | `tags(instance, tags)`; `ink(instance, target, colour)` | — | `state` (tags and inks per player) | round |
| F1R3SideChat | `addCharacter`, `takeWheel`, `release`, `addChapter`, `write(instance, chapter, charId, text)` as the character you drive, `comment` (any keyholder) | `meta`, `publishChapter` (host) | `state`, `chapter` (anyone: reader tier) | story |
| F1R3Skein | `setScale`, `setDistribution(instance, "pitch"\|"duration", machine)`, `perform(instance, device)` | — | `session` | performance, tune (cross-linked; tune header `parents`) |

Template ids are `<game>.<method>`. Galleries are filled by the game clients
through the host protocol (`publishPlay`, `linkPlays`); engagement
(`engage`) feeds Beat's and Skein's selection. SideChat tips move funds and
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
(`f1r3games call f1r3pix.place --game f1r3pix --args '{"instance": "…", "x": 3, "y": 4, "colour": "#F3D630"}'`) and their
galleries are empty.

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
