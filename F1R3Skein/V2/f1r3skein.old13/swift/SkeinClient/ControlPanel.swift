// ControlPanel.swift
//
// The 2D panel. Two jobs, both required by the specification.
//
// 1. Panel equivalents for every gesture (§6.4, §12). Halt is a head tilt and
//    snip needs both hands; neither is available to everyone, and neither
//    works in the Simulator, where hand tracking does not exist. Bringing up
//    transport, audio and rendering in the Simulator before spending headset
//    time depends entirely on these controls.
//
// 2. The debug overlay (§14): live metrics and a manual label marker, so a
//    tester can annotate "that was a scissors" as it happens.
//
// The controls are mode-aware, mirroring the engine. Offering a pull button
// in meta play would invite the rejection rather than explain the model.

import SwiftUI
import simd

struct ControlPanel: View {

    @Environment(SkeinModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openImmersiveSpace) private var openImmersive
    @Environment(\.dismissImmersiveSpace) private var dismissImmersive

    @Binding var immersive: Bool

    @State private var near: Double = 0
    @State private var far: Double = 8
    @State private var renaming: TrayEntry?
    @State private var newName = ""
    @State private var manualHost = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()
            streams
            Divider()
            if model.isMeta { metaControls } else { playControls }
            Divider()
            trayView
            if model.showDebug { Divider(); debugOverlay }
            Spacer(minLength: 0)
            footer
        }
        .padding(20)
        .alert(
            "Hand tracking unavailable",
            isPresented: .constant(model.authorizationProblem != nil)
        ) {
            Button("OK") { }
        } message: {
            Text(model.authorizationProblem ?? "")
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Circle().fill(connectionColour).frame(width: 10, height: 10)
            Text(connectionText).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text("F1R3Skein").font(.headline)
        }
    }

    private var connectionColour: Color {
        switch model.connection {
        case .ready: return .green
        case .connecting, .browsing: return .yellow
        case .failed: return .red
        case .idle: return .gray
        }
    }

    private var connectionText: String {
        switch model.connection {
        case .idle: return "idle"
        case .browsing: return "looking for the engine…"
        case .connecting(let e): return "connecting to \(e)"
        case .ready: return "engine connected"
        case .failed(let e): return "failed: \(e)"
        }
    }

    // MARK: - Streams and wave

    private var streams: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                label("left", model.leftLabel, "\(model.leftPos)")
                Spacer()
                label("right", model.rightLabel, "\(model.rightPos)")
            }
            HStack(spacing: 12) {
                Text(model.zip.zipped ? "zipped" : "unzipped")
                    .font(.caption.bold())
                if model.zip.zipped {
                    Text("front \(model.zip.front)").font(.caption)
                    Text("\(model.zip.tempo) bpm").font(.caption)
                    Text(model.zip.running ? "running" : stoppedText)
                        .font(.caption)
                        .foregroundStyle(model.zip.running ? .green : .orange)
                }
            }
            // The approach signal. Without it a run simply stops at the
            // frontier and reads as a crash.
            if model.zip.warning {
                Label(
                    "approaching the end of the wave — \(model.zip.budgetLeft) notches left",
                    systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private var stoppedText: String {
        switch model.zip.stoppedBy {
        case "halt": return "halted"
        case "mount": return "stopped — mounted"
        case "exhausted": return "wave exhausted"
        default: return "stopped"
        }
    }

    private func label(_ side: String, _ name: String, _ pos: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(side).font(.caption2).foregroundStyle(.tertiary)
            Text(name).font(.caption.bold())
            Text("pos \(pos)").font(.caption2).foregroundStyle(.secondary)
        }
    }

    // MARK: - Play mode

    private var playControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("play — ribbons in hand").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("Pull left") {
                    model.send(.pullLeft(steps: 1, velocity: 0.5))
                }
                Button("Pull right") {
                    model.send(.pullRight(steps: 1, velocity: 0.5))
                }
                Button("Twist") { model.send(.twist) }
            }
            .disabled(model.zip.zipped)

            HStack(spacing: 10) {
                // Closing speed is the tempo, so the panel offers three.
                Menu("Zip") {
                    Button("slow") { model.send(.zip(closingSpeed: 0.2)) }
                    Button("medium") { model.send(.zip(closingSpeed: 0.6)) }
                    Button("fast") { model.send(.zip(closingSpeed: 1.1)) }
                }
                .disabled(model.zip.zipped)

                Button("Unzip") { model.send(.unzip) }
                    .disabled(!model.zip.zipped)

                // Set and clear, matching the head gesture exactly.
                Button(model.zip.running ? "Halt" : "Resume") {
                    model.send(.halt(on: model.zip.running))
                }
                .disabled(!model.zip.zipped)

                Button("Mount") { model.send(.mount) }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: - Meta mode

    private var metaControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("meta — ribbons mounted, hands free")
                .font(.caption).foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button(model.looping ? "Stop loop" : "Loop") {
                    model.send(.loop(on: !model.looping))
                }
                Button("Unmount") { model.send(.unmount) }
                    .buttonStyle(.borderedProminent)
            }

            // Two boundaries, because the capture is bracketed by both hands.
            VStack(alignment: .leading, spacing: 4) {
                Text("capture \(Int(near)) – \(Int(far))  (\(max(0, Int(far - near))) notches)")
                    .font(.caption)
                Slider(value: $near, in: 0...Double(max(model.zip.front, 1)))
                Slider(value: $far, in: 0...Double(max(model.zip.front, 1)))
                Button("Snip") {
                    model.send(.snip(near: Int(near), far: Int(far)))
                }
                .disabled(far <= near || Int(far) > model.zip.front)
            }
            if let r = model.lastRejection {
                Text("refused: \(r)").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    // MARK: - Tray

    private var trayView: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("tray — \(model.tray.count) captures")
                .font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.tray) { t in
                        VStack(spacing: 2) {
                            Text(t.name).font(.caption.bold())
                            Text("\(t.count) notches").font(.caption2)
                            Text("(\(t.iLeft), \(t.iRight))")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(.ultraThinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .onTapGesture { renaming = t; newName = t.name }
                    }
                }
            }
            .frame(height: 64)
        }
        .sheet(item: $renaming) { entry in
            VStack(spacing: 16) {
                Text("Rename capture").font(.headline)
                TextField("name", text: $newName)
                    .textFieldStyle(.roundedBorder).frame(width: 260)
                HStack {
                    Button("Cancel") { renaming = nil }
                    Button("Save") {
                        model.rename(entry.id, to: newName)
                        renaming = nil
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(28)
        }
    }

    // MARK: - Debug overlay

    private var debugOverlay: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("debug").font(.caption.bold())
            Text("frames sent \(model.framesSent) · notes heard \(model.notesHeard)")
                .font(.caption2)
            // The ribbon chain, end to end: messages received, array lengths on
            // the wire, lengths after decoding, entities built, entities shown.
            Text("digits msgs \(model.digitsMessages) · wire L/R "
                 + "\(model.lastDigitsWire.left)/\(model.lastDigitsWire.right)")
                .font(.caption2)
            Text("decoded L/R \(model.leftDigits.count)/\(model.rightDigits.count) · "
                 + "patches \(model.scenePatches) · shown \(model.sceneEnabled)")
                .font(.caption2)
            if let h = model.lastHead {
                Text(String(format: "head roll %.1f°", h.roll * 180 / .pi))
                    .font(.caption2)
            }
            if let l = model.lastLeftHand, let r = model.lastRightHand {
                let sep = sqrt(
                    pow(l.wrist.x - r.wrist.x, 2) + pow(l.wrist.y - r.wrist.y, 2)
                        + pow(l.wrist.z - r.wrist.z, 2))
                Text(String(format: "hand separation %.3f m", sep)).font(.caption2)
                Text(String(format: "curl ring L %.2f  R %.2f",
                            straightness(l.ring), straightness(r.ring)))
                    .font(.caption2)
            }
            if let url = model.traceURL {
                Text("trace \(url.lastPathComponent)")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    /// The same scale-invariant metric the engine uses: the interior angle at
    /// the proximal interphalangeal joint, divided by pi. Shown live so the
    /// thresholds can be judged against real hands rather than guessed.
    private func straightness(_ f: SkeinFinger) -> Float {
        let a = SIMD3(f.knuckle.x - f.pip.x, f.knuckle.y - f.pip.y, f.knuckle.z - f.pip.z)
        let b = SIMD3(f.dip.x - f.pip.x, f.dip.y - f.pip.y, f.dip.z - f.pip.z)
        let la = sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
        let lb = sqrt(b.x * b.x + b.y * b.y + b.z * b.z)
        guard la > 1e-6, lb > 1e-6 else { return 1 }
        let d = max(-1, min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb)))
        return acos(d) / .pi
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.status.isEmpty {
                Text(model.status).font(.caption2).foregroundStyle(.tertiary)
            }
            if let e = model.lastError {
                Text(e).font(.caption2).foregroundStyle(.red)
            }
            // Audio is lazily started and may decline; a silent instrument
            // should say why rather than leave M guessing.
            if let p = model.audioProblem, !model.audioRunning {
                Label(p, systemImage: "speaker.slash")
                    .font(.caption2).foregroundStyle(.orange)
            }
            if let t = model.trackingNote {
                Label(t, systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Button(immersive ? "Exit 3D" : "Enter 3D") {
                    Task {
                        if immersive {
                            await dismissImmersive()
                            immersive = false
                        } else {
                            // Follow the actual result. Toggling regardless
                            // leaves the panel claiming a space that does not
                            // exist, and the next gesture then talks to a nil
                            // scene.
                            switch await openImmersive(id: "ribbons") {
                            case .opened:
                                immersive = true
                            case .userCancelled:
                                immersive = false
                            case .error:
                                immersive = false
                                model.noteImmersiveFailure(
                                    "Could not open the 3D space.")
                            @unknown default:
                                immersive = false
                            }
                        }
                    }
                }
                .buttonStyle(.borderedProminent)

                Toggle("Debug", isOn: Binding(
                    get: { model.showDebug },
                    set: { model.showDebug = $0 }))
                    .toggleStyle(.button)

                Button("Sound") { openWindow(id: "sound") }

                // No height control: the surface follows M's hands. Only the
                // spools are placed, and this puts them back in front of her.
                if immersive {
                    Button("Recentre") { model.recentre() }
                }

                if case .failed = model.connection {
                    TextField("host", text: $manualHost)
                        .textFieldStyle(.roundedBorder).frame(width: 130)
                    Button("Connect") {
                        model.connect(host: manualHost, port: 7643)
                    }
                    .disabled(manualHost.isEmpty)
                }

                Spacer()

                // Closes the socket cleanly and finalises the performance
                // trace. Leaving by the Digital Crown drops the socket instead,
                // which works but leaves the trace without an end timestamp.
                Button("End session", role: .destructive) {
                    Task {
                        if immersive {
                            await dismissImmersive()
                            immersive = false
                        }
                        model.stop()
                    }
                }
            }
        }
    }
}
