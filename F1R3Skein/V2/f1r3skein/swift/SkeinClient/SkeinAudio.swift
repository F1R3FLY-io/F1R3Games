// SkeinAudio.swift
//
// On-device audio. Spec §13.
//
// The previous architecture drove CoreMIDI on whichever host ran the engine,
// which was the Mac. M pulled a ribbon in front of her face and heard the
// result from a laptop across the room, after a network hop and a MIDI buffer.
// For an instrument that is disqualifying, and it makes the latency figure —
// the single most important measurement of a device session — unrepresentative
// of any shipping configuration.
//
// Two sampler nodes, one per ribbon, panned to their ribbon's position, so the
// two streams are audibly distinct as well as visually distinct.

import AVFoundation

public final class SkeinAudio {

    private let engine = AVAudioEngine()
    private let pitchSampler = AVAudioUnitSampler()
    private let durationSampler = AVAudioUnitSampler()
    private let mixer = AVAudioEnvironmentNode()

    /// Notes sounded by the zip front. The engine sends one per notch pair and
    /// never coalesces them.
    private var active: [(note: UInt8, until: TimeInterval)] = []

    public init() {
        engine.attach(mixer)
        engine.attach(pitchSampler)
        engine.attach(durationSampler)
        engine.connect(pitchSampler, to: mixer, format: nil)
        engine.connect(durationSampler, to: mixer, format: nil)
        engine.connect(mixer, to: engine.mainMixerNode, format: nil)
        mixer.renderingAlgorithm = .HRTF
    }

    public func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        // Small buffer: the gesture-to-audible-note budget is 30 ms target,
        // 50 ms maximum.
        try? session.setPreferredIOBufferDuration(0.005)
        try engine.start()
    }

    public func stop() {
        engine.stop()
    }

    /// Place each ribbon's voice at its own position in the scene.
    public func position(left: SIMD3<Float>, right: SIMD3<Float>) {
        pitchSampler.position = AVAudio3DPoint(x: left.x, y: left.y, z: left.z)
        durationSampler.position = AVAudio3DPoint(x: right.x, y: right.y, z: right.z)
    }

    public func setProgram(_ program: UInt8) {
        pitchSampler.sendProgramChange(program, onChannel: 0)
        durationSampler.sendProgramChange(program, onChannel: 0)
    }

    /// One notch pair engaging. `ticks` are at 480 to the quarter note; the
    /// tempo comes from the mesh and does not change for its life.
    public func play(pitch: UInt8?, ticks: UInt32, velocity: UInt8, tempoBPM: Int) {
        guard let pitch else { return }   // a silence sounds nothing
        let seconds = Double(ticks) / 480.0 * (60.0 / Double(max(tempoBPM, 1)))
        pitchSampler.startNote(pitch, withVelocity: velocity, onChannel: 0)
        let until = CACurrentMediaTime() + seconds
        active.append((pitch, until))
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            self?.pitchSampler.stopNote(pitch, onChannel: 0)
            self?.active.removeAll { $0.note == pitch && $0.until <= CACurrentMediaTime() }
        }
    }

    /// Every voice off — used when the wave halts, so a held note does not
    /// hang through a silence M placed deliberately.
    public func allNotesOff() {
        for (note, _) in active {
            pitchSampler.stopNote(note, onChannel: 0)
        }
        active.removeAll()
    }
}
