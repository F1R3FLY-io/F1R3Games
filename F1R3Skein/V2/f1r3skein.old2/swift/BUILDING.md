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
4. Replace the generated `Info.plist` with the one in `SkeinClient/`, or copy
   the four F1R3Skein-specific keys across.
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
