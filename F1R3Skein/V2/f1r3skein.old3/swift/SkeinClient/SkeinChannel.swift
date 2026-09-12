// SkeinChannel.swift
//
// The transport. Spec §2.
//
// This replaces the AF_UNIX socket of the previous implementation. A Unix
// domain socket is addressed by a path in one host's filesystem; the headset
// is a different host, so the app could never connect on device at all — hand
// tracking worked only in the Simulator, where the engine was unreachable,
// and the engine was reachable only where hand tracking did not exist.
//
// Network.framework is used rather than raw POSIX because it brings
// reconnection, path monitoring and backpressure, and because it removes the
// file-descriptor lifetime bugs in the old client: two FileHandles were
// constructed over one fd, readLoop closed that fd while the write handle
// still held it, and disconnect() closed it a second time. After the first
// reconnect a gesture write could land on a recycled descriptor.
//
// NOTE: Info.plist must carry NSLocalNetworkUsageDescription and
// NSBonjourServices (_f1r3skein._tcp). Without them visionOS blocks the
// connection at the first packet and the failure looks like a silent timeout.

import Foundation
import Network

public enum ChannelState: Equatable {
    case idle
    case browsing
    case connecting(String)
    case ready(String)
    case failed(String)
}

public final class SkeinChannel {

    public private(set) var state: ChannelState = .idle {
        didSet { if state != oldValue { onState?(state) } }
    }

    public var onState: ((ChannelState) -> Void)?
    /// One decoded engine message. Delivered on `queue`.
    public var onMessage: (([String: Any]) -> Void)?

    private let service = "_f1r3skein._tcp"
    private let queue = DispatchQueue(label: "io.f1r3fly.skein.channel")
    private var browser: NWBrowser?
    private var connection: NWConnection?
    private var inbox = Data()
    private var retry = 1.0

    public init() {}

    // MARK: - Discovery

    /// Bonjour rather than a typed address: during a session with a laptop on
    /// DHCP, a hardcoded IP costs more time than the discovery code.
    public func start() {
        state = .browsing
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: service, domain: nil), using: params)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self, let first = results.first else { return }
            self.browser?.cancel()
            self.browser = nil
            self.connect(to: first.endpoint)
        }
        b.stateUpdateHandler = { [weak self] s in
            if case .failed(let e) = s {
                self?.state = .failed("browse: \(e.localizedDescription)")
                self?.scheduleRetry()
            }
        }
        b.start(queue: queue)
        browser = b
    }

    /// Manual fallback for a session where discovery is unavailable.
    public func connect(host: String, port: UInt16) {
        guard let p = NWEndpoint.Port(rawValue: port) else { return }
        connect(to: .hostPort(host: NWEndpoint.Host(host), port: p))
    }

    private func connect(to endpoint: NWEndpoint) {
        state = .connecting("\(endpoint)")
        let c = NWConnection(to: endpoint, using: .tcp)
        c.stateUpdateHandler = { [weak self] s in
            guard let self else { return }
            switch s {
            case .ready:
                self.retry = 1.0
                self.state = .ready("\(endpoint)")
                self.receive()
            case .failed(let e):
                self.state = .failed(e.localizedDescription)
                self.teardown()
                self.scheduleRetry()
            case .cancelled:
                self.state = .idle
            default:
                break
            }
        }
        c.start(queue: queue)
        connection = c
    }

    private func scheduleRetry() {
        let delay = retry
        retry = min(retry * 2, 10.0)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.connection == nil else { return }
            self.start()
        }
    }

    private func teardown() {
        connection?.cancel()
        connection = nil
        inbox.removeAll()
    }

    public func stop() {
        browser?.cancel()
        browser = nil
        teardown()
        state = .idle
    }

    // MARK: - Receive

    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.inbox.append(data)
                self.drainLines()
            }
            if isComplete || error != nil {
                self.teardown()
                self.scheduleRetry()
                return
            }
            self.receive()
        }
    }

    private func drainLines() {
        while let nl = inbox.firstIndex(of: 0x0A) {
            let line = inbox.subdata(in: inbox.startIndex..<nl)
            inbox.removeSubrange(inbox.startIndex...nl)
            guard !line.isEmpty,
                  let obj = try? JSONSerialization.jsonObject(with: line),
                  let dict = obj as? [String: Any]
            else { continue }
            onMessage?(dict)
        }
    }

    // MARK: - Send

    /// Encoded, never interpolated. The previous client escaped only the
    /// double quote, so a name containing a backslash produced malformed JSON
    /// that the engine silently discarded.
    public func send<T: Encodable>(_ message: T) {
        guard let c = connection, case .ready = state else { return }
        let encoder = JSONEncoder()
        guard var data = try? encoder.encode(message) else { return }
        data.append(0x0A)
        c.send(content: data, completion: .contentProcessed { _ in })
    }
}
