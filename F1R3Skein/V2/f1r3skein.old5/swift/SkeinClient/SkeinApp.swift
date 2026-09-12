// SkeinApp.swift
//
// Application entry point.
//
// A plain window for the panel and one mixed immersive space for the ribbons.
// The panel is not decorative: the spec requires an equivalent for every
// gesture, because halt is a head gesture and snip needs both hands, and
// neither is available to everyone.

import SwiftUI

@main
struct SkeinApp: App {

    @State private var model = SkeinModel()
    @State private var immersive = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup(id: "panel") {
            ControlPanel(immersive: $immersive)
                .environment(model)
                .task { model.start() }
                .onChange(of: scenePhase) { _, phase in
                    // Leaving via the Digital Crown backgrounds the scene
                    // rather than calling stop(), which would otherwise leave
                    // the performance trace without an end timestamp.
                    if phase == .background { model.stop() }
                }
        }
        .defaultSize(width: 560, height: 620)

        ImmersiveSpace(id: "ribbons") {
            ImmersiveView()
                .environment(model)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}
