// SkeinMessages.swift
//
// Protocol v4, Codable both ways. Spec §9.
//
// The client resolves no gestures of its own except the panel equivalents:
// detection lives in the Rust core so that S1 and S2 share one implementation
// and the detectors stay unit-testable. This file therefore mostly carries
// samples out and state in.

import Foundation

public let skeinProtocolVersion = 4

// MARK: - Samples

public struct SkeinVec3: Codable, Equatable {
    public var x: Float, y: Float, z: Float
    public init(_ x: Float, _ y: Float, _ z: Float) { self.x = x; self.y = y; self.z = z }
}

public struct SkeinFinger: Codable, Equatable {
    public var knuckle: SkeinVec3
    public var pip: SkeinVec3
    public var dip: SkeinVec3
    public var tip: SkeinVec3
}

public struct SkeinHand: Codable, Equatable {
    public var chirality: String   // "left" | "right"
    public var t: Double
    public var wrist: SkeinVec3
    public var index: SkeinFinger
    public var middle: SkeinFinger
    public var ring: SkeinFinger
    public var little: SkeinFinger
}

public struct SkeinHead: Codable, Equatable {
    public var t: Double
    /// Roll only. Yaw is in constant use as M looks between tray, spools and
    /// front; pitch is what people do to keep time.
    public var roll: Float
}

public struct SkeinFrame: Codable, Equatable {
    public var t: Double
    public var left: SkeinHand?
    public var right: SkeinHand?
    public var head: SkeinHead?
}

// MARK: - Client to engine

public enum ClientMessage: Encodable {
    case frame(SkeinFrame)
    case gesture(name: String, on: Bool?)
    case configure(pitchMap: String?, durationMap: String?, root: UInt8?, instrument: UInt8?)
    case rename(id: UInt64, name: String)
    case quit

    enum CodingKeys: String, CodingKey {
        case type, v, frame, gesture, on
        case pitch_map, duration_map, root, instrument
        case id, name
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(skeinProtocolVersion, forKey: .v)
        switch self {
        case .frame(let f):
            try c.encode("frame", forKey: .type)
            try c.encode(f, forKey: .frame)
        case .gesture(let name, let on):
            try c.encode("gesture", forKey: .type)
            var g: [String: AnyEncodableValue] = ["gesture": .string(name)]
            if let on { g["on"] = .bool(on) }
            try c.encode(g, forKey: .gesture)
        case .configure(let pm, let dm, let root, let inst):
            try c.encode("configure", forKey: .type)
            try c.encodeIfPresent(pm, forKey: .pitch_map)
            try c.encodeIfPresent(dm, forKey: .duration_map)
            try c.encodeIfPresent(root, forKey: .root)
            try c.encodeIfPresent(inst, forKey: .instrument)
        case .rename(let id, let name):
            try c.encode("rename", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
        case .quit:
            try c.encode("quit", forKey: .type)
        }
    }
}

public enum AnyEncodableValue: Encodable {
    case string(String), bool(Bool), int(Int)
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        }
    }
}

// MARK: - Engine to client

public struct ZipState: Equatable {
    public var zipped = false
    public var front = 0
    public var running = false
    public var tempo = 0
    public var budgetLeft = 0
    /// "halt" | "mount" | "exhausted". The wave can end without a gesture, and
    /// a run that stops mid-phrase with no explanation reads as a crash.
    public var stoppedBy: String?
    public var warning = false

    public init(_ d: [String: Any]) {
        zipped = d["zipped"] as? Bool ?? false
        front = d["front"] as? Int ?? 0
        running = d["running"] as? Bool ?? false
        tempo = d["tempo"] as? Int ?? 0
        budgetLeft = d["budget_left"] as? Int ?? 0
        stoppedBy = d["stopped_by"] as? String
        warning = d["warning"] as? Bool ?? false
    }
}
