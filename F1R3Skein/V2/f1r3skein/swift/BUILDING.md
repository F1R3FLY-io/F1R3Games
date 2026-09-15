# Building and installing the client

## The entitlements question, settled

**There is no entitlements file, and that is deliberate.**

The old project carried `LeapSpigotVision.entitlements` containing
`com.apple.security.app-sandbox`, `com.apple.security.network.client` and
`com.apple.security.files.user-selected.read-write` — macOS App Sandbox keys
that have no meaning in the iOS/visionOS sandbox model — plus
`com.apple.developer.arkit.hand-tracking`. No build configuration referenced
the file, so none of it applied.

Hand tracking in a normal visionOS app is gated by the `ARKitSession`
authorization prompt and the `NSHandsTrackingUsageDescription` string, not by
an entitlement. Local network access is likewise gated by
`NSLocalNetworkUsageDescription` and `NSBonjourServices`. All three are in
`Info.plist`.

So: **do not add a `.entitlements` file** unless something later demands one.
An unrecognised `com.apple.developer.*` key that is absent from the
provisioning profile makes device installation *fail*, which is a bad thing to
discover with the headset on. If you do find you need one, add the single key
in question and re-download the profile.

## The sound bank

The app expects `GeneralUser-GS.sf2` as a bundle resource. It is not in the
repository — 32 MB of binary does not belong in git — so fetch it once and drop
it in:

```sh
mkdir -p swift/SkeinClient/Resources
cp /path/to/GeneralUser-GS.sf2 swift/SkeinClient/Resources/
```

XcodeGen picks up non-source files under the target path as resources
automatically; for a hand-built target, add it to Copy Bundle Resources.

**`AVAudioUnitSampler` loads `.sf2` and `.dls` only — not `.sf3`.** The
Ogg-compressed format fails to load silently, which matters because several of
the best free banks ship that way. Convert first if you want one of them.

Without the bank the app still plays: the sampler falls back to a bare default
tone, and the panel says the bank was not found.

## Info.plist keys, and why each one is load-bearing

Every one of these has produced a distinct failure during bring-up. They are
listed with their symptoms so a missing key can be identified from the log
rather than guessed at.

| Key | Missing symptom |
|---|---|
| `NSHandsTrackingUsageDescription` | ARKit authorization refused; app looks broken rather than unpermitted |
| `NSWorldSensingUsageDescription` | **Fatal.** `NSInternalInconsistencyException` from `ar_session_request_authorization` — an uncatchable throw, not a refusal |
| `NSLocalNetworkUsageDescription` | Connection blocked at the first packet; looks like a silent timeout |
| `NSBonjourServices` | `DNSServiceBrowse failed: NoAuth(-65555)`, and **no permission prompt is ever shown** |
| `UIApplicationSceneManifest` with `UIApplicationSupportsMultipleScenes` | `openImmersiveSpace` refuses: "app does not support multiple scenes" |
| `CFBundleExecutable` (supplied by Xcode, not by hand) | Build succeeds, install fails with CoreDeviceError 3002 |

Two traps worth stating outright. A `UISceneConfigurations` dictionary in the
manifest — even an empty one — leaves the process running with **no window ever
created**, which looks nothing like the multiple-scenes failure but sits one
line away from it. And the authorization list passed to
`ARKitSession.requestAuthorization` must match the plist keys present:
requesting one whose usage string is absent is fatal, so ask only for what is
needed. `WorldTrackingProvider` needs no authorization at all.

## If the install fails with CoreDeviceError 3002

The build succeeded and the bundle is structurally invalid. The usual cause is
an `Info.plist` that carries only the app's own keys and omits the ones Xcode
normally supplies — `CFBundleExecutable` above all. Without it there is nothing
to launch and the device refuses the bundle.

`project.yml` now has XcodeGen generate a complete plist and merge our keys
into it, so this should not recur. Confirm after a build:

```sh
plutil -p ~/Library/Developer/Xcode/DerivedData/F1R3Skein-*/Build/Products/*/\
F1R3Skein.app/Info.plist | grep -E "CFBundleExecutable|Bonjour|LocalNetwork|Hands"
```

Four lines. If `CFBundleExecutable` is absent, the plist is hand-written rather
than generated — `xcodegen generate` again and clean the build folder.

The underlying reason for a 3002 is always nested below it in the Report
navigator (Command-9); the outer code says nothing on its own.

## If the connection is refused after discovery succeeds

Signature in the Xcode console: `flags=[R.]` in state `SYN_SENT` against
port 7643, at addresses like `fe80::…` or `2601:…`.

Those are IPv6. Bonjour resolved the engine correctly and the TCP connection
was then **reset**, meaning nothing was listening at that address. visionOS
prefers IPv6, so an IPv4-only listener fails here even though discovery worked
perfectly.

The engine now binds both `[::]:7643` and `0.0.0.0:7643` and logs each. Check
its output on the Mac:

```
[engine] listening on [::]:7643
[engine] listening on 0.0.0.0:7643
```

If the IPv6 line is missing or reports an error, the Mac has no IPv6 on that
interface, and the headset must be pointed at the IPv4 address by hand — the
panel offers a host field when discovery fails.

## If Bonjour browsing fails with `NoAuth(-65555)`

The built app has the wrong Info.plist. Verify it before anything else:

```sh
# from the built product, wherever DerivedData put it
plutil -p ~/Library/Developer/Xcode/DerivedData/F1R3Skein-*/Build/Products/\
Debug-xros/F1R3Skein.app/Info.plist | grep -E "Bonjour|LocalNetwork|Hands"
```

You should see `NSBonjourServices` with `_f1r3skein._tcp`,
`NSLocalNetworkUsageDescription` and `NSHandsTrackingUsageDescription`. If they
are missing, regenerate the project (`xcodegen generate`) — earlier versions of
`project.yml` carried an `info:` block that overwrote the hand-written plist.

Without `NSBonjourServices` the browse is refused outright and **no permission
prompt is ever shown**, so there is nothing to grant in Settings. The symptom is
`nw_browser_fail_on_dns_error_locked ... DNSServiceBrowse failed: NoAuth(-65555)`
repeating once per retry.

If the keys are present and browsing still fails, the permission was declined
on a previous launch: Settings → Privacy & Security → Local Network, and enable
F1R3Skein.

## Option A — generate the project (recommended)

`project.yml` in this directory is an [XcodeGen](https://github.com/yonaskolb/XcodeGen)
spec. It produces a clean visionOS target with no inherited defects.

```sh
brew install xcodegen
cd swift
xcodegen generate          # writes F1R3Skein.xcodeproj
open F1R3Skein.xcodeproj
```

Then set your team in Signing & Capabilities and press Run.

## Option B — by hand in Xcode

1. File → New → Project → visionOS → App. Name it `F1R3Skein`, interface
   SwiftUI, and choose **Volumetric or Window** with an immersive space; either
   is fine, the app declares both scenes itself.
2. Delete the generated `ContentView.swift` and the generated `App` file.
3. Drag every `.swift` file from `SkeinClient/` into the target.
4. **Do not replace** the generated `Info.plist` with `SkeinClient/Info.plist`.
   Xcode's own plist carries `CFBundleExecutable` and other keys the bundle
   cannot install without. Instead, copy the four F1R3Skein keys —
   `NSHandsTrackingUsageDescription`, `NSLocalNetworkUsageDescription`,
   `NSBonjourServices`, `UIFileSharingEnabled` — into it. The supplied
   `Info.plist` is a reference for those values, not a drop-in replacement.
5. Set the deployment target to visionOS 2.0 or later and the Swift language
   version to 5.
6. Remove any `.entitlements` reference. See above.

## Pairing and installing

No Developer Strap is needed; it only speeds up installs of asset-heavy apps,
and this one is small.

1. Mac and headset on the **same Wi-Fi network**. A VPN on the Mac, or a guest
   network with client isolation, will silently prevent pairing.
2. On the headset: Settings → General → Remote Devices, which puts it in
   pairing mode.
3. In Xcode: the device dropdown → Manage Run Destinations, select the headset,
   enter the verification code shown on it.
4. Build once. You will get an error saying Developer Mode is not enabled — the
   setting only appears after this attempt. Then on the headset: Privacy &
   Security → Developer Mode. **The device reboots.**
5. Build and run.

If the headset never appears in Xcode, reboot both and restart Xcode before
investigating anything else; that resolves most of these.

## Running a session

```sh
# Terminal 1 — the engine
cargo run -p skein-engine

# Terminal 2 — advertise it, since the engine does not yet do this itself
dns-sd -R "F1R3Skein" _f1r3skein._tcp local 7643
```

macOS will prompt to allow incoming connections on 7643 the first time. The
app browses for `_f1r3skein._tcp` and connects on its own; the panel indicator
turns green. If discovery fails the panel offers a host field as a fallback.

## Do the Simulator first

The Simulator shares the Mac's network, so **transport, audio, rendering, the
tray and the whole protocol can be proved without the headset**. Hand tracking
is the only thing it cannot do, which is exactly what the panel equivalents are
for — every one of the ten gestures has a button.

Given a deadline, prove connect, sound and ribbons in the Simulator, and spend
headset time only on gestures.

## First session on device — order of operations

Per the conformance checklist, and in this order, because each step depends on
the one before it:

1. Clean install succeeds.
2. Hand-tracking permission is requested and granted. Denial shows an alert
   rather than a console line.
3. The engine is discovered; the indicator goes green within five seconds.
4. Turn on **Debug** in the panel and fire all ten gestures, watching the
   metrics, *before* attempting any music. Half a day of capture beats a day of
   guessing.
5. Only then play.

Traces land in the app's Documents directory as `traces/session-*.ndjson`, one
JSON object per line, so a truncated file is still readable up to its last
complete line. `UIFileSharingEnabled` is set, so you can pull them off the
device with the Files app rather than another build.
