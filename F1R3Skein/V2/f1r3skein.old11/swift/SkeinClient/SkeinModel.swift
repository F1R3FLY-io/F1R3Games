// SkeinModel.swift
//
// The one place engine state lands. The client holds no authoritative state
// (spec §5): it renders what the engine says and forwards samples.

import Foundation
import Observation
import simd

@MainActor
@Observable
public final class SkeinModel {

    // Connection
    public var connection: ChannelState = .idle
    public var lastError: String?
    /// Shown when hand-tracking authorization is refused. The previous client
    /// reported this to the console, so a refused permission looked like a
    /// broken app.
    public var authorizationProblem: String?

    // Engine state
    public var mode: String = "play"
    public var looping = false
    public var zip = ZipState()
    public var leftLabel = "—"
    public var rightLabel = "—"
    public var pitchMap = "pentatonic_minor"
    public var durationMap = "musical"
    public var status = ""
    public var lastRejection: String?
    /// World-tracking provider state, which gates the halt gesture.
    public var trackingNote: String?

    // Ribbons
    public var leftDigits: [UInt8] = []
    public var rightDigits: [UInt8] = []
    public var leftPos = 0
    public var rightPos = 0

    // Tray
    public var tray: [TrayEntry] = []

    // Debug overlay (spec §14)
    public var showDebug = false
    public var framesSent = 0
    public var notesHeard = 0
    /// Wire-level counts, recorded before the scene is touched, so a rendering
    /// fault can be told apart from a protocol one.
    public var digitsMessages = 0
    public var lastDigitsWire = (left: 0, right: 0)
    public var scenePatches = 0
    public var sceneEnabled = 0
    public var lastHead: SkeinHead?
    public var lastLeftHand: SkeinHand?
    public var lastRightHand: SkeinHand?

    public var isMeta: Bool { mode == "meta" }

    private let channel = SkeinChannel()
    private let audio = SkeinAudio()
    private let feed = HandFeed()
    private let recorder = TraceRecorder()

    /// The scene is created by the immersive view and handed back here so
    /// engine messages can drive it.
    public weak var scene: RibbonScene?

    public init() {
        channel.onState = { [weak self] s in
            Task { @MainActor in self?.connection = s }
        }
        channel.onMessage = { [weak self] dict in
            Task { @MainActor in self?.handle(dict) }
        }
        feed.onFrame = { [weak self] frame in
            Task { @MainActor in self?.forward(frame) }
        }
        feed.onRawSample = { [weak self] data in
            self?.recorder.append(data)
        }
        feed.onAuthorizationDenied = { [weak self] text in
            Task { @MainActor in self?.authorizationProblem = text }
        }
        feed.onNote = { [weak self] text in
            Task { @MainActor in self?.trackingNote = text }
        }
    }

    // MARK: - Lifecycle

    public func start() {
        // Prepare the session only. The audio graph is built lazily on the
        // first note: at launch the session is frequently not ready, and
        // building against a dead session raises an Objective-C exception that
        // Swift cannot catch.
        audio.prepare()
        recorder.begin()
        channel.start()
    }

    /// Manual fallback when Bonjour discovery is unavailable.
    public func connect(host: String, port: UInt16) {
        channel.connect(host: host, port: port)
    }

    public func startTracking() async {
        // The immersive space is open by now, which is the point at which the
        // audio session is reliably available. Gate nothing on the result.
        audio.startIfPossible()
        if let p = audio.lastProblem { lastError = p }
        await feed.start()
    }

    /// Place each ribbon's voice at its own position in the scene.
    public func positionAudio(left: SIMD3<Float>, right: SIMD3<Float>) {
        audio.position(left: left, right: right)
    }

    /// Put the spools back in front of M, wherever she is now.
    public func recentre() {
        scene?.recentre()
    }

    public func noteImmersiveFailure(_ text: String) {
        lastError = text
    }

    /// Audio state for the panel, so a silent instrument explains itself.
    public var audioProblem: String? { audio.lastProblem }
    public var audioRunning: Bool { audio.isRunning }

    public func stop() {
        channel.send(ClientMessage.quit)
        channel.stop()
        audio.stop()
        recorder.end()
    }

    // MARK: - Outbound

    private func forward(_ frame: SkeinFrame) {
        framesSent += 1
        lastLeftHand = frame.left
        lastRightHand = frame.right
        lastHead = frame.head
        channel.send(ClientMessage.frame(frame))
        scene?.updateGhosts(left: frame.left, right: frame.right)
        // The near end of each ribbon is read, not calculated: a ribbon runs
        // from M's hand to its spool. Mounted, it runs from the clips instead.
        scene?.setAnchors(
            left: frame.left.map { SIMD3($0.wrist.x, $0.wrist.y, $0.wrist.z) },
            right: frame.right.map { SIMD3($0.wrist.x, $0.wrist.y, $0.wrist.z) },
            mounted: isMeta)
    }

    /// Panel equivalents. Required by the spec so that a head-only or
    /// hands-only control is never the sole route to a gesture.
    public func send(_ g: SkeinGesture) {
        channel.send(ClientMessage.gesture(g))
    }

    public func rename(_ id: UInt64, to name: String) {
        channel.send(ClientMessage.rename(id: id, name: name))
        if let i = tray.firstIndex(where: { $0.id == id }) { tray[i].name = name }
    }

    public func setMaps(pitch: String, duration: String, root: UInt8) {
        pitchMap = pitch
        durationMap = duration
        channel.send(
            ClientMessage.configure(
                pitchMap: pitch, durationMap: duration, root: root, instrument: nil))
    }

    // MARK: - Inbound

    private func handle(_ d: [String: Any]) {
        switch d["type"] as? String {

        case "digits":
            digitsMessages += 1
            // Count the raw arrays before any casting, so a bridging failure
            // shows up as a mismatch rather than as silence.
            let rawL = (d["left"] as? [Any])?.count ?? -1
            let rawR = (d["right"] as? [Any])?.count ?? -1
            lastDigitsWire = (rawL, rawR)
            leftDigits = (d["left"] as? [NSNumber])?.map { UInt8(clamping: $0.intValue) } ?? []
            rightDigits = (d["right"] as? [NSNumber])?.map { UInt8(clamping: $0.intValue) } ?? []
            leftPos = d["left_pos"] as? Int ?? leftPos
            rightPos = d["right_pos"] as? Int ?? rightPos
            scene?.update(left: leftDigits, right: rightDigits, base: 22)
            scenePatches = scene?.patchCount ?? -1
            sceneEnabled = scene?.enabledPatchCount ?? -1

        case "note":
            notesHeard += 1
            guard let n = d["note"] as? [String: Any] else { break }
            let pitch = n["pitch"] as? Int
            let ticks = n["ticks"] as? Int ?? 240
            let vel = n["velocity"] as? Int ?? 100
            audio.play(
                pitch: pitch.map { UInt8(clamping: $0) },
                ticks: UInt32(ticks),
                velocity: UInt8(clamping: vel),
                tempoBPM: max(zip.tempo, 1))
            if let idx = d["notch_index"] as? Int {
                scene?.updateMesh(front: idx, visible: min(idx + 1, 60))
            }

        case "zip_state":
            let previous = zip
            zip = ZipState(d)
            if !previous.zipped && zip.zipped { firstMeshILeft = leftPos }
            scene?.placeFront(
                at: zip.front, running: zip.running, warning: zip.warning)
            if let max = budgetMax {
                scene?.compress(budgetUsed: 1 - Float(zip.budgetLeft) / Float(max))
            }
            // A held note must not hang through a silence M placed on purpose.
            if previous.running && !zip.running { audio.allNotesOff() }
            if !zip.zipped { scene?.updateMesh(front: 0, visible: 0) }

        case "snip_ack":
            guard let id = d["id"] as? Int else { break }
            let entry = TrayEntry(
                id: UInt64(id),
                name: d["name"] as? String ?? "take",
                count: d["count"] as? Int ?? 0,
                iLeft: d["i_left"] as? Int ?? 0,
                iRight: d["i_right"] as? Int ?? 0)
            tray.append(entry)
            recorder.note(capture: entry)
            // Show the copy lifting clear while the band stays whole: the cut
            // is virtual, and rendering a gap would teach M to expect material
            // to be consumed.
            let near = entry.iLeft - firstMeshILeft
            scene?.showCapture(near: max(0, near), far: max(0, near) + entry.count)

        case "state":
            mode = d["mode"] as? String ?? mode
            looping = d["looping"] as? Bool ?? looping
            leftLabel = d["left_label"] as? String ?? leftLabel
            rightLabel = d["right_label"] as? String ?? rightLabel
            pitchMap = d["pitch_map"] as? String ?? pitchMap
            durationMap = d["duration_map"] as? String ?? durationMap

        case "status":
            status = d["text"] as? String ?? ""

        case "rejected":
            // Surfaced rather than swallowed, so the overlay can show M what
            // the instrument thought.
            lastRejection = d["reason"] as? String

        case "error":
            lastError = "\(d["code"] as? String ?? "error"): \(d["text"] as? String ?? "")"

        default:
            break
        }
    }

    /// Inferred from the first zip_state seen, so the client need not carry a
    /// second copy of the calibration.
    /// The mesh anchor, so a capture's absolute cursor position can be shown
    /// as an offset along the visible band.
    private var firstMeshILeft = 0

    private var budgetMaxStore: Int?
    private var budgetMax: Int? {
        if budgetMaxStore == nil, !zip.zipped, zip.budgetLeft > 0 {
            budgetMaxStore = zip.budgetLeft
        }
        return budgetMaxStore
    }

    public var traceURL: URL? { recorder.currentURL }
}
