# F1R3Skein Virtual Instrument — visionOS Readiness Review

**Subject:** `F1R3Games/F1R3Skein/LeapSpigotVision` + `F1R3Skein/leap_spigot`
**Occasion:** aggressive on-device Apple Vision Pro testing, September 2026
**Date:** 4 September 2026

---

## Verdict

**Not ready.** The app builds and the Rust engine is in good shape, but the current design cannot
be exercised on a physical Vision Pro at all, and three of the four immersive feedback features are
present in the source but never called.

The single decisive finding:

> The app connects to the engine over a **Unix domain socket** at `/tmp/leap_spigot.sock`. A Unix
> socket is addressed by a path in one host's filesystem. A Vision Pro is a separate host. The
> Mac's socket is unreachable from the device, so **on device the app will never connect**. The
> only configuration in which the socket works is the **visionOS Simulator**, which shares the
> Mac's filesystem — and the Simulator does not support hand tracking.

So the two halves of the instrument are mutually exclusive as built: hand tracking works only where
the engine is unreachable, and the engine is reachable only where hand tracking does not exist. No
amount of testing on the current build will exercise the instrument.

Everything else below is fixable in the same window. The estimate for a genuinely testable build is
**8–11 engineer-days**, and the work parallelises across two people.

---

## Blockers

### B1 — Transport cannot cross the device boundary

**Evidence.** `SpigotEngine.swift`, `connectPOSIX()`: `socket(AF_UNIX, SOCK_STREAM, 0)` with
`sockaddr_un` and `sockPath` defaulting to `/tmp/leap_spigot.sock`. `README.md` describes exactly
this as the device path, which it cannot be.

**Fix — fast path (2 days).** Add a TCP listener to the Rust engine alongside the Unix listener.
`spawn_ipc_server` already takes an `IpcGestureSource` abstraction, so this is a second
implementation behind the same channel plumbing, not a redesign. On the Swift side, replace the raw
POSIX code with `Network.framework` (`NWConnection` over `NWEndpoint.hostPort`), which also gives
reconnection, path monitoring and backpressure for free — all three of which the hand-rolled loop
currently lacks.

Two Info.plist keys are then mandatory and are **both absent**: `NSLocalNetworkUsageDescription`
and `NSBonjourServices`. Without them visionOS blocks the connection at the first packet, and the
failure mode is a silent timeout rather than an error. Add Bonjour advertisement on the Rust side
so the headset discovers the Mac rather than needing a typed IP address — during a testing session
with a laptop on DHCP, a hardcoded address will cost more time than the discovery code.

**Fix — strategic path (5–8 days, do after September).** Move the engine on-device. Compile the
spigot crates for `arm64-apple-visionos` as a static library and call them over a small C FFI. This
eliminates the transport entirely, removes the latency budget, and fixes B2 as a side effect. It is
also the same "one realisation engine, many consumers" principle the development plan applies to
the browser via WebAssembly, so the FFI surface and the WASM surface should be designed together.

---

### B2 — The sound comes out of the wrong device

**Evidence.** `spigot_midi` uses `midir`, which routes to CoreMIDI on the host running the engine.
The engine runs on the Mac. The player is wearing the headset.

For a text demo this is a curiosity. For a **musical instrument** it is disqualifying: the player
pulls a ribbon in front of their face and the note arrives from a laptop across the room, through a
network hop and a MIDI buffer. Gesture-to-sound latency is the single property the September test
most needs to measure, and the current architecture guarantees a bad and unrepresentative number.

**Fix (3 days).** Synthesise on device. The engine already emits structured `note` events
(`pitch`, `duration`, `velocity`) over the wire, so the Swift side needs only a sampler:
`AVAudioEngine` with `AVAudioUnitSampler` is the shortest path. Prefer **PHASE** if there is
appetite, because spatialising each ribbon's audio to its position in the immersive space is a real
gain for an instrument whose whole conceit is that the two streams are distinct objects in front of
you. Keep the Mac-side MIDI output as an option for recording to a DAW.

---

### B3 — Three of the four immersive features are dead code

All four functions exist and are correct-looking. None of them is called from anywhere.

| Feature | Implementation | Called from |
|---|---|---|
| Hand ghosts | `HandGhostEntity.update(anchor:gestureName:)` | **nowhere** |
| Ribbon stitching on clap | `RibbonRoot.updateStitch(progress:)` | **nowhere** |
| Scissor highlight on snip | `RibbonRoot.highlightScissor(from:count:progress:)` | **nowhere** |
| Playing-note highlight | `RibbonRoot.highlightPatch(leftIndex:)` | called with `nil` — a no-op |

**Evidence.** `LeapSpigotApp.swift` adds `handGhosts` to the scene (`content.add(handGhosts)`) and
never touches it again. `RibbonImmersiveView`'s update closure contains
`ribbonRoot.highlightPatch(leftIndex: nil) // index resolved in engine`, inside an
`if let note = engine.lastNote` whose binding is never used — that alone is a compiler warning
standing over an unimplemented feature.

What a tester will actually see in the immersive space: two ribbons of coloured digit patches that
advance. No hands, no stitching on clap, no gold highlight on snip, no travelling note cursor. The
gestural feedback loop — the thing being tested — is invisible.

**Fix (2 days).** Route `HandAnchor` updates from `GestureRecognizer` to `HandGhostRoot`; the
recogniser already receives every anchor and discards it after use. Call `updateStitch` from the
play state, `highlightScissor` on `snip_ack`, and give `highlightPatch` the real index — which the
engine already sends, since every `note` message carries `left_pos` and `right_pos`.

---

### B4 — The scissors gesture cannot fire

**Evidence.** `GestureRecognizer.isScissors(_:)` requires ring and little fingers to score below
`0.30` on `fingerExtension`, which is
`distance(tip, metacarpal) / 0.08`, clamped to 1.0.

The metacarpal joint sits near the wrist. On an adult hand the tip-to-metacarpal distance for a
**fully curled** ring finger is roughly 0.06–0.08 m, giving a ratio of about **0.75–1.0** — far
above the 0.30 threshold. The curl test therefore fails essentially always, and the guard rejects
every candidate pose. Snip, the gesture that produces the game's primary artifact, never triggers
from hand tracking.

**Fix (1 day).** Replace the metric. Curl is far better measured as the angle at the PIP joint, or
as tip-to-wrist distance normalised by that finger's own segment lengths, which is scale-invariant
across hand sizes — a property the current fixed 0.08 m divisor lacks entirely. Then re-derive all
four thresholds from recorded traces rather than by guess.

**Related, and the reason this must not be fixed by eye:** there is no gesture test corpus.
Add a debug overlay that logs joint distances and the computed metrics live, record a few dozen
labelled traces on device in the first session, and tune against them offline. Budget the first
half-day of AVP time for capture, not for playing.

---

### B5 — Entitlements are not applied, and are the wrong family

**Evidence.** `LeapSpigotVision.entitlements` exists at the project root, but **no build
configuration in `project.pbxproj` sets `CODE_SIGN_ENTITLEMENTS`**. The file is inert.

Its contents are also macOS App Sandbox keys — `com.apple.security.app-sandbox`,
`com.apple.security.network.client`, `com.apple.security.files.user-selected.read-write` — which
have no meaning in the iOS/visionOS sandbox model. And `com.apple.developer.arkit.hand-tracking`
should be checked against current Apple documentation before it is wired in: an unrecognised
`com.apple.developer.*` key that is absent from the provisioning profile causes device
installation to **fail**, which is a bad thing to discover with the headset on.

**Fix (0.5 day).** Establish the correct entitlement set for visionOS hand tracking, wire
`CODE_SIGN_ENTITLEMENTS` if any are needed, delete the macOS keys, and do one clean device install
before the test session rather than at the start of it.

---

## Majors

**M1 — The engine floods the client with redundant status at 60 Hz.**
`app.rs::run_ipc` contains `state_sender.send(StateMsg::Status(app.status.clone()))` inside the
frame loop, under a comment reading "Push status if changed" — but there is no change check. That
is 60 JSON lines per second, each landing on an `@Published` property and invalidating the entire
`ContentView`. Add the equality check the comment already promises. One line.

**M2 — The ribbon hot path regenerates text meshes every frame.**
`PatchEntity.configure(...)` calls `MeshResource.generateText("\(digit)", …)` and constructs a
fresh `PhysicallyBasedMaterial` on **every** update of **every** patch. `RibbonRoot.update` is
driven both by `.onChange(of: engine.digits)` and by the `RealityView` update closure, so M1 feeds
it directly. `generateText` performs text shaping and mesh tessellation; it is among the most
expensive calls in RealityKit and does not belong in a per-frame path. Cache one mesh per digit
value and one material per (digit, depth-bucket) at init, and only reassign when the digit actually
changes. This is very likely the difference between a stable 90 fps and visible judder.

**M3 — File-descriptor lifetime bugs in the socket client.**
Three distinct problems in `SpigotEngine`: two `FileHandle` objects are constructed over the same
fd (one in `openSocket` for writing, another in `readLoop` for reading); `readLoop` calls
`Darwin.close(connectedFD)` directly while `writeFH` still holds that fd, leaving it dangling; and
`disconnect()` calls `writeFH?.closeFile()` **and** `Darwin.close(connectedFD)`, a double close.
After the first reconnect, a gesture write can land on a recycled descriptor belonging to something
else entirely. The symptom would be intermittent and baffling — exactly the kind of thing that
eats a test day. Moving to `NWConnection` under B1 removes all three.

**M4 — Clap and twist can fire simultaneously.**
`handleClapAndTwist` treats the two as independent. Clap requires hand distance `< 0.10 m`; twist
requires a vertical offset `> 0.06 m`. Both can hold at once, so bringing the hands together with
one slightly higher — a very natural motion — starts playback *and* swaps the streams. Make them
mutually exclusive and require the twist pose to be non-clapping.

**M5 — Gesture recogniser races the engine reference.**
`RibbonImmersiveView` sets `gestureRecog.engine = engine` inside the `RealityView` make closure,
while `.task { await gestureRecog.start() }` runs independently. If the task wins, early gestures
are sent to a `nil` engine and silently dropped. Set the reference in the `.task` before `start()`.

**M6 — Playback state is inferred from prose.**
Swift clears `isPlaying` via `statusText.contains("stopped")`, matching Rust's
`"UN-CLAP — MIDI playback stopped"`. It works today and breaks the moment anyone rewords a status
string. Add an explicit `playing: bool` to the `status` message, or a dedicated message type.

**M7 — Hand processing runs on the main actor.**
`GestureRecognizer` is `@MainActor` and consumes `anchorUpdates` at hand-tracking rate, doing
distance and angle maths inline. Combined with M1 and M2 this contends directly with rendering.
Move the geometry off the main actor and hop back only to send events.

---

## Minors

- **README is stale in three ways.** It states palm velocity is "a stub returning zero" — it is in
  fact implemented in `palmVelocity(anchor:)`. It requires "Xcode 15.2+, visionOS SDK 1.0+", but
  the project sets `XROS_DEPLOYMENT_TARGET = 2.5` and the test target uses Swift Testing
  (`import Testing`), which together need **Xcode 16.4 or later**. Someone following the README
  will fail to build.
- **Bundle identifier mismatch.** `Info.plist` declares `io.f1r3fly.LeapSpigotVision`; the project
  sets `io.F1R3FLY.LeapSpigotVision`. The build setting wins, so it is benign — but it is one more
  thing to confuse provisioning-profile matching at exactly the wrong moment.
- **`GENERATE_INFOPLIST_FILE = YES` alongside an explicit `INFOPLIST_FILE`.** Workable, but verify
  that `NSHandsTrackingUsageDescription` actually survives into the built bundle. A missing hand
  tracking usage description means authorization is refused, and the app looks broken rather than
  unpermitted. Also confirm the key spelling against current documentation — it is the kind of
  thing that changes between SDK versions.
- **`ARKitSession` authorization is never requested explicitly.** `arSession.run([handProvider])`
  is called directly. Request authorization, and handle denial with a visible message instead of a
  `print`.
- **Snippet tray shows the wrong digits.** `depositSnippet` is passed `engine.digits`, the *current*
  ribbon contents, not the snipped range. The tray will misrepresent what was captured.
- **JSON is hand-built by string interpolation.** `scissors(name:)` escapes double quotes but not
  backslashes or control characters, so a snippet name containing `\` emits malformed JSON, which
  the Rust parser drops silently. Use `Codable` in both directions.
- **Snippets are memory-only** and capped at 20 by `snippets.removeFirst()`. A long test session
  will silently discard early captures — including, quite likely, the good ones. Persist to disk
  before the session, not after.
- **Test target is an empty stub.** No coverage anywhere in the Swift app.
- **`.windowStyle(.plain)`** removes the glass background; check the 2D panel is legible against a
  bright passthrough room, since that is where the fallback controls live.

---

## Remediation plan

**Track A — make it connect (3.5 days, one engineer)**
B1 transport to TCP plus Bonjour, both Info.plist keys, `NWConnection` rewrite (subsumes M3),
B5 entitlements, clean device install verified.

**Track B — make it respond (4 days, one engineer)**
B3 wire the four feedback features, B4 rewrite the curl metric plus the debug overlay, M4 gesture
exclusion, M5 race, M7 actor hygiene.

**Track C — make it fast and audible (3.5 days, either engineer after A)**
M1 status throttle, M2 mesh and material caching, B2 on-device audio via `AVAudioEngine`.

Tracks A and B are independent and should run in parallel. C depends on A. Total wall-clock with
two engineers: **about one week**, leaving the remainder of September for actual testing.

---

## Pre-flight checklist

Run this before the headset goes on, every session. Most of these have already failed once.

1. Clean install on device succeeds — entitlements and provisioning verified.
2. Hand tracking authorization prompt appears and is granted.
3. Engine discovered over Bonjour; status indicator green within 5 seconds.
4. Each of the six gestures fires once, confirmed in the debug overlay, before any music is made.
5. Hand ghosts visible and tracking.
6. Clap produces stitching **and** audio from the headset.
7. Scissors produces the name sheet, and the named snippet appears in the tray with the correct
   pair count.
8. Frame rate held at 90 fps with 60 patches per ribbon — check before, not after, a long session.
9. Snippet persistence verified across an app restart.
10. Gesture traces recorded to disk for offline threshold tuning.

---

## Consequence for the development plan

The plan filed earlier places client work in **P7**, after the representation migration. That is
wrong given a September test window, and the sequencing should change:

- **Promote the instrument to a parallel track starting immediately**, alongside P0 and P1. It has
  no dependency on the service, the galleries, or the term representation — the engine already
  runs standalone.
- **Add the on-device engine (the B1 strategic path) as an explicit deliverable of P2**, not P7.
  Compiling the spigot crates for `arm64-apple-visionos` is the same refactor as compiling them to
  WebAssembly for the browser: one realisation engine, several hosts. Doing both from one FFI
  design is materially cheaper than doing them a phase apart.
- **Treat the September sessions as gesture-corpus capture as much as as evaluation.** The
  thresholds in `GestureRecognizer` are guesses, one of them is provably wrong, and there is no
  data to tune them against. Recorded traces are the durable output of the test window and feed
  directly into the performance-recording work in P3 — a performance trace and a gesture-tuning
  trace are the same artifact.
