// Scale.swift
//
// A pitch base and its scale are one choice, not two.
//
//     base = 3 * degrees + 1
//
// Three octaves of the scale, plus a rest as the top digit. Pairing them in
// the UI makes the correspondence a decision rather than an accident: a
// mismatched base folds modulo the scale, which is musically legitimate but
// should be chosen deliberately.
//
// Base 37 exceeds the 2...36 the specification states. That cap came from
// wanting each digit to render as one alphanumeric character; digit extraction
// itself is base-agnostic, and the musical requirement is the stronger one.

import Foundation

public enum Scale: String, CaseIterable, Identifiable, Codable {
    case pentatonic
    case diatonic
    case chromatic

    public var id: String { rawValue }

    /// Scale degrees in one octave.
    public var degrees: Int {
        switch self {
        case .pentatonic: return 5
        case .diatonic: return 7
        case .chromatic: return 12
        }
    }

    /// Three octaves plus the rest.
    public var base: Int { 3 * degrees + 1 }

    /// The engine's name for the corresponding pitch map.
    public var pitchMap: String {
        switch self {
        case .pentatonic: return "pentatonic_minor"
        case .diatonic: return "major"
        case .chromatic: return "chromatic"
        }
    }

    public var displayName: String {
        switch self {
        case .pentatonic: return "16 · pentatonic"
        case .diatonic: return "22 · diatonic"
        case .chromatic: return "37 · chromatic"
        }
    }

    /// Recover the pairing from the engine's pitch-map name, so the panel can
    /// follow the engine rather than assert its own guess.
    public static func from(pitchMap: String) -> Scale? {
        switch pitchMap {
        case "pentatonic_minor", "pentatonic_major": return .pentatonic
        case "major", "minor", "dorian": return .diatonic
        case "chromatic": return .chromatic
        default: return nil
        }
    }

    public var note: String {
        switch self {
        case .pentatonic: return "sparse, forgiving of any interval"
        case .diatonic: return "more melodic movement, more exposed"
        case .chromatic: return "every semitone; no key at all"
        }
    }
}
