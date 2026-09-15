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
    @State private var scrolled: Voice?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Sound").font(.headline)

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

    /// A vertical wheel rather than a menu: choosing a voice is a performing
    /// act, and spinning past them is how a musician auditions.
    private var wheel: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 4) {
                    ForEach(Voice.allCases) { v in
                        Text(v.displayName)
                            .font(model.voice == v ? .title3.bold() : .title3)
                            .foregroundStyle(model.voice == v ? .primary : .tertiary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                            .padding(.horizontal, 14)
                            .background(
                                model.voice == v
                                    ? AnyShapeStyle(.thinMaterial)
                                    : AnyShapeStyle(.clear),
                                in: RoundedRectangle(cornerRadius: 10))
                            .contentShape(RoundedRectangle(cornerRadius: 10))
                            .onTapGesture { model.setVoice(v) }
                            .id(v)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $scrolled)
            .frame(height: 210)
            .onChange(of: scrolled) { _, v in
                // Selection follows the wheel, so each voice sounds as M
                // passes it rather than needing a separate commit.
                if let v, v != model.voice { model.setVoice(v) }
            }

            Text(model.voice.note)
                .font(.caption2).foregroundStyle(.secondary)
        }
    }
}
