// TraceRecorder.swift
//
// The gesture corpus. Spec §14.
//
// This is the item that looks deferrable and is not. Every threshold in the
// calibration profile is a guess, one of them was provably unreachable, and
// without recorded traces the tuning after the first session is guesswork too.
// Recorded samples are also the same artifact as a performance trace, so this
// is a first delivery of the product rather than a detour from it.
//
// Recording by default is safe: nothing leaves the device except by an
// explicit publish action, which is never a side effect of capture.

import Foundation

public final class TraceRecorder {

    private let queue = DispatchQueue(label: "io.f1r3fly.skein.trace")
    private var handle: FileHandle?
    private(set) public var currentURL: URL?
    private var written = 0

    public init() {}

    public func begin() {
        queue.async { [weak self] in
            guard let self else { return }
            let dir = FileManager.default.urls(
                for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("traces", isDirectory: true)
            try? FileManager.default.createDirectory(
                at: dir, withIntermediateDirectories: true)
            let stamp = ISO8601DateFormatter().string(from: Date())
                .replacingOccurrences(of: ":", with: "-")
            let url = dir.appendingPathComponent("session-\(stamp).ndjson")
            FileManager.default.createFile(atPath: url.path, contents: nil)
            self.handle = try? FileHandle(forWritingTo: url)
            self.currentURL = url
            self.written = 0
        }
    }

    /// One raw sample frame, newline-delimited so a truncated file is still
    /// readable up to its last complete line.
    public func append(_ data: Data) {
        queue.async { [weak self] in
            guard let self, let h = self.handle else { return }
            var line = data
            line.append(0x0A)
            try? h.write(contentsOf: line)
            self.written += 1
        }
    }

    /// A capture marker, so a gesture trace resolves to the tunes taken from
    /// it in the same way the engine's performance trace does.
    public func note(capture: TrayEntry) {
        let obj: [String: Any] = [
            "marker": "capture",
            "id": capture.id,
            "name": capture.name,
            "count": capture.count,
            "i_left": capture.iLeft,
            "i_right": capture.iRight,
            "t": Date().timeIntervalSince1970,
        ]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { append(d) }
    }

    /// A manual label, so a tester can annotate "that was a scissors" as it
    /// happens and the corpus can be tuned against offline.
    public func label(_ text: String) {
        let obj: [String: Any] = [
            "marker": "label", "text": text, "t": Date().timeIntervalSince1970,
        ]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { append(d) }
    }

    public func end() {
        queue.async { [weak self] in
            try? self?.handle?.close()
            self?.handle = nil
        }
    }

    public var sampleCount: Int { queue.sync { written } }
}
