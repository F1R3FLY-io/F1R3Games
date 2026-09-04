# F1R3Skein — Phased Development Plan

**Backend target:** `F1R3FLY-io/f1r3node-rust`, branch `feature/cost-accounted-rho`
**Application repo:** `F1R3FLY-io/F1R3Games`, branch `main`
**Status:** proposal for review — no code to be written until the decisions in §7 are settled.
**Date:** 4 September 2026

---

## 0. Scope and reading order

This plan covers F1R3Skein and the parts of the F1R3Games platform that F1R3Skein cannot exist
without: the single entry point, web3 sign-on, invitation, and the gallery-of-game-plays pattern.
Those platform pieces are shared with F1R3Pix, F1R3Beat, F1R3Ink and F1R3SideChat, so they are
specified once here, as platform work, and not as F1R3Skein work.

Read §1 first if the current state of the repositories is not already familiar; it records several
findings that change what "update the implementation" means. Read §3 before §4 — the phase
structure only makes sense once the representation strategy is understood, because the whole point
of the phasing is that the skein representation is going to change under the platform once the
f1r3|@ng DDL lands, and nothing above the representation should have to change with it.

---

## 1. What is on the ground

### 1.1 `F1R3Games` repository audit

`main`, 8 commits, Apache-2.0. Contents:

| Path | State |
|---|---|
| `Portal/F1R3Games.jsx` | 845 lines. Landing / create / login / dashboard. |
| `F1R3Pix/{Shard,UI}` | Shard service (401 ln) + contracts (357 ln) + UI (~) |
| `F1R3Beat/{Shard,UI}` | Shard service (568 ln) + contracts (547 ln) + UI (631 ln) |
| `F1R3Ink/UI` | UI only — no Shard directory |
| `F1R3Skein/` | Rust workspace: `spigot_stream` (761), `dual_spigot` (472), `spigot_midi` (1084), `leap_spigot` (2600+); `breeding/snippet-evolution.jsx` (1017); `LeapSpigotVision/` visionOS app |
| `F1R3GamesOverview.pdf` | Overview document |

Absent: F1R3SideChat entirely; any backend service; a workspace root; CI; tests above the Rust
crates; any Portal↔game integration beyond a filename.

### 1.2 Findings that change the work

**F-1 — Two incompatible identity stacks.** `Portal/F1R3Games.jsx` generates **ECDSA P-256** keys
via `crypto.subtle` and persists to `window.storage` — the Claude-artifact storage shim, not a
shard. The game Shard services (`F1R3Pix/Shard/key-management.ts`, `F1R3Beat/Shard/…`) use
**secp256k1** with REV-address derivation (keccak256 → last 20 bytes → 4-byte prefix →
blake2b checksum) and speak gRPC to a node. These cannot interoperate. The node is secp256k1;
the Portal is the side that must move.

**F-2 — The Portal mis-describes F1R3Skein.** The `GAMES` array carries
`tagline: "Collective Narrative Intelligence"` and `desc: "Weave threads of story together.
Branch, braid, and bind narratives…"` for `f1r3skein`. That is F1R3SideChat's concept, attached to
Skein during an early build session where a placeholder `f1r3skein-threads` contract was written
against a narrative model. F1R3Skein is *E Pluribus Cantus* — generative and evolutionary music.
The placeholder narrative contracts should be re-homed to F1R3SideChat and the Portal copy
corrected.

**F-3 — `key-management.ts` does not compile.** `simplifiedRevAddress` contains
`return '11' + key[:40];` — Python slice syntax in a `.ts` file. The file is duplicated verbatim
across F1R3Pix and F1R3Beat, so the defect is duplicated too. This is symptomatic: the shared
infrastructure is shared by copy, not by dependency.

**F-4 — The breeding surface simulates the shard.** `snippet-evolution.jsx` contains a
`class F1R3FLYShard` with an in-memory `Map` standing in for RSpace, and hand-rolled rholang
strings in its deploy log. It is a faithful sketch of the intended contract shape and worth keeping
as a reference, but it is not an integration.

### 1.3 Backend branch audit — `feature/cost-accounted-rho`

Verified against `dev` and the two sibling branches:

- **It is a near-superset of `dev`.** 3,976 files vs 2,264; only 13 `dev` files are absent, and
  those are refactors rather than regressions: `rholang/…/storage/charging_rspace.rs` is gone, and
  `casper/…/costacc/{pre_charge_deploy,refund_deploy}.rs` are replaced by
  `{redeem_deploy,vault_cost_deploy,vault_payer}.rs` plus `supply.rs`. Dylon's assessment is
  confirmed by the file-level diff.
- **It is buildable by others.** Root `Cargo.toml` pins
  `rholang-parser = { git = ".../rholang-rs", rev = "02cef80" }` with **no `[patch]` section**
  redirecting to a local worktree. This removes the blocker that made
  `feature/cost-accounting-transpiler` un-buildable outside one machine.
- **Cost accounting is substantially deeper than on the transpiler branch.**
  `rholang/src/rust/interpreter/accounting/` gains `authority.rs`, `byte_accounting.rs`,
  `delta_sigma.rs`, `lexical.rs`, `oslf.rs`, `resource_logic.rs`; the interpreter gains
  `metering.rs` and `deterministic_reduction.rs`; the normalizer gains a `cost_accounting/`
  module with `recognize / desugar / pattern_guard / sig`.
- **`where` clauses are live**, exercised by `examples/where_receive_guard.rho`
  (`for (@x <- chan where x > 0)`) and `examples/where_match_fallthrough.rho`. Note that
  `rholang/src/main/bnfc/rholang_mercury.cf` still has `LinearCond` commented out — the live
  parse path is the tree-sitter grammar in rholang-rs, not the `.cf`.
- **Two new system contracts arrive as `.rhox`** in `casper/src/main/resources/`, alongside
  `PoS.rhox` and `TokenMetadata.rhox`:
  - **`rho:system:capabilities`** — a capability registry backing the `Sig::Bang` and `Sig::Lolly`
    connectives. `register(from_sig, to_sig, transformer, uses_bound, deployer_id, ret)` returns a
    content-addressed handle; `invoke`, `revoke`, `lookup` follow. `uses_bound = 0` means unbounded,
    `> 0` means bounded uses. Registration is idempotent on the tuple.
  - **`rho:lang:exchange`** — a conserving 1:1 token exchange implemented as the persistent join
    `for (t_c <- n_c & t_v <- n_v) { n_c!(*t_v) | n_v!(*t_c) }`, with per-channel conservation as
    the contract invariant.
- **No DDL or `Theory` machinery.** Neither this branch nor `dev` contains `.module` files, a
  `Theory` grammar, or the `mettail-elab` crate. That work lives on `feature/module-syntax` as
  `module-syntax/mettail-elab` — a standalone, dependency-free crate with its own `.module` corpus
  and an **unapplied** `rholang-rs-mettail-ddl.patch`. It is not wired into the rholang pipeline on
  any branch.

**Consequences for this plan.** Three of these findings are load-bearing:

1. `rho:system:capabilities` is the right primitive for **invitations**, and for **derivative
   rights** on a tune (the right to breed from it, to sample it, to include it in a performance).
   A bounded-use capability handle *is* an invite code, with revocation and idempotence for free.
   Building an ad-hoc invite map in rholang when the branch ships a capability registry would be
   a mistake.
2. `rho:lang:exchange` is the tipping and cross-game conversion rail. Its conservation invariant
   is exactly what is wanted for an engagement economy that must not mint.
3. The vault payer refactor (`vault_payer.rs`, `vault_cost_deploy.rs`, `redeem_deploy.rs`) changes
   how a deploy is funded. The games service must be written against that model from the start;
   retrofitting a pre-charge/refund assumption later is avoidable rework.

---

## 2. Target architecture

```
                     ┌──────────────────────────────────────────────┐
   browser / AVP     │  F1R3Games Portal  (single entry point)      │
                     │  identity · invites · game select · galleries│
                     └───────┬───────────────────────┬──────────────┘
                             │                       │
                 ┌───────────▼──────────┐  ┌─────────▼─────────┐
                 │ F1R3Skein surfaces   │  │ Pix / Beat / Ink  │
                 │  · instrument        │  │ / SideChat        │
                 │  · breeding floor    │  └─────────┬─────────┘
                 │  · tune + perf       │            │
                 │    galleries         │            │
                 └───────────┬──────────┘            │
                             │  skein-core (WASM)    │
                             ▼                       ▼
              ┌──────────────────────────────────────────────────┐
              │  f1r3games-service   (Rust, axum)                │
              │  api/ · domain/ · blockchain/ · templates/*.rhox │
              │  modelled on F1R3FLY-io/embers                   │
              └───────────────────────┬──────────────────────────┘
                                      │ gRPC (Deploy · Propose · Listen)
              ┌───────────────────────▼──────────────────────────┐
              │  f1r3node-rust @ feature/cost-accounted-rho      │
              │  rho:system:capabilities · rho:lang:exchange     │
              │  rho:rchain:revVault · rho:lang:treeHashMap      │
              │  cost-accounted rho · where clauses              │
              └──────────────────────────────────────────────────┘
```

### 2.1 The service is modelled on Embers, not on the existing Shard directories

`F1R3FLY-io/embers` is the house pattern already running against f1r3node-rust, demonstrated twice
(BGI Labs launch, late July 2026; again late August). Its layering is:

```
packages/embers/src/
  api/<domain>/{endpoints.rs, models.rs}      HTTP surface
  domain/<domain>/{create,save,get,list,…}.rs business logic
  blockchain/<domain>/models.rs               on-chain shapes
  templates/<domain>/*.rho                    Jinja-templated rholang
  templates/common/insert_signed.rho          registry env deployment
```

Two patterns from Embers should be adopted wholesale:

- **The environment contract.** `templates/common/insert_signed.rho` deploys a versioned
  environment via `rho:registry:insertSigned:secp256k1`, re-initialising only when the on-chain
  version is lower. Each domain's `init.rho` extends it and defines a method-dispatch contract:
  `contract agents(@"save", @id, @version, …)`. State lives in `rho:lang:treeHashMap` instances.
  Callers do a registry lookup then `@env!("method", args…)`.
- **Versioning with a `"latest"` alias.** Embers keeps `agentVersions[version]` alongside
  `agentVersions["latest"]`, and `list` projects headers by deleting the heavy field (`code`).
  Tune and performance storage want exactly this shape, with the heavy field being the realised
  note vector or the gesture trace.

The existing `F1R3Pix/Shard` and `F1R3Beat/Shard` TypeScript services are **superseded** by this
service. They are not deleted in P0 — they remain as behavioural reference until the Rust service
reaches parity, then they go.

### 2.2 `skein-core` — one realisation engine, two consumers

The four Rust crates under `F1R3Skein/` are refactored into a single library crate, `skein-core`,
with `spigot_stream` and `dual_spigot` as its numeric heart, and everything I/O-shaped
(`leap_spigot`'s minifb visualiser, MIDI output, the Unix-socket IPC bridge) moved out to binaries
and adapters. `skein-core` is:

- `no_std`-friendly where possible and **compiled to WASM** for the browser, so that realising a
  tune in the breeding UI is bit-identical to realising it in the service. Divergence between a
  JavaScript re-implementation and the Rust engine would silently corrupt lineage — two players
  would breed different children from the same parents.
- The **only** place the skein representation is interpreted. See §3.

---

## 3. The skein representation, and the firewall around it

### 3.1 The problem

A skein has two natures that the current code keeps apart and cannot reconcile.

**Addressed.** `DualStream::snip(key, from, to)` is reproducible from four values: the left
`SpigotConfig{constant, base}`, the right one, and the interval `from..to`. Fresh spigots are
fast-forwarded and the pairs collected; the live cursors are untouched. A snipped tune is therefore
compressible to a handful of bytes — a *mathematical address*, as the white paper puts it. Perfect
for on-chain storage.

**Bred.** `breed(mother, father)` in `snippet-evolution.jsx` produces four children by crossover:
mother's pitches with father's durations; the converse; a coin-flipped pitch⊕pitch fold through
base 5; a coin-flipped duration⊕duration lift through base 22. The result is an explicit vector of
`{pitch, duration}` pairs that is **no longer a spigot address**. The moment a tune is bred, its
compact representation is lost, and the system falls back to storing note vectors — with a
`parents` pointer bolted on to recover lineage.

This is the representational fault line. Everything downstream inherits it: lineage is a side
table rather than a fact about the object; two tunes that are provably the same tune are stored
twice; a "tune" and a "recipe for a tune" are different types with different storage paths.

### 3.2 The resolution

**A tune is a term, not a blob.** Its leaves are spigot addresses; its internal nodes are the
snip, twist, pad, crossover and mutation operators. Realisation — turning a term into notes — is a
rewrite, performed by `skein-core`. Under this reading:

- Lineage is not stored, it *is* the term. `parents` disappears.
- Equations give canonical forms, so gallery de-duplication is a normalisation, not a hash
  comparison over realised audio.
- Crossover becomes a syntactic operation, which is precisely what "a Theory of skeins that can be
  manipulated syntactically" asks for.
- Cost accounting attaches at the realisation rewrite: emitting the *n*-th digit of π costs phlo,
  which prices deep addresses honestly and gives the evolutionary economy a real resource floor.

This is the design the f1r3|@ng DDL is for. It cannot be *executed* by the node until the `Theory`
syntax lands. It can be *committed to* now.

### 3.3 The firewall

The plan therefore builds the term representation **twice**, and arranges that only one small
module ever knows which one is in use.

| | **v0 — `skein/v0`** (P2) | **v1 — `skein/v1`** (P6) |
|---|---|---|
| Representation | Rust ADT `SkeinTerm`, hand-written | f1r3|@ng `Theory Skein` terms |
| Normalisation | Hand-written, property-tested against the equations | Elaborator-derived |
| Storage | Tagged, versioned serialisation in the tune record | Same envelope, new tag |
| Realisation | `skein-core::realise` | `skein-core::realise`, re-targeted |

The v0 ADT is **deliberately isomorphic to the intended `Theory` signature** — same constructor
names, same arities, same argument names. The v1 migration is then a re-parse and a re-target of
the normaliser, not a re-modelling. Concretely:

- Every stored tune carries `repr_version: "skein/v0"` in its envelope. Nothing else in the system
  branches on it.
- Everything above the representation — galleries, engagement, invites, performances, the breeding
  floor UI, the token rails — consumes `skein-core`'s public API (`realise`, `normalise`,
  `cross`, `mutate`, `describe`), never the ADT.
- `Skein.module` — the `Theory` written in the frozen DDL syntax — is a **P2 deliverable**, not a
  P6 one. It elaborates under `mettail-elab` from `feature/module-syntax` and serves as the
  executable specification that the v0 ADT is property-tested against. Writing it early is what
  makes the migration cheap; writing it late means discovering in P6 that v0 committed to
  something the Theory cannot express.
- P6 ships a migration that re-parses v0 records to v1 and writes them back. Because both are
  terms over the same signature, the migration is total and checkable: `realise(v0(t))` must equal
  `realise(v1(migrate(t)))` for every tune in the gallery. That equality is the migration's
  acceptance test.

### 3.4 Sketch of the Theory

Written against the syntax frozen on 19 August 2026 (`Theory`, judgement-form terms
`Label . ctx |- syntax : Cat`, `Types` for declaration, `Exports` for visibility, `\/` as pushout
over shared parameters). The full file is delivered as `Skein.module`; the shape is:

```
Theory Spigot(c: Counting)      -- Const, Base, Stream; Tap, Adv
Theory Weave(s: Spigot)         -- Skein = a pair of streams; Twist
Theory Snips(w: Weave)          -- Snip : Skein × Nat × Nat -> Tune  (the leaf)
Theory Melody(m: u.Monoid)      -- Seq is monoid multiplication, NOT commutative
Theory Crossover(sn: Snips)     -- XPitch, XDur, XPP, XDD, Pad, Mutate
Theory Skein(cr: Crossover, me: Melody) { cr \/ me }
```

Three points worth flagging in review, because they are claims and not bookkeeping:

- **`Seq` should be inherited from `u.Monoid`, not declared.** Melodic concatenation is
  associative with a unit and is *not* commutative — it is monoid multiplication with the carrier
  renamed to `Tune`. This is the exact move `ParMonoid` makes for `PPar`, except that rholang's
  parallel composition takes the *commutative* monoid and a `HashBag`, whereas melody takes the
  plain monoid and a list. The two games sit at different points of the same tower, which is a
  pleasing fact and a real economy of proof.
- **`XPitch` forms a rectangular band.** `XPitch(m, f)` takes `m`'s pitches and `f`'s durations,
  so `XPitch(t, t) == t`, and both `XPitch(XPitch(a,b),c)` and `XPitch(a,XPitch(b,c))` equal
  `XPitch(a,c)`. Idempotent, associative, `xyz = xz`: a rectangular band. `XDur(m,f)` is then just
  `XPitch(f,m)` — the opposite band — which halves the constructor count and removes a whole class
  of duplicate gallery entries. This is a testable property of the existing JavaScript, and
  **checking it against `breed()` is a P2 task**, because if it fails the JavaScript has a bug.
- **`Twist` is an involution**: `(Twist (Twist w)) == w`, matching `std::mem::swap` in
  `DualStream::twist`. Free normalisation.

The two coin-flipped children (`XPP`, `XDD`) are the awkward case: they are *stochastic*. They
must be represented as `XPP(a, b, seed)` with the seed a term-level `Nat`, or the term stops being
a faithful description of its own realisation. This is decision **D-4** in §7.

---

## 4. Phases

Effort is given in **dev-weeks** assuming two engineers plus review. Phases P1–P5 are the platform
and the game; P6 is the representation migration and is *gated on external work*; P7–P8 are
clients and hardening. P2 and P3 can proceed in parallel with P1 once P0 lands.

**PI, the virtual instrument track, starts immediately and runs in parallel with everything.** It
is listed after P6 for readability only. Given the September Apple Vision Pro test window it is the
most time-critical work in this plan, and it has no dependency on any other phase.

---

### P0 — Foundations · 2 dev-weeks

Repository and branch hygiene, before any feature work.

**Tasks**

- Turn `F1R3Games` into a real workspace: root `Cargo.toml` (virtual manifest) for Rust crates,
  root `package.json` (pnpm workspace) for the TypeScript/React surfaces.
- Pin the backend: a `backend.lock` or `.f1r3fly-rev` file recording
  `f1r3node-rust @ feature/cost-accounted-rho` and the transitive `rholang-rs @ 02cef80`. Every
  integration test asserts against those revisions.
- Bring up a 3-validator local shard from `feature/cost-accounted-rho` via `docker/`, plus the
  `system-integration` repo's `shardctl` if it applies cleanly. Document the bring-up in
  `docs/local-shard.md`.
- Fix **F-3** (the `key[:40]` defect) and delete the duplicate copies of `key-management.ts`,
  replacing them with a single shared module.
- Fix **F-2**: correct the Portal's F1R3Skein copy to *E Pluribus Cantus* / generative and
  evolutionary music; move the placeholder `f1r3skein-threads` narrative contracts to a new
  `F1R3SideChat/` directory where they belong.
- Create `F1R3Ink/Shard` and `F1R3SideChat/{Shard,UI}` as empty, structured placeholders so the
  five games have a uniform shape.
- CI: `cargo test`, `cargo clippy`, `pnpm test`, plus a smoke job that boots the local shard and
  runs one deploy/propose/read cycle.

**Exit criteria** — CI green on a clean clone; the local shard smoke test passes; no compilation
defects remain in the TypeScript.

---

### P1 — Identity, invitation, and the single entry point · 5 dev-weeks

This is platform work. All five games consume it.

**P1.1 — Migrate the Portal to shard-native secp256k1 identity (F-1).**
Replace the P-256 / `window.storage` stack with secp256k1 key generation and REV-address
derivation matching `key-management.ts`, and replace artifact storage with calls to
`f1r3games-service`. Sign-on is: generate or import a private key → derive public key → derive REV
address → sign a server-issued challenge → service verifies and issues a session. The private key
never leaves the client. Follow the F1R3Sky and Embers registration/sign-on flows for the wallet
handling and the deployer-id path (`rho:deploy:data` → `rho:rev:address` `"fromDeployerId"`), which
is the pattern every Embers contract uses to attribute an action to an address.

**P1.2 — Stand up `f1r3games-service`.**
New Rust crate in the F1R3Games workspace, axum, laid out exactly as Embers
(`api/ · domain/ · blockchain/ · templates/`). Initial domains: `accounts`, `invites`, `sessions`.
Deploy the `f1r3games` environment contract via the `insert_signed` pattern. Write against the
**vault payer** model on this branch (`vault_payer.rs`, `vault_cost_deploy.rs`,
`redeem_deploy.rs`), not pre-charge/refund.

**P1.3 — Invitations on `rho:system:capabilities`.**
An invite is a registered capability with a bounded `uses_bound`. Inviting *n* friends registers a
handle with `uses_bound = n`; redemption is `invoke`; withdrawal is `revoke`; the content-addressed
handle is the invite code, and registration idempotence means re-issuing the same invite is safe.
Carry the shared contact-collection dialogue panels over from F1R3Pix as a **shared component**
across all games — with the standing exception that the F1R3Skein *browser* does not use them.

**P1.4 — Portal shell.**
Landing → create/import identity → dashboard. Dashboard lists the five games. Each game card
offers two actions, which is the platform-wide pattern: **launch a new instance**, or **browse the
gallery of game plays**. Cross-game token balance and phlo history in a shared header.

**Exit criteria** — a player can create an identity, invite a second player by capability handle,
both sign on from different browsers, and both see the same account state read from the shard.

---

### P2 — The skein core, and tunes as terms · 6 dev-weeks

**P2.1 — Refactor to `skein-core`.**
Merge `spigot_stream` and `dual_spigot` into a library crate; move MIDI, minifb and the Unix-socket
IPC bridge out to adapters. Fix the known `PiStream` `BigInt` slowness by moving to a
Bailey–Borwein–Plouffe digit extraction for π where the base permits — the current unbounded LFT
spigot is correct but is the slowest of the six streams, and deep addresses make that bite.

**P2.2 — Define `SkeinTerm` (v0) and the normaliser.**
The ADT of §3.3, isomorphic to the Theory signature. Implement `realise`, `normalise`, `cross`,
`mutate`, `describe`. Normalisation implements the equations: `Twist` involution, `Seq`
associativity and unit, the `XPitch` rectangular-band laws, `Snip(w,a,a) == unit`.

**P2.3 — Write `Skein.module`.**
The `Theory` in frozen DDL syntax. Elaborate it with `mettail-elab` from `feature/module-syntax`
(the crate is dependency-free and builds standalone on rustc 1.75, so this costs nothing in
backend integration). Treat the elaborator's diagnostics as design review — it caught two genuine
modelling errors in the universal-algebra examples and will catch ours.

**P2.4 — Property-test v0 against the Theory and against the existing JavaScript.**
Every equation in `Skein.module` becomes a proptest over `SkeinTerm`. Separately, differential-test
`skein-core::cross` against `breed()` in `snippet-evolution.jsx`. **If the rectangular-band laws
fail against `breed()`, the JavaScript has a bug** — resolve in favour of the algebra.

**P2.5 — Tune storage.**
`templates/skein/init.rhox` defining the `skein` environment: a `treeHashMap` of
`address → tunes → versions`, Embers-style, with a `"latest"` alias and header projection that
omits the realised note vector. A tune record is
`{ repr_version, term, created_at, name, snipped_from, realised_hash }`. Compile to WASM and wire
the breeding UI to `skein-core` in place of its JavaScript genetics.

**Exit criteria** — a tune snipped in the browser is stored on the shard as a term, read back,
realised identically in Rust and in WASM, and its normal form is stable.

---

### P3 — Performances · 4 dev-weeks

A performance is a **separate recorded artifact** from a tune. A performance may yield zero, one or
many tunes — those the performer chose to snip — but it stands on its own and is galleried,
engaged with and tipped on its own.

**Tasks**

- Define the performance record: an ordered, timestamped trace of gesture and parameter events,
  in the vocabulary the IPC bridge already speaks — `pull_left{steps, velocity}`, `pull_right`,
  `twist`, `clap`, `unclap`, `scissors{name}` — plus the opening `SpigotConfig` for each side.
  Because the streams are deterministic, **the trace replays the performance exactly**; no audio
  is stored.
- `templates/skein/performance_*.rhox`: create, save, list, get. Same versioned shape as tunes.
- Record and replay in `skein-core`, with a scrubbing player in the UI.
- Link table: a performance references the tunes snipped during it; a tune references the
  performance it was snipped from (`snipped_from`). Both directions are needed — the tune gallery
  wants to offer "hear this in context", the performance gallery wants "tunes harvested here".
- Decide storage for long performances (**D-5**): full trace on chain, or on-chain digest with the
  trace in F1R3Drive.

**Exit criteria** — a recorded performance replays note-for-note from its trace; the tunes snipped
during it resolve in both directions.

---

### P4 — Galleries and the engagement ledger · 4 dev-weeks

**P4.1 — The platform gallery pattern.**
Every game has a gallery of game plays, reachable from the game card without launching an
instance. Uniform surface: infinite scroll, filter, sort by recency / engagement / lineage depth,
and an "open" action. Each game supplies a card renderer and a preview player.

**P4.2 — F1R3Skein's two galleries.**
Skein is the subtle case: **Tunes** and **Performances** are distinct galleries over distinct
artifacts, cross-linked as in P3. The tune gallery additionally offers a **lineage view** —
because a tune is a term, its ancestry is readable off its own syntax, and the view is a rendering
of the term tree rather than a graph walk over a `parents` table.

**P4.3 — The engagement ledger.**
A shared, cross-game ledger recording plays, likes, phlo-weighted votes, tips, and — specific to
Skein — *snips-from* and *bred-from* counts, which are the strongest engagement signals because
they cost the engager something. Tipping settles through `rho:lang:exchange`, whose per-channel
conservation invariant guarantees the engagement economy cannot mint.

**Exit criteria** — engagement events from two players on two browsers converge to the same
on-chain counts; the lineage view renders correctly for a tune three generations deep.

---

### P5 — Evolution under collective selection · 5 dev-weeks

The feedback loop the whole design exists to close: **tunes with more engagement are more often
selected for reproduction.**

**Tasks**

- Fitness function over the engagement ledger. Start deliberately simple and legible — a weighted
  sum with published weights — rather than clever. It is a governance object, not an
  implementation detail, and players will reason about it.
- Selection: fitness-proportionate with a floor, so that novelty is not extinguished by
  early-mover advantage. Elitism preserves the top *k* unbred.
- Reproduction: `cross` and `mutate` from `skein-core`, producing four children per pairing as the
  existing `breed()` does. Children enter the gallery at generation *n+1* with the parents' terms
  as their subterms.
- Scheduling: a breeding round is a deploy. Cost-accounting on the realisation rewrite prices each
  round honestly.
- **Cross-feed to F1R3Beat.** A Skein tune projects to a Beat pattern through the base-5 duration
  map that already exists in `pitchToDuration`. The engagement ledger is shared, so a tune bred in
  Skein can be selected under Beat's selection pressure and vice versa. This is the concrete sense
  in which the two music games are one evolutionary population.

**Exit criteria** — a breeding round runs on the shard, children are galleried with correct terms,
and a controlled experiment shows selection tracking engagement.

---

### P6 — The Theory of skeins, in earnest · 4 dev-weeks · **GATED**

**Gate:** the f1r3|@ng `Theory` syntax must be integrated into a branch the games can target. As
of today that means the `mettail-elab` crate and the `rholang-rs-mettail-ddl.patch` moving from
`feature/module-syntax` into the cost-accounted line, and the tree-sitter grammar accepting
`Theory`. This plan does not schedule that work; it consumes it.

**Tasks**

- Re-target `skein-core` from the v0 ADT to elaborated `Theory Skein` terms.
- Migration: re-parse every stored `skein/v0` record to `skein/v1`, verifying
  `realise(v0(t)) == realise(v1(migrate(t)))` for each. Failures are hard errors, not warnings.
- Move normalisation from hand-written Rust to elaborator-derived rewriting.
- Retire the v0 normaliser and its proptests, keeping the differential tests as regression cover.
- **Watch item:** the open question of arity drift through `Replacements` — a binary operation
  replaced by a collection-valued one leaves inherited binary equations ill-formed over a bag. If
  `Skein.module` uses a replacement of that shape (it may, for `Seq`), this bites here.

**Exit criteria** — every gallery tune round-trips through v1 with identical realisation; no
caller outside `skein-core` changed.

---

### PI — The virtual instrument · 2 dev-weeks · **RUNS IN PARALLEL FROM DAY ONE**

Superseding the original placement of this work in P7. A separate readiness review
(*F1R3Skein Virtual Instrument — visionOS Readiness Review*) found that the visionOS app cannot be
tested on device as built: it reaches the engine over a Unix domain socket, which cannot cross a
device boundary, so hand tracking and engine connectivity are mutually exclusive. Three of the four
immersive feedback features are implemented but never called, and the scissors gesture's curl
threshold is miscalibrated such that snip can never fire from hand tracking.

This track has **no dependency** on the service, the galleries, or the term representation — the
engine already runs standalone — so it starts immediately and runs alongside P0 and P1.

- **Track A, connectivity** — replace the Unix socket with TCP plus Bonjour discovery, on both
  sides; move the Swift client to `Network.framework`; add `NSLocalNetworkUsageDescription` and
  `NSBonjourServices`; settle the entitlements, which are currently macOS keys in a file no build
  configuration references.
- **Track B, responsiveness** — wire the hand ghosts, ribbon stitching, scissor highlight and
  playing-note cursor; rewrite the finger-curl metric to be scale-invariant; add a debug overlay
  and record labelled gesture traces for offline threshold tuning.
- **Track C, latency and audio** — throttle the engine's 60 Hz status flood, cache the per-patch
  text meshes and materials out of the render hot path, and synthesise audio **on device** so the
  sound comes from the instrument rather than from the Mac.

**Exit criteria** — the ten-point pre-flight checklist in the readiness review passes on device.

### P7 — Client completion · 3 dev-weeks

- **Web** — the instrument surface for players without hardware: keyboard and pointer gestures
  mapped to the same `GestureEvent` vocabulary the IPC bridge uses.
- **visionOS** — identity and gallery access through the service; tune gesture thresholds against
  the corpus captured during the September sessions.
- **Leap Motion** — retain as a supported input; note that `leaprs 0.4` targets the Orion SDK, so
  newer Ultraleap hardware needs a Gemini path.
- Consider the steerable extension already identified: making the pitch and duration maps
  themselves gesture-modulable, so scale and root can change mid-performance. This is a new
  `GestureEvent` variant and a new term constructor — it must go into `Skein.module` if it ships.

**Note on P2.** The on-device engine — compiling the spigot crates for `arm64-apple-visionos` and
calling them over a small C FFI — is promoted into P2 alongside the WebAssembly build. Both are the
same refactor under the "one realisation engine, several hosts" principle, and designing one FFI
surface for both is materially cheaper than doing them a phase apart. It also retires the transport
problem entirely rather than working around it.

---

### P8 — Hardening · 3 dev-weeks

Load testing against a multi-validator shard; phlo budgeting per action with published costs; key
recovery and export flows; abuse controls on invitation and engagement (sybil resistance on
fitness is the sharp one); accessibility on the instrument surface; operator documentation.

---

## 5. Cross-game contracts this plan establishes

| Concern | Owner | Consumed by |
|---|---|---|
| Identity, sign-on, session | P1 platform | all five games |
| Invitation (capability handles) | P1 platform | all five |
| Gallery-of-game-plays shell | P4 platform | all five |
| Engagement ledger | P4 platform | all five |
| Tipping via `rho:lang:exchange` | P4 platform | Skein, SideChat, Beat |
| Contact-collection dialogue | P1 platform | all except the Skein browser |
| Tune object and `skein-core` | P2 Skein | Skein, Beat |
| Performance object | P3 Skein | Skein; SideChat may embed |

---

## 6. Risks

**R-1 — The DDL gate slips.** Mitigated by design: the firewall means P6 can slip indefinitely
without blocking P0–P5 or P7. The cost of slippage is carrying a hand-written normaliser, not a
stalled product.

**R-2 — v0 commits to something the Theory cannot express.** Mitigated by writing `Skein.module`
in P2 rather than P6, and property-testing v0 against it from the start.

**R-3 — The cost-accounted branch is a moving target.** It is ahead of `dev` by a large margin and
under active development. Mitigated by the pinned revision in P0 and by scheduled rebases at each
phase boundary rather than continuously.

**R-4 — Stochastic operators break term faithfulness.** The two coin-flipped children are not
functions of their arguments. Unresolved until **D-4**.

**R-5 — Deep spigot addresses are expensive.** Realising position 10⁶ of π costs real computation.
Cost accounting makes this visible rather than solving it; the BBP change in P2.1 and a
memoisation layer are the levers.

**R-6 — Engagement gaming.** Fitness driven by engagement is an attack surface the moment tokens
are involved. P8 addresses it; it should be reviewed earlier if the token economy goes live before
then.

---

## 7. Decisions needed before code

**D-1 — Service language and shape.** Confirm a new Rust axum service modelled on Embers, rather
than extending the existing TypeScript Shard services. This plan assumes yes.

**D-2 — Invitations on `rho:system:capabilities`.** Confirm that bounded-use capability handles
are the invite mechanism, rather than a bespoke rholang invite map. This plan assumes yes.

**D-3 — Is `Seq` inherited from `u.Monoid`?** Confirm that melodic concatenation should be the
non-commutative monoid from the universal-algebra tower, making F1R3Skein and rholang siblings on
the same tower. This is the central structural claim of the Theory.

**D-4 — Stochastic crossover.** Should `XPP` and `XDD` carry an explicit seed as a term-level
argument (faithful, reproducible, uglier), or should they be modelled as relations rather than
functions (cleaner algebra, non-deterministic realisation)? The plan cannot proceed past P2.2
without this.

**D-5 — Performance trace storage.** Full trace on chain, or on-chain digest with the body in
F1R3Drive? Note the precedent: the F1R3MTA work took bodies on chain. Consistency argues for the
same choice here.

**D-6 — F1R3SideChat's place.** It is absent from the repo and from the Portal's `GAMES` array,
but it is one of the five. Does P0 create its skeleton, or is it out of scope until later?

**D-7 — Fitness weights.** Who sets them, and can they be changed by governance (CatchingF1R3)
rather than by deploy? This determines whether the fitness function is a contract parameter or a
constant.
