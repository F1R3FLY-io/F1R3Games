// RibbonScene.swift
//
// The immersive scene. Spec §12.
//
// Three defects from the previous implementation are fixed here.
//
// 1. AXIS. RibbonView placed both ribbons at a shared RIBBON_X and separated
//    them by LEFT_Y / RIGHT_Y — stacked vertically at the same left-right
//    position. Under M's axes they separate on x, left spool to the left hand.
//
// 2. HOT PATH. PatchEntity.configure called MeshResource.generateText and
//    built a fresh PhysicallyBasedMaterial for every patch on every update,
//    driven by a 60 Hz status flood. Text shaping and tessellation per frame
//    is the dominant cost in the render path. Meshes and materials are cached
//    here and reassigned only when a digit actually changes.
//
// 3. DEAD FEATURES. Hand ghosts, the mesh, the zip front and the capture
//    highlight all existed in the old source and were called from nowhere:
//    a tester saw two advancing ribbons and nothing else. They are wired.

import RealityKit
import simd
import UIKit

@MainActor
public final class RibbonScene {

    // Geometry, in M's axes: x right, y up, z away from her.
    //
    // RealityKit's forward is NEGATIVE z, so every z here is negated when a
    // position is written. Laying the surface out at positive z put the whole
    // thing BEHIND M's head — which looks exactly like nothing rendering, and
    // cost two rounds of debugging because the hand ghosts use raw ARKit
    // positions and never pass through this layout.
    //
    // IMPORTANT: in a visionOS ImmersiveSpace the world origin is at FLOOR
    // level, not at the head. Laying the ribbons out around y = 0 puts them at
    // M's feet, which looks exactly like them not rendering at all. The whole
    // scene is therefore lifted to `deckHeight`.
    private let ribbonX: Float = 0.32       // ribbons separate on x, not y
    private let nearZ: Float = 0.45
    private let farZ: Float = 1.60
    /// Height of the playing surface above the floor. Roughly chest height for
    /// a standing player; `setDeckHeight` adjusts it for a seated one.
    private var deckHeight: Float = 1.30
    private let patchDepth: Float = 0.035
    private let patchSize = SIMD3<Float>(0.05, 0.035, 0.010)

    /// The playing surface, lifted to `deckHeight`.
    public let root = Entity()
    /// Hand ghosts live OUTSIDE the lifted root: they carry absolute ARKit
    /// world positions, so any transform on the surface displaces them from
    /// M's actual hands. Added to the scene separately.
    public let ghostRoot = Entity()
    private let leftRibbon = Entity()
    private let rightRibbon = Entity()
    private let meshLine = Entity()
    private let frontMarker = Entity()
    private let captureHighlight = Entity()
    private let ghosts = HandGhosts()

    private var leftPatches: [ModelEntity] = []
    private var rightPatches: [ModelEntity] = []
    private var leftDigits: [UInt8] = []
    private var rightDigits: [UInt8] = []

    // Caches. Built once, indexed by value — never regenerated per frame.
    private var textMeshes: [UInt8: MeshResource] = [:]
    private var materials: [Int: PhysicallyBasedMaterial] = [:]
    private var boxMesh: MeshResource?

    public init() {
        root.addChild(leftRibbon)
        root.addChild(rightRibbon)
        root.addChild(meshLine)
        root.addChild(frontMarker)
        root.addChild(captureHighlight)
        ghostRoot.addChild(ghosts.root)
        boxMesh = .generateBox(size: patchSize, cornerRadius: 0.002)
        buildFrontMarker()
        buildOriginMarker()
        root.position = [0, deckHeight, 0]
    }

    /// Raise or lower the whole playing surface. Seated players want roughly
    /// 1.0 m; standing, roughly 1.3 m.
    public func setDeckHeight(_ y: Float) {
        deckHeight = max(0.3, min(2.2, y))
        root.position = [0, deckHeight, 0]
    }

    public var currentDeckHeight: Float { deckHeight }

    // MARK: - Caches

    private func textMesh(_ digit: UInt8) -> MeshResource {
        if let m = textMeshes[digit] { return m }
        let m = MeshResource.generateText(
            String(digit, radix: 36, uppercase: true),
            extrusionDepth: 0.001,
            font: .boldSystemFont(ofSize: 0.02))
        textMeshes[digit] = m
        return m
    }

    /// One material per (digit, depth bucket). Eight buckets is plenty for a
    /// depth fade and bounds the cache.
    private func material(digit: UInt8, base: UInt8, fade: Float) -> PhysicallyBasedMaterial {
        let bucket = Int((fade * 8).rounded())
        let key = Int(digit) << 8 | bucket
        if let m = materials[key] { return m }
        let hue = CGFloat(digit) / CGFloat(max(base, 1))
        let colour = UIColor(
            hue: hue, saturation: 0.82,
            brightness: 0.92 * CGFloat(1 - Float(bucket) / 8 * 0.7), alpha: 1)
        var m = PhysicallyBasedMaterial()
        m.baseColor = .init(tint: colour)
        m.roughness = .init(floatLiteral: 0.4)
        materials[key] = m
        return m
    }

    // MARK: - Ribbons

    /// Live counts for the debug overlay. Two rounds were lost to inferring
    /// why nothing drew; the scene now reports what it was given and what it
    /// built.
    public private(set) var lastLeftCount = 0
    public private(set) var lastRightCount = 0
    public var patchCount: Int { leftPatches.count + rightPatches.count }
    public var enabledPatchCount: Int {
        leftPatches.filter { $0.isEnabled }.count
            + rightPatches.filter { $0.isEnabled }.count
    }

    public func update(left: [UInt8], right: [UInt8], base: UInt8) {
        lastLeftCount = left.count
        lastRightCount = right.count
        sync(&leftPatches, &leftDigits, left, into: leftRibbon, x: -ribbonX, base: base)
        sync(&rightPatches, &rightDigits, right, into: rightRibbon, x: ribbonX, base: base)
    }

    private func sync(
        _ patches: inout [ModelEntity],
        _ cached: inout [UInt8],
        _ digits: [UInt8],
        into parent: Entity,
        x: Float,
        base: UInt8
    ) {
        while patches.count < digits.count {
            let e = ModelEntity(mesh: boxMesh!, materials: [SimpleMaterial()])
            let label = ModelEntity(mesh: textMesh(0), materials: [UnlitMaterial(color: .white)])
            label.position = [-0.008, -0.009, patchSize.z / 2 + 0.001]
            label.name = "label"
            e.addChild(label)
            parent.addChild(e)
            patches.append(e)
        }
        cached.reserveCapacity(digits.count)
        while cached.count < digits.count { cached.append(255) }

        for (i, digit) in digits.enumerated() {
            let p = patches[i]
            let z = nearZ + Float(i) * patchDepth
            let fade = Float(i) / Float(max(digits.count, 1))
            p.position = [x, 0, -z]          // RealityKit forward is -z
            let scale = 1.0 - fade * 0.5
            p.scale = [scale, scale, scale]
            p.isEnabled = true
            // Only touch meshes and materials when the value actually changed.
            if cached[i] != digit {
                cached[i] = digit
                p.model?.materials = [material(digit: digit, base: base, fade: fade)]
                if let label = p.children.first(where: { $0.name == "label" })
                    as? ModelEntity {
                    label.model?.mesh = textMesh(digit)
                }
            }
        }
        for i in digits.count..<patches.count { patches[i].isEnabled = false }
    }

    // MARK: - Mesh, front, capture

    /// The notches meshing. Rendered at the notch scale, between the ribbons.
    public func updateMesh(front: Int, visible: Int) {
        meshLine.children.forEach { $0.removeFromParent() }
        guard visible > 0 else { return }
        let thread = MeshResource.generateBox(
            size: [2 * ribbonX - 0.05, 0.002, 0.002])
        let mat = UnlitMaterial(color: .init(white: 0.85, alpha: 0.9))
        for i in 0..<visible {
            let e = ModelEntity(mesh: thread, materials: [mat])
            e.position = [0, 0, -(nearZ + Float(i) * patchDepth)]
            meshLine.addChild(e)
        }
    }

    /// Always visible, whatever the ribbons do. If this is in view and the
    /// ribbons are not, the surface is placed correctly and the fault is in the
    /// ribbon build; if this is missing too, the surface is elsewhere.
    private func buildOriginMarker() {
        let m = MeshResource.generateSphere(radius: 0.03)
        let e = ModelEntity(mesh: m, materials: [UnlitMaterial(color: .systemPink)])
        e.position = [0, 0, -nearZ]
        root.addChild(e)

        for (x, colour) in [(-ribbonX, UIColor.systemPurple), (ribbonX, UIColor.systemTeal)] {
            let rail = ModelEntity(
                mesh: .generateBox(size: [0.01, 0.01, farZ - nearZ]),
                materials: [UnlitMaterial(color: colour)])
            rail.position = [x, -0.03, -(nearZ + farZ) / 2]
            root.addChild(rail)
        }
    }

    private func buildFrontMarker() {
        let m = MeshResource.generateBox(size: [2 * ribbonX, 0.05, 0.006], cornerRadius: 0.002)
        let e = ModelEntity(mesh: m, materials: [UnlitMaterial(color: .systemOrange)])
        e.name = "front"
        frontMarker.addChild(e)
        // The front is the playhead M watches. It no longer needs to be
        // targetable — halt is a head gesture, so nothing aims at it.
        frontMarker.components.set(OpacityComponent(opacity: 0.9))
    }

    public func placeFront(at notch: Int, running: Bool, warning: Bool) {
        frontMarker.position = [0, 0, -(nearZ + Float(notch) * patchDepth)]
        // A head tilt is proprioceptively silent, so freezing must be
        // unmistakable or M will not trust it.
        let opacity: Float = running ? 0.9 : 0.35
        frontMarker.components.set(OpacityComponent(opacity: warning ? 1.0 : opacity))
    }

    /// A capture lifting clear of an intact band. Showing a gap or a severed
    /// end would misrepresent the mechanism: the cut is virtual.
    public func showCapture(near: Int, far: Int) {
        captureHighlight.children.forEach { $0.removeFromParent() }
        guard far > near else { return }
        let length = Float(far - near) * patchDepth
        let m = MeshResource.generateBox(
            size: [2 * ribbonX, 0.06, length], cornerRadius: 0.004)
        let e = ModelEntity(
            mesh: m, materials: [UnlitMaterial(color: .systemOrange.withAlphaComponent(0.35))])
        e.position = [0, 0, -(nearZ + Float(near) * patchDepth + length / 2)]
        captureHighlight.addChild(e)
        // Lift the copy clear; the band stays where it is.
        var t = e.transform
        t.translation.y += 0.22
        e.move(to: t, relativeTo: captureHighlight, duration: 0.45)
    }

    /// Far-field compression, so a long play visibly costs z-axis real estate.
    public func compress(budgetUsed: Float) {
        let squeeze = 1.0 - min(max(budgetUsed, 0), 1.0) * 0.55
        // Depth only. Scaling x or y would move the surface away from the
        // height set above.
        root.scale = [1, 1, squeeze]
        root.position = [0, deckHeight, 0]
    }

    public func updateGhosts(left: SkeinHand?, right: SkeinHand?) {
        ghosts.update(left: left, right: right)
    }

    public var frontWorldPositions: (SIMD3<Float>, SIMD3<Float>) {
        ([-ribbonX, deckHeight, -nearZ], [ribbonX, deckHeight, -nearZ])
    }
}

/// Wireframe hands. In the previous implementation the entity was added to the
/// scene and never updated — the recogniser received every anchor and threw it
/// away — so the ghosts never appeared at all.
@MainActor
final class HandGhosts {
    let root = Entity()
    private var joints: [String: ModelEntity] = [:]
    private lazy var dot = MeshResource.generateSphere(radius: 0.006)
    private lazy var mat = UnlitMaterial(color: .init(white: 0.9, alpha: 0.65))

    func update(left: SkeinHand?, right: SkeinHand?) {
        apply(left, prefix: "L")
        apply(right, prefix: "R")
    }

    private func apply(_ hand: SkeinHand?, prefix: String) {
        guard let hand else { return }
        let points: [(String, SkeinVec3)] = [
            ("wrist", hand.wrist),
            ("i0", hand.index.knuckle), ("i1", hand.index.pip),
            ("i2", hand.index.dip), ("i3", hand.index.tip),
            ("m0", hand.middle.knuckle), ("m1", hand.middle.pip),
            ("m2", hand.middle.dip), ("m3", hand.middle.tip),
            ("r0", hand.ring.knuckle), ("r3", hand.ring.tip),
            ("l0", hand.little.knuckle), ("l3", hand.little.tip),
        ]
        for (name, p) in points {
            let key = prefix + name
            let e = joints[key] ?? {
                let n = ModelEntity(mesh: dot, materials: [mat])
                joints[key] = n
                root.addChild(n)
                return n
            }()
            // Samples arrive in the spec's axes (z away from M); RealityKit's
            // forward is -z, so convert back for rendering.
            e.position = [p.x, p.y, -p.z]
        }
    }
}
