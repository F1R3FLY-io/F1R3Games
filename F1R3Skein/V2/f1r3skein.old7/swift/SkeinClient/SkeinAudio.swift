// SkeinAudio.swift
//
// On-device audio. Spec §13.
//
// Sound must come from the headset. The previous architecture drove CoreMIDI on
// whichever host ran the engine — M pulled a ribbon in front of her face and
// heard the result from a laptop across the room, after a network hop and a
// MIDI buffer.
//
// WHY THIS IS WRITTEN SO DEFENSIVELY
//
// The first device run crashed here:
//
//     AVAudioSession_iOS.mm:597  Creating proxy session failed, error = -50
//     AURemoteIO.cpp:284         no reporter associated with ... session
//
// The chain is: session activation fails, so the output node has no valid
// hardware format (sample rate 0), and *touching mainMixerNode then raises an
// Objective-C exception*. Swift cannot catch that, so no amount of `try` helps.
// The only defence is to check the preconditions and decline to build the graph
// when they do not hold.
//
// Hence: nothing is built at launch; the graph is built lazily on the first
// note, by which time the scene exists and the session is usually available;
// the output format is verified before mainMixerNode is touched at all; and
// failure retries a few times rather than being fatal or permanent.

import AVFoundation
import QuartzCore

public final class SkeinAudio {

    /// 3D positioning per ribbon. Off by default: connecting a stereo sampler
    /// to an AVAudioEnvironmentNode also throws rather than returning an
    /// error, because 3D mixing requires mono inputs.
    public var spatialise = false

    private var engine: AVAudioEngine?
    private var sampler: AVAudioUnitSampler?

    private var sessionReady = false
    private var attempts = 0
    private let maxAttempts = 5

    private var active: [(note: UInt8, until: TimeInterval)] = []

    /// Reported, never thrown. Audio is a feature of the instrument, not a
    /// precondition for it.
    public private(set) var lastProblem: String?
    public var isRunning: Bool { engine?.isRunning ?? false }

    public init() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(interrupted(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(routeChanged(_:)),
            name: AVAudioSession.routeChangeNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: - Session

    /// Prepare the session only. Deliberately does **not** build the audio
    /// graph: at launch the session is frequently not ready, and building a
    /// graph against a dead session is what crashed.
    public func prepare() {
        activateSession()
    }

    @discardableResult
    private func activateSession() -> Bool {
        if sessionReady { return true }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            sessionReady = true
            lastProblem = nil
            return true
        } catch {
            lastProblem = "audio session: \(error.localizedDescription)"
            return false
        }
    }

    // MARK: - Graph

    /// Build and start the graph, or report why not. Safe to call repeatedly.
    @discardableResult
    private func ensureRunning() -> Bool {
        if let e = engine, e.isRunning { return true }
        guard attempts < maxAttempts else { return false }
        attempts += 1

        guard activateSession() else { return false }

        let e = engine ?? AVAudioEngine()
        engine = e

        // THE GUARD THAT MATTERS. Reading the output node's format is safe;
        // touching mainMixerNode with an invalid one is not.
        let outFormat = e.outputNode.outputFormat(forBus: 0)
        guard outFormat.sampleRate > 0, outFormat.channelCount > 0 else {
            lastProblem =
                "audio output not ready (sample rate \(outFormat.sampleRate)); will retry"
            return false
        }

        if sampler == nil {
            let s = AVAudioUnitSampler()
            e.attach(s)
            let format = AVAudioFormat(
                standardFormatWithSampleRate: outFormat.sampleRate, channels: 2)
            e.connect(s, to: e.mainMixerNode, format: format)
            sampler = s
        }

        do {
            // Small buffer: the gesture-to-audible-note budget is 30 ms target,
            // 50 ms maximum.
            try? AVAudioSession.sharedInstance().setPreferredIOBufferDuration(0.005)
            e.prepare()
            try e.start()
            lastProblem = nil
            attempts = 0
            return true
        } catch {
            lastProblem = "audio engine: \(error.localizedDescription)"
            return false
        }
    }

    public func stop() {
        allNotesOff()
        engine?.stop()
        engine = nil
        sampler = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        sessionReady = false
        attempts = 0
    }

    // MARK: - Playing

    public func setProgram(_ program: UInt8) {
        guard ensureRunning(), let s = sampler else { return }
        s.sendProgramChange(program, onChannel: 0)
    }

    /// One notch pair engaging. `ticks` are at 480 to the quarter note; the
    /// tempo comes from the mesh and is fixed for its life.
    public func play(pitch: UInt8?, ticks: UInt32, velocity: UInt8, tempoBPM: Int) {
        guard let pitch else { return }          // a silence sounds nothing
        guard ensureRunning(), let s = sampler else { return }

        let seconds = Double(ticks) / 480.0 * (60.0 / Double(max(tempoBPM, 1)))
        s.startNote(pitch, withVelocity: velocity, onChannel: 0)
        active.append((pitch, CACurrentMediaTime() + seconds))
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, let s = self.sampler else { return }
            s.stopNote(pitch, onChannel: 0)
            self.active.removeAll { $0.note == pitch && $0.until <= CACurrentMediaTime() }
        }
    }

    /// Every voice off. Used when the wave halts, so a held note does not hang
    /// through a silence M placed deliberately.
    public func allNotesOff() {
        guard let s = sampler else { return }
        for (note, _) in active { s.stopNote(note, onChannel: 0) }
        active.removeAll()
    }

    /// A no-op unless `spatialise` was set and the environment path built.
    public func position(left: SIMD3<Float>, right: SIMD3<Float>) {
        guard spatialise, let s = sampler else { return }
        s.position = AVAudio3DPoint(x: left.x, y: left.y, z: left.z)
        _ = right
    }

    // MARK: - System events

    @objc private func interrupted(_ n: Notification) {
        guard
            let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        switch type {
        case .began:
            allNotesOff()
            engine?.pause()
        case .ended:
            sessionReady = false
            attempts = 0
            ensureRunning()
        @unknown default:
            break
        }
    }

    @objc private func routeChanged(_ n: Notification) {
        // A route change invalidates the hardware format, so rebuild rather
        // than play into a stale graph.
        allNotesOff()
        engine?.stop()
        engine = nil
        sampler = nil
        sessionReady = false
        attempts = 0
    }
}
