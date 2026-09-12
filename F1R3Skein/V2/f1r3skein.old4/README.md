# F1R3Skein — implementation

Implements *The F1R3Skein Virtual Instrument*, specification revision 4.

```
skein-spigot/   digit streams for the five constants, memoised, any base 2..36
skein-core/     terms, realisation, envelope, calibration, gesture detectors,
                the instrument state machine, performance traces
skein-proto/    wire protocol v4
skein-engine/   TCP server (configuration S1) and a headless selftest
swift/          visionOS client — see swift/BUILDING.md
  project.yml     XcodeGen spec; `xcodegen generate` produces the target
  SkeinClient/    app, panel, immersive view, model, transport, audio,
                  ARKit sampling, scene, trace recorder, Info.plist
```

To install on a headset, start at **`swift/BUILDING.md`**.

## Status

**Rust: built and tested.** 81 tests pass, no warnings.

```
cargo test                              # 81 tests
cargo run -p skein-engine -- --selftest # scripted session, no headset
cargo run -p skein-engine               # serve on 0.0.0.0:7643
```

**Swift: written, not compiled.** No macOS or Xcode was available here, so the
client is unverified. It is deliberately thin — see below.

## Why the detectors are in Rust

The specification asks for three kinds of detector across three input sources.
Putting them in `skein-core` rather than in the client buys three things:

* they are **unit-testable against synthetic traces**, which matters because
  every threshold is a guess and one of them was provably unreachable;
* configurations S1 (tethered) and S2 (on-device, over a C FFI) run **one**
  implementation, so the client cannot drift into being a second one;
* thresholds live in a single calibration profile, reloadable without a
  rebuild.

The client samples ARKit, forwards frames, renders, and makes sound. It
resolves no gestures of its own beyond the panel equivalents the spec requires
for accessibility.

## What the tests actually establish

Not coverage for its own sake — these are the conformance items from §16 that
can be checked without a headset.

| Claim | Test |
|---|---|
| Digits are correct and stable at depth | `skein-spigot::tests` (8) |
| `Twist` is an involution; twist swaps roles | `term::twist_*` |
| `XPitch` is a rectangular band, on terms *and* on realisation | `term::xpitch_is_a_rectangular_band`, `band_laws_hold_on_realisation_too` |
| `XDur` needs no constructor | `term::xdur_needs_no_constructor` |
| A snip reads two independent cursors | `term::snip_reads_independent_cursors` |
| Stochastic operators are reproducible | `term::stochastic_operators_are_reproducible` |
| Lineage is readable off the syntax | `term::lineage_is_the_syntax` |
| The curl metric is scale-invariant | `gesture::straightness_is_scale_invariant` |
| **Scissors actually fires** | `gesture::scissors_actually_fires`, `..._different_size` |
| Halt is set/clear, not a toggle | `gesture::halt_is_set_and_clear_not_toggle` |
| Halt needs re-arming; small leans do not fire | `gesture::halt_needs_rearm_*`, `small_leans_*` |
| Loop fires on a circle, not on a straight sweep | `gesture::loop_fires_*`, `a_straight_sweep_*` |
| Loop direction selects set or clear | `gesture::loop_direction_selects_set_or_clear` |
| Pull does not exist in meta play | `gesture::pull_does_not_exist_in_meta` |
| Snip roles go by depth, not chirality | `gesture::snip_roles_go_by_depth_not_chirality` |
| Faster closing gives a faster tempo | `state::faster_closing_gives_a_faster_tempo` |
| A mesh has one tempo across a halt | `state::tempo_survives_a_halt_and_resume` |
| The frontier is bounded and says why | `state::the_frontier_is_bounded_and_reports_why` |
| Mount stops the wave; unmount preserves the mesh | `state::mount_stops_*`, `unmount_preserves_*` |
| Mode gating both ways | `state::play_gestures_are_refused_in_meta`, `meta_..._in_play` |
| **A capture re-realises to what was heard** | `state::a_capture_re_realises_to_what_was_heard` |
| **Captures may overlap** (the cut is virtual) | `state::captures_may_overlap_because_the_cut_is_virtual` |
| A capture carries its envelope | `state::a_capture_carries_its_envelope` |
| Silence is not captured | `state::silence_is_not_captured` |
| Steady state is quiet | `session::steady_state_is_quiet` |
| Digits coalesced, notes not | `session::digits_are_coalesced`, `notes_are_not_coalesced` |
| Names with backslashes survive the wire | `proto::names_with_awkward_characters_survive` |

The three in bold are the ones that could not pass on the previous
implementation.

## Two bugs the tests caught during development

Worth recording, because both were silent.

**The loop detector was direction-blind.** It derived the plane basis from the
signed area vector, which flips with the direction of travel — so the
accumulated sweep came out positive whichever way M circled, and set and clear
were indistinguishable. Fixed by building the basis from the data and then
orienting it to M's viewpoint: with x right, y up and z away, a positive sweep
means counter-clockwise *as she sees it*. Rotation sense is not intrinsic to a
curve in space; it needs a viewer, and the viewer is M.

**Recursive internally-tagged enums do not serialise.** `Tune` is recursive and
was tagged `#[serde(tag = "op")]`, which makes serde's `TaggedSerializer` type
recurse without bound. External tagging is fine and still readable.

## Defaults chosen

Where the spec left a number open, these are the defaults, all in
`calibration.json` and reloadable at runtime.

| Decision | Default | Reasoning |
|---|---|---|
| `zip.frontier_max` | 1024 notches | A two-minute phrase at eight notes per second — the order of a generous looper take. Set from a reference device before the demo. |
| Roll thresholds | fire 15°, re-arm 6°, hold 0.25 s | Provisional, per spec. Confirm against a corpus: players lean into phrases. |
| Auto-naming | `take-001` | Take number rather than address: less informative, far more legible in a tray. |
| Default maps | pentatonic minor on A3, musical durations | Hard to make sound wrong, which is what a first session needs. |
| Default streams | π base 22, e base 5 | Base matches the cardinality of the map it drives. |
| Tempo range | 50–200 bpm from closing speed | Covers a slow ballad to a fast run within one hand gesture. |

## Two rules written in that the spec left implicit

Both are marked in the source.

**Pull requires unzipped.** Once meshed the ribbons are locked together, and
the front — not the hands — advances the material. So the cursors move only
before a zip, which is exactly when M is setting the relative phase. This makes
the phase offset unambiguously her compositional choice.

**Unzip advances the cursors past the mesh.** The meshed material has passed;
play resumes beyond it rather than re-treading it.

## Not built

* Bonjour *advertisement* on the engine side. The client browses for
  `_f1r3skein._tcp`; the engine currently only listens on TCP. A few lines with
  a DNS-SD crate, or `dns-sd -R` alongside for the demo.
* Configuration S2. The FFI surface is the natural next step and the crate is
  already free of I/O, so it is a matter of `extern "C"` shims plus an
  `aarch64-apple-visionos` target.
* Tray persistence across launches. Traces persist; the tray does not.
* Panel control of the instrument program (General MIDI) — the message exists,
  the control does not.

## Order of work for the demo

1. Bonjour advertisement, then a device install that connects — this is the
   blocking item, since the old transport could never work on device.
2. Audio on the headset, and measure the gesture-to-note latency against the
   30 ms target.
3. The trace sink, before the first session rather than after it.
4. Threshold tuning from the captured corpus.
