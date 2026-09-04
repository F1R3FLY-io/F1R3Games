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

    var body: some Scene {
        WindowGroup(id: "panel") {
            ControlPanel(immersive: $immersive)
                .environment(model)
                .task { model.start() }
        }
        .defaultSize(width: 560, height: 620)

        ImmersiveSpace(id: "ribbons") {
            ImmersiveView()
                .environment(model)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}
