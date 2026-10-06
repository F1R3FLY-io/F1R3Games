// SkeinAudio.swift
//
// On-device audio. Spec §13.
//
// The previous architecture drove CoreMIDI on whichever host ran the engine,
// which was the Mac. M pulled a ribbon in front of her face and heard the
// result from a laptop across the room, after a network hop and a MIDI buffer.
// For an instrument that is disqualifying, and it makes the latency figure
// unrepresentative of any shipping configuration.
//
// TWO FIXES after the first device run.
//
// 1. Spatialisation is off by default. Connecting a stereo AVAudioUnitSampler
//    to an AVAudioEnvironmentNode raises an Objective-C exception rather than
//    returning an error, so a Swift `try`/`catch` never sees it and the app
//    dies at launch. 3D mixing requires mono inputs. The environment path is
//    retained behind `spatialise`, with an explicit mono format, and can be
//    switched on once there is time to verify it on device.
//
// 2. Nothing here is fatal. Audio is a feature of the instrument, not a
//    precondition for it: a failure reports itself and the rest of the app —
//    transport, ribbons, capture — keeps working.

import AVFoundation
import QuartzCore

public final class SkeinAudio {

    /// Off by default. See note 1 above.
    public var spatialise = false

    private let engine = AVAudioEngine()
    private let pitchSampler = AVAudioUnitSampler()
    private let durationSampler = AVAudioUnitSampler()
    private let environment = AVAudioEnvironmentNode()

    private var started = false
    private var active: [(note: UInt8, until: TimeInterval)] = []

    /// Reported rather than thrown, so a caller cannot make it fatal by
    /// accident.
    public private(set) var lastProblem: String?

    public init() {}

    public func start() {
        guard !started else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            // The gesture-to-audible-note budget is 30 ms target, 50 ms max.
            try? session.setPreferredIOBufferDuration(0.005)
        } catch {
            lastProblem = "audio session: \(error.localizedDescription)"
            // Carry on: the engine often runs anyway, and if it does not, the
            // failure is reported rather than fatal.
        }

        engine.attach(pitchSampler)
        engine.attach(durationSampler)

        if spatialise {
            engine.attach(environment)
            // 3D mixing requires mono inputs. Anything else throws.
            let mono = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)
            engine.connect(pitchSampler, to: environment, format: mono)
            engine.connect(durationSampler, to: environment, format: mono)
            engine.connect(environment, to: engine.mainMixerNode, format: nil)
        } else {
            engine.connect(pitchSampler, to: engine.mainMixerNode, format: nil)
            engine.connect(durationSampler, to: engine.mainMixerNode, format: nil)
        }

        do {
            try engine.start()
            started = true
        } catch {
            lastProblem = "audio engine: \(error.localizedDescription)"
        }
    }

    public func stop() {
        guard started else { return }
        allNotesOff()
        engine.stop()
        started = false
    }

    /// Place each ribbon's voice at its own position. A no-op unless
    /// `spatialise` was set before `start()`.
    public func position(left: SIMD3<Float>, right: SIMD3<Float>) {
        guard spatialise, started else { return }
        pitchSampler.position = AVAudio3DPoint(x: left.x, y: left.y, z: left.z)
        durationSampler.position = AVAudio3DPoint(x: right.x, y: right.y, z: right.z)
    }

    public func setProgram(_ program: UInt8) {
        guard started else { return }
        pitchSampler.sendProgramChange(program, onChannel: 0)
        durationSampler.sendProgramChange(program, onChannel: 0)
    }

    /// One notch pair engaging. `ticks` are at 480 to the quarter note; the
    /// tempo comes from the mesh and does not change for its life.
    public func play(pitch: UInt8?, ticks: UInt32, velocity: UInt8, tempoBPM: Int) {
        guard started, let pitch else { return }   // a silence sounds nothing
        let seconds = Double(ticks) / 480.0 * (60.0 / Double(max(tempoBPM, 1)))
        pitchSampler.startNote(pitch, withVelocity: velocity, onChannel: 0)
        active.append((pitch, CACurrentMediaTime() + seconds))
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.started else { return }
            self.pitchSampler.stopNote(pitch, onChannel: 0)
            self.active.removeAll {
                $0.note == pitch && $0.until <= CACurrentMediaTime()
            }
        }
    }

    /// Every voice off — used when the wave halts, so a held note does not
    /// hang through a silence M placed deliberately.
    public func allNotesOff() {
        guard started else { return }
        for (note, _) in active {
            pitchSampler.stopNote(note, onChannel: 0)
        }
        active.removeAll()
    }
}
