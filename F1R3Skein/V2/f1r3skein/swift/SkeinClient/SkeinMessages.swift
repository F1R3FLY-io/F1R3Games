// SkeinMessages.swift
//
// Protocol v4, Codable both ways. Spec §9.
//
// The client resolves no gestures of its own except the panel equivalents the
// spec requires for accessibility: detection lives in the Rust core, so that
// configurations S1 and S2 share one implementation and the detectors stay
// unit-testable against recorded traces.

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

// MARK: - Gestures

/// Mirrors the Rust `Gesture` enum, which is internally tagged on `gesture`
/// with snake_case names. Payloads matter: `zip` carries the closing speed
/// that becomes the mesh tempo, and `snip` carries two notch offsets because
/// the capture is bracketed by both hands.
public enum SkeinGesture: Encodable, Equatable {
    case pullLeft(steps: UInt32, velocity: Float)
    case pullRight(steps: UInt32, velocity: Float)
    case twist
    case zip(closingSpeed: Float)
    case unzip
    /// Set and clear, never a toggle: on a noisy detector a missed fire and a
    /// double fire are indistinguishable, and M corrects by tilting again.
    case halt(on: Bool)
    case mount
    case unmount
    case loop(on: Bool)
    case snip(near: Int, far: Int)

    enum CodingKeys: String, CodingKey {
        case gesture, steps, velocity, closing_speed, on, near, far
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .pullLeft(let s, let v):
            try c.encode("pull_left", forKey: .gesture)
            try c.encode(s, forKey: .steps); try c.encode(v, forKey: .velocity)
        case .pullRight(let s, let v):
            try c.encode("pull_right", forKey: .gesture)
            try c.encode(s, forKey: .steps); try c.encode(v, forKey: .velocity)
        case .twist:
            try c.encode("twist", forKey: .gesture)
        case .zip(let speed):
            try c.encode("zip", forKey: .gesture)
            try c.encode(speed, forKey: .closing_speed)
        case .unzip:
            try c.encode("unzip", forKey: .gesture)
        case .halt(let on):
            try c.encode("halt", forKey: .gesture); try c.encode(on, forKey: .on)
        case .mount:
            try c.encode("mount", forKey: .gesture)
        case .unmount:
            try c.encode("unmount", forKey: .gesture)
        case .loop(let on):
            try c.encode("loop", forKey: .gesture); try c.encode(on, forKey: .on)
        case .snip(let near, let far):
            try c.encode("snip", forKey: .gesture)
            try c.encode(near, forKey: .near); try c.encode(far, forKey: .far)
        }
    }
}

// MARK: - Client to engine

public enum ClientMessage: Encodable {
    case frame(SkeinFrame)
    case gesture(SkeinGesture)
    case configure(pitchMap: String?, durationMap: String?, root: UInt8?, instrument: UInt8?)
    case rename(id: UInt64, name: String)
    case quit

    enum CodingKeys: String, CodingKey {
        case type, v, frame, gesture
        case left, right, pitch_map, duration_map, root, instrument
        case id, name
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(skeinProtocolVersion, forKey: .v)
        switch self {
        case .frame(let f):
            try c.encode("frame", forKey: .type)
            try c.encode(f, forKey: .frame)
        case .gesture(let g):
            try c.encode("gesture", forKey: .type)
            try c.encode(g, forKey: .gesture)
        case .configure(let pm, let dm, let root, let inst):
            try c.encode("configure", forKey: .type)
            try c.encodeNil(forKey: .left)
            try c.encodeNil(forKey: .right)
            try c.encode(pm, forKey: .pitch_map)
            try c.encode(dm, forKey: .duration_map)
            try c.encode(root, forKey: .root)
            try c.encode(inst, forKey: .instrument)
        case .rename(let id, let name):
            try c.encode("rename", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
        case .quit:
            try c.encode("quit", forKey: .type)
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

    public init() {}
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

public struct TrayEntry: Identifiable, Equatable {
    public var id: UInt64
    public var name: String
    public var count: Int
    public var iLeft: Int
    public var iRight: Int
}
