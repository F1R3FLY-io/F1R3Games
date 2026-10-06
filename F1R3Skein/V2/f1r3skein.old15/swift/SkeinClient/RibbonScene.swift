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

    // Geometry.
    //
    // The near end of each ribbon is NOT calculated: it is read from hand
    // tracking. A ribbon runs from M's hand out to its spool, so the end she
    // holds is wherever her hand is — and when the ribbons are mounted, from
    // the clips instead. Only the far end needs choosing.
    //
    // This removes the height calibration entirely. The surface follows M
    // rather than sitting at a guessed deck height, which is both more correct
    // and one fewer thing to get wrong.
    //
    // Positions are in world space. Samples arrive in the spec's axes (x
    // right, y up, z away from M); RealityKit's forward is -z, so a z is
    // negated whenever one is written.

    /// How far the spools sit beyond the hands, metres.
    private let spoolDistance: Float = 1.40
    /// Half the separation between the two spools on x.
    private let spoolSpread: Float = 0.34
    /// How far above the hands the spools ride.
    private let spoolRise: Float = 0.18
    /// Patches drawn per ribbon.
    private let patchCountMax = 60
    private let patchSize = SIMD3<Float>(0.05, 0.035, 0.010)

    /// Where M's hands are, in world space. The near anchors.
    private var leftAnchor: SIMD3<Float>?
    private var rightAnchor: SIMD3<Float>?
    /// The clips, used as near anchors once mounted.
    private var mountLeft: SIMD3<Float>?
    private var mountRight: SIMD3<Float>?
    private var mounted = false

    /// Spool positions, captured once so they do not jitter with the hands,
    /// and recapturable on demand.
    private var spoolLeft: SIMD3<Float>?
    private var spoolRight: SIMD3<Float>?

    // MARK: - Entities

    /// The playing surface, in world space. No transform is applied to it: the
    /// geometry is absolute, because the near end is a tracked hand.
    public let root = Entity()
    /// Hand ghosts live outside `root` for the same reason they always did —
    /// they carry absolute ARKit positions and must inherit no transform.
    public let ghostRoot = Entity()

    private let leftRibbon = Entity()
    private let rightRibbon = Entity()
    private let meshLine = Entity()
    private let frontMarker = Entity()
    private let captureHighlight = Entity()
    private let spoolMarkers = Entity()
    private let mountMarkers = Entity()
    private let ghosts = HandGhosts()

    private var leftPatches: [ModelEntity] = []
    private var rightPatches: [ModelEntity] = []
    private var leftDigits: [UInt8] = []
    private var rightDigits: [UInt8] = []

    // Caches, indexed by value. Never regenerated per frame.
    private var textMeshes: [UInt8: MeshResource] = [:]
    private var materials: [Int: PhysicallyBasedMaterial] = [:]
    private var boxMesh: MeshResource?

    public init() {
        root.addChild(leftRibbon)
        root.addChild(rightRibbon)
        root.addChild(meshLine)
        root.addChild(frontMarker)
        root.addChild(captureHighlight)
        root.addChild(spoolMarkers)
        root.addChild(mountMarkers)
        ghostRoot.addChild(ghosts.root)
        boxMesh = .generateBox(size: patchSize, cornerRadius: 0.002)
        buildFrontMarker()
        buildSpoolMarkers()
    }

    /// Near anchors, straight from hand tracking. Called every frame.
    ///
    /// `mounted` switches the near end from the hands to the clips: that is the
    /// whole of the play/meta distinction as far as the geometry is concerned.
    public func setAnchors(
        left: SIMD3<Float>?, right: SIMD3<Float>?, mounted: Bool
    ) {
        if let l = left { leftAnchor = l }
        if let r = right { rightAnchor = r }
        self.mounted = mounted
        captureSpoolsIfNeeded()
        placeMountMarkers()
    }

    /// Fix the spools the first time both hands are seen. They are the far end
    /// and must stay put; only the near end follows M.
    private func captureSpoolsIfNeeded() {
        guard spoolLeft == nil || spoolRight == nil,
              let l = leftAnchor, let r = rightAnchor else { return }
        let mid = (l + r) / 2
        spoolLeft = SIMD3(mid.x - spoolSpread, mid.y + spoolRise, mid.z - spoolDistance)
        spoolRight = SIMD3(mid.x + spoolSpread, mid.y + spoolRise, mid.z - spoolDistance)
        placeSpoolMarkers()
    }

    /// Put the spools back in front of M, wherever she is now.
    public func recentre() {
        spoolLeft = nil
        spoolRight = nil
        captureSpoolsIfNeeded()
    }

    /// The clips sit between the ribbons, just in front of the hands.
    private func placeMountMarkers() {
        guard let l = leftAnchor, let r = rightAnchor else { return }
        let mid = (l + r) / 2
        let toward = SIMD3<Float>(0, 0, -0.18)
        mountLeft = SIMD3(mid.x - 0.05, mid.y, mid.z) + toward
        mountRight = SIMD3(mid.x + 0.05, mid.y, mid.z) + toward
        if mountMarkers.children.isEmpty { buildMountMarkers() }
        if let a = mountLeft, let b = mountRight, mountMarkers.children.count >= 2 {
            mountMarkers.children[0].position = a
            mountMarkers.children[1].position = b
        }
        mountMarkers.isEnabled = true
    }

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
        let nearL = mounted ? mountLeft : leftAnchor
        let nearR = mounted ? mountRight : rightAnchor
        sync(&leftPatches, &leftDigits, left, into: leftRibbon,
             near: nearL, spool: spoolLeft, base: base)
        sync(&rightPatches, &rightDigits, right, into: rightRibbon,
             near: nearR, spool: spoolRight, base: base)
    }

    private func sync(
        _ patches: inout [ModelEntity],
        _ cached: inout [UInt8],
        _ digits: [UInt8],
        into parent: Entity,
        near: SIMD3<Float>?,
        spool: SIMD3<Float>?,
        base: UInt8
    ) {
        guard let near, let spool, !digits.isEmpty else {
            patches.forEach { $0.isEnabled = false }
            return
        }

        while patches.count < digits.count {
            let e = ModelEntity(mesh: boxMesh!, materials: [SimpleMaterial()])
            let label = ModelEntity(mesh: textMesh(0), materials: [UnlitMaterial(color: .white)])
            label.position = [-0.008, -0.009, patchSize.z / 2 + 0.001]
            label.name = "label"
            e.addChild(label)
            parent.addChild(e)
            patches.append(e)
        }
        while cached.count < digits.count { cached.append(255) }

        // The near end is M's hand (or a clip); the far end is the spool.
        // The spool holds the future, so digit 0 — the next one to be
        // consumed — sits at her hand and the rest run away toward the spool,
        // still wound and not yet played.
        let n = digits.count
        for (i, digit) in digits.enumerated() {
            let t = n > 1 ? Float(i) / Float(n - 1) : 0
            let p = near + (spool - near) * t
            let e = patches[i]
            e.position = p
            let scale = 1.0 - t * 0.45
            e.scale = [scale, scale, scale]
            e.isEnabled = true
            // Face M, wherever the ribbon happens to run.
            e.look(at: near + (near - spool), from: p, relativeTo: nil)
            if cached[i] != digit {
                cached[i] = digit
                e.model?.materials = [material(digit: digit, base: base, fade: t)]
                if let label = e.children.first(where: { $0.name == "label" })
                    as? ModelEntity {
                    label.model?.mesh = textMesh(digit)
                }
            }
        }
        for i in digits.count..<patches.count { patches[i].isEnabled = false }
    }

    // MARK: - Mesh, front, capture

    /// The notches meshing. Rendered at the notch scale, between the ribbons.
    /// The notches meshing: one thread per committed notch pair, drawn between
    /// the two ribbons wherever they happen to run.
    public func updateMesh(front: Int, visible: Int) {
        meshLine.children.forEach { $0.removeFromParent() }
        guard visible > 0,
              let nl = mounted ? mountLeft : leftAnchor,
              let nr = mounted ? mountRight : rightAnchor,
              let sl = spoolLeft, let sr = spoolRight else { return }
        let mat = UnlitMaterial(color: .init(white: 0.85, alpha: 0.9))
        let count = min(visible, patchCountMax)
        for i in 0..<count {
            let t = count > 1 ? Float(i) / Float(count - 1) : 0
            let a = nl + (sl - nl) * t
            let b = nr + (sr - nr) * t
            let mid = (a + b) / 2
            let span = simd_length(b - a)
            let e = ModelEntity(
                mesh: .generateBox(size: [max(span - 0.05, 0.01), 0.002, 0.002]),
                materials: [mat])
            e.position = mid
            e.look(at: b, from: mid, relativeTo: nil)
            meshLine.addChild(e)
        }
    }

    /// Spools: the far end of each ribbon, and the only part of the layout
    /// that is chosen rather than tracked.
    private func buildSpoolMarkers() {
        for colour in [UIColor.systemPurple, UIColor.systemTeal] {
            let e = ModelEntity(
                mesh: .generateCylinder(height: 0.14, radius: 0.075),
                materials: [UnlitMaterial(color: colour.withAlphaComponent(0.85))])
            e.orientation = simd_quatf(angle: .pi / 2, axis: [0, 0, 1])
            spoolMarkers.addChild(e)
        }
        spoolMarkers.isEnabled = false
    }

    private func placeSpoolMarkers() {
        guard let l = spoolLeft, let r = spoolRight,
              spoolMarkers.children.count >= 2 else { return }
        spoolMarkers.children[0].position = l
        spoolMarkers.children[1].position = r
        spoolMarkers.isEnabled = true
    }

    /// The two clips, drawn always so M can see where to mount.
    private func buildMountMarkers() {
        for _ in 0..<2 {
            let e = ModelEntity(
                mesh: .generateBox(size: [0.02, 0.05, 0.02], cornerRadius: 0.004),
                materials: [UnlitMaterial(color: .systemOrange)])
            mountMarkers.addChild(e)
        }
    }

    private func buildFrontMarker() {
        let m = MeshResource.generateBox(size: [0.72, 0.05, 0.006], cornerRadius: 0.002)
        let e = ModelEntity(mesh: m, materials: [UnlitMaterial(color: .systemOrange)])
        e.name = "front"
        frontMarker.addChild(e)
        frontMarker.isEnabled = false
    }

    /// The zip front rides between the two ribbons at the notch it has reached.
    public func placeFront(at notch: Int, running: Bool, warning: Bool) {
        guard let nl = mounted ? mountLeft : leftAnchor,
              let nr = mounted ? mountRight : rightAnchor,
              let sl = spoolLeft, let sr = spoolRight else {
            frontMarker.isEnabled = false
            return
        }
        let near = (nl + nr) / 2
        let spool = (sl + sr) / 2
        let t = min(Float(notch) / Float(patchCountMax), 1)
        frontMarker.position = near + (spool - near) * t
        frontMarker.look(at: near + (near - spool), from: frontMarker.position,
                         relativeTo: nil)
        frontMarker.isEnabled = true
        // A head tilt is proprioceptively silent, so freezing must be
        // unmistakable or M will not trust it.
        let opacity: Float = running ? 0.95 : 0.3
        frontMarker.components.set(OpacityComponent(opacity: warning ? 1.0 : opacity))
    }

    /// A capture lifting clear of an intact band. Showing a gap or a severed
    /// end would misrepresent the mechanism: the cut is virtual.
    public func showCapture(near nearNotch: Int, far farNotch: Int) {
        captureHighlight.children.forEach { $0.removeFromParent() }
        guard farNotch > nearNotch,
              let nl = mounted ? mountLeft : leftAnchor,
              let nr = mounted ? mountRight : rightAnchor,
              let sl = spoolLeft, let sr = spoolRight else { return }
        let near = (nl + nr) / 2
        let spool = (sl + sr) / 2
        let t0 = min(Float(nearNotch) / Float(patchCountMax), 1)
        let t1 = min(Float(farNotch) / Float(patchCountMax), 1)
        let a = near + (spool - near) * t0
        let b = near + (spool - near) * t1
        let mid = (a + b) / 2
        let length = simd_length(b - a)
        let e = ModelEntity(
            mesh: .generateBox(size: [0.72, 0.06, max(length, 0.02)], cornerRadius: 0.004),
            materials: [UnlitMaterial(color: .systemOrange.withAlphaComponent(0.35))])
        e.position = mid
        e.look(at: near + (near - spool), from: mid, relativeTo: nil)
        captureHighlight.addChild(e)
        var tr = e.transform
        tr.translation.y += 0.22
        e.move(to: tr, relativeTo: captureHighlight, duration: 0.45)
    }

    /// Far-field compression, so a long play visibly costs depth. The spools
    /// draw toward M rather than the surface being scaled, which would drag the
    /// near end away from her hands.
    public func compress(budgetUsed: Float) {
        guard let nl = leftAnchor, let nr = rightAnchor else { return }
        let pull = min(max(budgetUsed, 0), 1) * 0.45
        let mid = (nl + nr) / 2
        let d = spoolDistance * (1 - pull)
        spoolLeft = SIMD3(mid.x - spoolSpread, mid.y + spoolRise, mid.z - d)
        spoolRight = SIMD3(mid.x + spoolSpread, mid.y + spoolRise, mid.z - d)
        placeSpoolMarkers()
    }

    public func updateGhosts(left: SkeinHand?, right: SkeinHand?) {
        ghosts.update(left: left, right: right)
    }

    /// Where each ribbon's voice should sound from, for spatialised audio.
    public var frontWorldPositions: (SIMD3<Float>, SIMD3<Float>) {
        (leftAnchor ?? [-0.2, 1.2, -0.4], rightAnchor ?? [0.2, 1.2, -0.4])
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
