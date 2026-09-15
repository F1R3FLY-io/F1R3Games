// ImmersiveView.swift
//
// The immersive space. Thin by design: RibbonScene owns the entities, and the
// model drives it from engine messages, so nothing here re-derives state.
//
// Hand tracking is started here rather than at launch, because ARKit providers
// only deliver anchors while an immersive space is open.

import RealityKit
import SwiftUI
import simd

struct ImmersiveView: View {

    @Environment(SkeinModel.self) private var model
    @State private var scene = RibbonScene()

    var body: some View {
        RealityView { content in
            content.add(scene.root)
            // Separately, and untransformed: ghosts carry absolute world
            // positions and must not inherit the surface's height offset.
            content.add(scene.ghostRoot)
            model.scene = scene
            // Each ribbon sounds from its own position, so the two streams are
            // audibly distinct as well as visually distinct.
            let (l, r) = scene.frontWorldPositions
            model.positionAudio(left: l, right: r)
        }
        .task {
            await model.startTracking()
        }
        .onDisappear {
            model.scene = nil
        }
    }
}
