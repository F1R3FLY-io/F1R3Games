// SoundPanel.swift
//
// The sound panel: a second window, so instrument controls do not crowd the
// playing controls.
//
// Timbre is interpretation rather than material (spec §7.4), so nothing here
// changes a captured tune or affects breeding. Changing voice mid-performance
// is safe and immediate.

import SwiftUI

struct SoundPanel: View {

    @Environment(SkeinModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var scrolled: Voice?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            // Dismiss sits at the TOP. Gaze tracking is least reliable at the
            // bottom of a panel, and a close button is one M will reach for
            // often.
            HStack {
                Text("Sound").font(.headline)
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Label("Close", systemImage: "xmark")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
            }

            wheel

            Divider()

            HStack(spacing: 12) {
                Toggle("Delay", isOn: Binding(
                    get: { model.delayOn },
                    set: { model.setDelay($0) }))
                    .toggleStyle(.button)
                Toggle("Reverb", isOn: Binding(
                    get: { model.reverbOn },
                    set: { model.setReverb($0) }))
                    .toggleStyle(.button)
                Spacer()
            }
            // The delay is a dotted eighth at the mesh tempo, so the repeats
            // reinforce the pulse rather than blurring across it.
            if model.delayOn && model.zip.tempo > 0 {
                Text("delay locked to \(model.zip.tempo) bpm")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            if let p = model.audioProblem, !model.audioRunning {
                Label(p, systemImage: "speaker.slash")
                    .font(.caption2).foregroundStyle(.orange)
            }

            Spacer(minLength: 0)
        }
        .padding(24)
    }

    /// Native menus rather than a custom wheel. The system menu is grabbable
    /// and scrollable, and behaves the way every other control in visionOS
    /// does — which matters more for an unfamiliar instrument than a bespoke
    /// affordance does.
    private var wheel: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Picker("Timbre", selection: Binding(
                    get: { model.voice },
                    set: { model.setVoice($0) })) {
                    ForEach(Voice.allCases) { v in
                        Text(v.displayName).tag(v)
                    }
                }
                .pickerStyle(.menu)

                // Struck or sustained decides whether the duration ribbon is
                // audible as duration at all.
                Text(model.voice.note)
                    .font(.caption2).foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 4) {
                Picker("Scale", selection: Binding(
                    get: { model.scale },
                    set: { model.setScale($0) })) {
                    ForEach(Scale.allCases) { s in
                        Text(s.displayName).tag(s)
                    }
                }
                .pickerStyle(.menu)
                .disabled(!model.canChangeScale)

                Text(model.canChangeScale
                     ? model.scale.note
                     : "unzip to change the scale")
                    .font(.caption2)
                    .foregroundStyle(model.canChangeScale ? .secondary : .orange)
                Text("three octaves plus a rest — base \(model.scale.base)")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}
