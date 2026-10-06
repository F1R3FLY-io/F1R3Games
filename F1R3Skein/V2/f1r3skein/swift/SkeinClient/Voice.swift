// Voice.swift
//
// Timbre. Spec §13 treats sound as interpretation rather than material, so a
// voice change never touches a captured tune or affects breeding — the same
// reasoning that keeps the pitch map out of the term.
//
// The five starting voices span the axis that matters for this instrument:
// whether the ear follows pitch or duration. Kalimba and piano are struck, so
// note length becomes spacing rather than something heard; cello and organ
// sustain, so the duration ribbon is audible as duration. Glass harmonica
// sustains but reads as bell-like, sitting between the two.

import Foundation

public enum Voice: String, CaseIterable, Identifiable, Codable {
    case cello
    case kalimba
    case piano
    case organ
    case glassHarmonica

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .cello: return "Cello"
        case .kalimba: return "Kalimba"
        case .piano: return "Piano"
        case .organ: return "Organ"
        case .glassHarmonica: return "Glass harmonica"
        }
    }

    /// General MIDI program number, zero-indexed.
    ///
    /// Glass harmonica is not in General MIDI at all; Crystal (98) is the usual
    /// stand-in and is not really the thing. It is the one voice here where
    /// synthesis would clearly beat sampling — close to a sine with a slow
    /// swell and a long, slightly inharmonic tail — and is worth doing properly
    /// later.
    public var program: UInt8 {
        switch self {
        case .piano: return 0            // Acoustic Grand Piano
        case .organ: return 19           // Church Organ
        case .cello: return 42           // Cello
        case .kalimba: return 108        // Kalimba
        case .glassHarmonica: return 98  // Crystal — a substitute, not a match
        }
    }

    /// Struck voices decay regardless of note length, so the duration ribbon
    /// stops being audible as duration. Recorded here because it is a real
    /// property of the choice, not a detail of the preset.
    public var isStruck: Bool {
        switch self {
        case .piano, .kalimba: return true
        case .cello, .organ, .glassHarmonica: return false
        }
    }

    public var note: String {
        isStruck
            ? "struck — the ear follows pitch"
            : "sustained — the ear follows duration"
    }
}
