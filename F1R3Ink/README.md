# F1R3Ink

Say how you see each other, in colour.

F1R3Ink is a multiplayer game of mutual impression. Each player has a flag:
their avatar with one horizontal stripe for each person who has inked them.
A stripe's colour is its inker's current impression, chosen from the round's
palette, and it changes when that impression does. Colours fade unless they
are refreshed, so a flag shows how a community sees someone now. A public
flag is seen in full by everyone; a private one is seen in full only by its
owner, and inks on it are sealed to the owner and the inker. Players message
one another and send one another F1R3Cap. The design is
`docs/f1r3ink-design.pdf` (version 1, 8 October 2026).

## Where the parts live

| Part | Path | Language |
|---|---|---|
| Game environment (state, moves, reads, the relay's moves) | `Portal/f1r3games-portal/templates/games/f1r3ink.rho` | f1r3lang |
| Configuration, decay, handles, history order, round and portrait bodies | `Portal/f1r3games-portal/crates/games/src/ink.rs` | Rust |
| Sealed inks (version 2 envelopes) and relay signatures in the wallet | `Portal/f1r3games-portal/crates/wallet/src/envelope.rs`, `wallet.rs`, `wasm.rs` | Rust |
| Signed relay requests | `Portal/f1r3games-portal/crates/core/src/relay.rs` | Rust |
| The relay (`POST /api/relay/{game}`, batching) | `Portal/f1r3games-portal/crates/service/src/relay.rs` | Rust |
| `f1r3games ink set-relay` | `Portal/f1r3games-portal/crates/cli/src/ink.rs` | Rust |
| Host protocol: `relay`; launch options | `Portal/f1r3games-portal/web/src/core/host.ts`, `portal.ts`, `ui/pages/Launch.tsx` | TypeScript |
| Game client and gallery renderers | `F1R3Ink/client` | JavaScript, React |
| Shared test vectors | `F1R3Ink/vectors/ink-vectors.json` | JSON |

`F1R3Ink/UI` and `F1R3Ink/Shard` are the earlier prototype. They are kept as
research and are superseded; do not deploy them.

## The client

```sh
cd F1R3Ink/client
npm install
npm test          # core (held to the vectors), game logic against an in-memory shard, and UI
npm run dev       # without ?portal=… it runs a demo with seven simulated players
npm run build     # dist/ is served at <entry-base>/f1r3ink/
npm run vectors   # regenerate ../vectors/ink-vectors.json (then rerun the Rust tests)
```

Framed by the Portal it is loaded as `<entry>?instance=<id>&portal=<origin>`
and speaks host protocol 2 (`src/core/sdk.js`), with the `relay` method
added. It never sees a key. The core (`src/core/`) is framework-free:
configuration and decay (`ink.js`), sealing (`envelope.js`), history and
bodies (`history.js`), what each viewer sees and the aggregates
(`flags.js`), plays (`publish.js`) and the `InkGame` model (`game.js`);
`src/ui/` only renders.

Two columns: on the left, you (your flag, tags, visibility and veil), then
messages and tokens; on the right, the wheel of everyone else, which switches
to the Spectrum and Trend views, with the ink control for the one selected
player. Right-click, long-press or press Enter on any stripe for its colour
history. Below 900 pixels the columns become tabs.

## Configuration

Launch an instance with a configuration of exactly these keys; the client's
default is:

```json
{ "capacity": 24, "palette": ["#E6194B", "#F58231", "#FFE119", "#BFEF45", "#3CB44B", "#42D4F4",
  "#4363D8", "#911EB4", "#F032E6", "#FABED4", "#DCBEFF", "#9A6324", "#800000", "#000075",
  "#A9A9A9", "#FFFFFF"], "decay": { "unit": 3600000, "steps": 24 }, "minInterval": 60000,
  "anonymous": true, "anonMin": 5, "reciprocity": false, "messageLimit": 2048 }
```

`capacity` is 3 to 64; `palette` 2 to 32 distinct `#RRGGBB` colours; `decay`
is null (no fading) or `{unit ≥ 1000 ms, steps 1..1000}` (presets: evening
10 min × 12, day 1 h × 24, week 6 h × 28, season 1 d × 90); `minInterval` 0
to 86 400 000 ms; `anonMin` 3 to 64; `messageLimit` 1 to 65 536 bytes. The
Portal's Launch page offers all of these.

## Installing on a shard

From `Portal/f1r3games-portal` (see `docs/GAMES.md`):

```sh
# The web shell gains the relay capability and a rebuilt wallet: rebuild and redeploy it.
# Raise the game environments' version so F1R3Ink's new body replaces the earlier one.
f1r3games-service -c f1r3games.toml games-install --keys game-keys --only f1r3ink --version <installed + 1>
# The relay: a key (fund it; it pays for anonymous inks) and a handle secret.
f1r3games-service relay-keygen --dir .                 # prints the relay key's address
#   add [relay] to f1r3games.toml (enabled, base_url, key_file, secret_file) and restart the service
f1r3games-service games-manifests --keys game-keys --entry-base https://<where clients live> \
    --relay-base https://<portal>/api/relay --out manifests.json
f1r3games register-games manifests.json --only f1r3ink   # with the Cooperative's key active
# Name the relay, with F1R3Ink's environment key imported and active:
f1r3games ink set-relay <relay address>
```

Without a relay, F1R3Ink plays fully except for anonymous ink, which the
client then offers as unavailable.

## Status

Verified:
* the environment and every F1R3Ink call template parse with the node's own
  parser and normalise with its compiler;
* the environment **runs** in F1R3Node-Rust's interpreter (master 3c7872a):
  a 61-step scenario of entering, tags, inks in every form, pacing, lifting,
  visibility with disclosure, veils, messages, the relay's batch and reveal,
  every read, the close and a bad configuration, with the expected answer at
  each step;
* every play template passes the wallet's rule that game templates bind no
  deployer authority, and the relay's moves are not play templates;
* Rust and JavaScript agree on every shared vector: configurations, decay,
  handles, history order, both bodies, and sealed inks (the Rust wallet seals
  byte for byte as the client does, and opens only for the parties);
* the relay service verifies signed requests, refuses strangers, other relays,
  too-small rounds and the wrong ink form, caps each inker per hour, and
  submits one shuffled `relayInk` signed by the relay key, naming handles and
  never inkers (against a verifying mock node);
* the client plays full rounds against an in-memory shard that mirrors the
  environment and the relay.

Not yet verified: the environment on a running shard and its phlo costs, and
the relay's window there. Install and try one `enter`, one `ink` and one
`flags` read first; then one anonymous ink through the relay.
