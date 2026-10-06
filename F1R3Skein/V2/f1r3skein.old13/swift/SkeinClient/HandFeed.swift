// HandFeed.swift
//
// ARKit sampling. Spec §6.11.
//
// The client's whole job on the input side is to sample and forward. Detection
// lives in the Rust core, which is what makes the thresholds testable against
// recorded traces — and the reason that matters is that every threshold is
// currently a guess and one of them, the finger-curl metric, was provably
// unreachable: it divided a tip-to-metacarpal distance by a fixed 0.08 m, so a
// fully curled adult ring finger scored 0.75–1.0 against a ceiling of 0.30 and
// the scissors gesture could never fire.

import ARKit
import Foundation
import simd
import QuartzCore

public final class HandFeed {

    private let session = ARKitSession()
    private let hands = HandTrackingProvider()
    private let world = WorldTrackingProvider()

    private var latestLeft: SkeinHand?
    private var latestRight: SkeinHand?
    private var latestHead: SkeinHead?

    public var onFrame: ((SkeinFrame) -> Void)?
    /// Raw joint transforms, for the corpus the thresholds will be tuned
    /// against. Spec §14 makes this non-deferrable despite looking otherwise.
    public var onRawSample: ((Data) -> Void)?

    public private(set) var authorized = false
    public var onAuthorizationDenied: ((String) -> Void)?
    /// Status notes for the panel — provider state, mostly.
    public var onNote: ((String) -> Void)?

    public init() {}

    public func start() async {
        guard HandTrackingProvider.isSupported else {
            onAuthorizationDenied?("Hand tracking is not supported on this device.")
            return
        }
        // Request ONLY what actually needs authorizing. WorldTrackingProvider,
        // used here for head pose, requires none — and asking for an
        // authorization whose Info.plist usage string is absent throws
        // NSInternalInconsistencyException, which is fatal and uncatchable
        // rather than a refusal. Keep this list and the plist keys in step.
        //
        // Requested explicitly and handled visibly: the previous client called
        // run() directly and reported denial to the console, so a refused
        // permission looked like a broken app.
        let result = await session.requestAuthorization(for: [.handTracking])
        for (_, status) in result where status != .allowed {
            onAuthorizationDenied?(
                "Hand tracking permission is required. Grant it in Settings and relaunch.")
            return
        }
        do {
            try await session.run([hands, world])
            authorized = true
        } catch {
            onAuthorizationDenied?("Could not start tracking: \(error.localizedDescription)")
            return
        }

        Task { await self.pumpHands() }
        Task { await self.pumpHead() }
    }

    private func pumpHands() async {
        for await update in hands.anchorUpdates {
            let a = update.anchor
            guard a.isTracked, let skel = a.handSkeleton else { continue }
            let sample = Self.sample(anchor: a, skeleton: skel)
            switch a.chirality {
            case .left: latestLeft = sample
            case .right: latestRight = sample
            @unknown default: break
            }
            emit(t: sample.t)
        }
    }

    /// Head pose, for halt. This is the one transport control M needs while
    /// both hands are committed to holding ribbons, and head pose is available
    /// to applications where gaze is not.
    ///
    /// The provider's state MUST be checked before every query. Querying a
    /// provider that is not running logs
    /// "device_anchor can only be queried when the world tracking provider is
    /// running" on each iteration — at 90 Hz that buries every other message in
    /// the console, and head roll silently never arrives.
    private func pumpHead() async {
        var warned = false
        while !Task.isCancelled {
            guard world.state == .running else {
                if !warned {
                    warned = true
                    onNote?("waiting for world tracking (head roll unavailable)")
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
                continue
            }
            if warned {
                warned = false
                onNote?("world tracking running")
            }
            let now = CACurrentMediaTime()
            if let device = world.queryDeviceAnchor(atTimestamp: now) {
                let m = device.originFromAnchorTransform
                // Roll about the device's forward axis: the angle of the head's
                // up vector away from world up.
                let up = SIMD3<Float>(m.columns.1.x, m.columns.1.y, m.columns.1.z)
                let right = SIMD3<Float>(m.columns.0.x, m.columns.0.y, m.columns.0.z)
                let roll = atan2(simd_dot(right, SIMD3<Float>(0, 1, 0)),
                                 simd_dot(up, SIMD3<Float>(0, 1, 0)))
                latestHead = SkeinHead(t: now, roll: roll)
            }
            try? await Task.sleep(nanoseconds: 11_000_000)  // ~90 Hz
        }
    }

    private func emit(t: Double) {
        let frame = SkeinFrame(t: t, left: latestLeft, right: latestRight, head: latestHead)
        onFrame?(frame)
        if let data = try? JSONEncoder().encode(frame) {
            onRawSample?(data)
        }
    }

    // MARK: - Conversion

    /// ARKit position to the specification's axes.
    ///
    /// The spec has z as depth **away** from M; ARKit's forward is negative z.
    /// The conversion happens here, once, so the Rust core receives exactly the
    /// axes it was written and tested against. Two detectors depend on the
    /// sign: a pull is motion toward M, and the near hand in a snip is the one
    /// at lower z. Both would be inverted without this.
    private static func v(_ t: simd_float4x4) -> SkeinVec3 {
        SkeinVec3(t.columns.3.x, t.columns.3.y, -t.columns.3.z)
    }

    private static func finger(
        _ skel: HandSkeleton,
        _ knuckle: HandSkeleton.JointName,
        _ pip: HandSkeleton.JointName,
        _ dip: HandSkeleton.JointName,
        _ tip: HandSkeleton.JointName,
        _ origin: simd_float4x4
    ) -> SkeinFinger {
        SkeinFinger(
            knuckle: v(origin * skel.joint(knuckle).anchorFromJointTransform),
            pip: v(origin * skel.joint(pip).anchorFromJointTransform),
            dip: v(origin * skel.joint(dip).anchorFromJointTransform),
            tip: v(origin * skel.joint(tip).anchorFromJointTransform))
    }

    private static func sample(anchor: HandAnchor, skeleton: HandSkeleton) -> SkeinHand {
        let o = anchor.originFromAnchorTransform
        return SkeinHand(
            chirality: anchor.chirality == .left ? "left" : "right",
            t: CACurrentMediaTime(),
            wrist: v(o * skeleton.joint(.wrist).anchorFromJointTransform),
            index: finger(skeleton, .indexFingerKnuckle, .indexFingerIntermediateBase,
                          .indexFingerIntermediateTip, .indexFingerTip, o),
            middle: finger(skeleton, .middleFingerKnuckle, .middleFingerIntermediateBase,
                           .middleFingerIntermediateTip, .middleFingerTip, o),
            ring: finger(skeleton, .ringFingerKnuckle, .ringFingerIntermediateBase,
                         .ringFingerIntermediateTip, .ringFingerTip, o),
            little: finger(skeleton, .littleFingerKnuckle, .littleFingerIntermediateBase,
                           .littleFingerIntermediateTip, .littleFingerTip, o))
    }
}
