//! The F1R3Skein engine.
//!
//! Configuration S1 of the specification: engine here, client on the headset,
//! connected over TCP on the local network. The Unix-domain socket of the
//! previous implementation is gone — a Unix socket is addressed by a path in
//! one host's filesystem, and the headset is a different host, so the app
//! could never connect on device at all.
//!
//! Usage:
//!   skein-engine                       serve on 0.0.0.0:7643
//!   skein-engine --addr 0.0.0.0:9000   serve elsewhere
//!   skein-engine --selftest            run a scripted session headlessly

mod session;

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use skein_core::calib::Calibration;
use skein_core::gesture::Gesture;
use skein_proto::{ClientMsg, EngineMsg, PROTOCOL_VERSION};
use skein_spigot::{Constant, SpigotConfig};

use session::Session;

/// Listen on both stacks. visionOS resolves a Bonjour service to link-local
/// and global IPv6 addresses first, so an IPv4-only listener is refused with a
/// TCP reset even though discovery succeeded. macOS defaults IPV6_V6ONLY on,
/// so one dual-stack socket is not enough — bind both.
const DEFAULT_PORT: u16 = 7643;
const TICK: Duration = Duration::from_millis(16);

fn defaults() -> (SpigotConfig, SpigotConfig) {
    // A 22-element pitch vocabulary driven by a base-22 stream, and five
    // rhythmic values driven by a base-5 stream: the base matches the
    // cardinality of the map it drives, as the spec recommends.
    (
        SpigotConfig::new(Constant::Pi, 22).expect("valid"),
        SpigotConfig::new(Constant::E, 5).expect("valid"),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--selftest") {
        selftest();
        return;
    }

    let port: u16 = args
        .windows(2)
        .find(|w| w[0] == "--port")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let mut listeners = Vec::new();
    for addr in [
        format!("[::]:{port}"),
        format!("0.0.0.0:{port}"),
    ] {
        match TcpListener::bind(&addr) {
            Ok(l) => {
                eprintln!("[engine] listening on {addr}");
                listeners.push(l);
            }
            Err(e) => eprintln!("[engine] could not bind {addr}: {e}"),
        }
    }
    if listeners.is_empty() {
        eprintln!("[engine] no listening socket; giving up");
        std::process::exit(1);
    }
    eprintln!("[engine] protocol v{PROTOCOL_VERSION}");
    eprintln!(
        "[engine] advertise with: dns-sd -R \"F1R3Skein\" _f1r3skein._tcp local {port}"
    );

    let mut handles = Vec::new();
    for listener in listeners {
        handles.push(thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        if let Err(e) = serve(s) {
                            eprintln!("[engine] session ended: {e}");
                        }
                    }
                    Err(e) => eprintln!("[engine] accept failed: {e}"),
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}

fn serve(stream: TcpStream) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    let peer = stream.peer_addr()?;
    eprintln!("[engine] client {peer}");

    let reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (l, r) = defaults();
    let mut sess = Session::new(l, r, Calibration::default());
    let mut last = Instant::now();

    for m in sess.status("ready") {
        writer.write_all(m.to_line().as_bytes())?;
    }

    loop {
        // Drain input.
        loop {
            match rx.try_recv() {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match ClientMsg::parse(&line) {
                        Ok(msg) => {
                            if msg.version() != PROTOCOL_VERSION {
                                let e = EngineMsg::Error {
                                    v: PROTOCOL_VERSION,
                                    code: "version".into(),
                                    text: format!(
                                        "client speaks v{}, engine speaks v{}",
                                        msg.version(),
                                        PROTOCOL_VERSION
                                    ),
                                };
                                writer.write_all(e.to_line().as_bytes())?;
                                continue;
                            }
                            if matches!(msg, ClientMsg::Quit { .. }) {
                                sess.end();
                                eprintln!(
                                    "[engine] {peer} quit; {} gestures traced",
                                    sess.trace.gestures().len()
                                );
                                return Ok(());
                            }
                            for out in handle(&mut sess, msg) {
                                writer.write_all(out.to_line().as_bytes())?;
                            }
                        }
                        Err(e) => {
                            let m = EngineMsg::Error {
                                v: PROTOCOL_VERSION,
                                code: "parse".into(),
                                text: e,
                            };
                            writer.write_all(m.to_line().as_bytes())?;
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    sess.end();
                    return Ok(());
                }
            }
        }

        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f64();
        last = now;
        for m in sess.tick(dt) {
            writer.write_all(m.to_line().as_bytes())?;
        }
        writer.flush()?;
        thread::sleep(TICK);
    }
}

fn handle(sess: &mut Session, msg: ClientMsg) -> Vec<EngineMsg> {
    match msg {
        ClientMsg::Frame { frame, .. } => sess.on_frame(&frame),
        ClientMsg::Gesture { gesture, .. } => sess.on_gesture(gesture),
        ClientMsg::Configure {
            pitch_map,
            duration_map,
            root,
            instrument,
            ..
        } => {
            let env = sess.instrument.envelope();
            sess.instrument.set_maps(
                pitch_map.unwrap_or(env.pitch_map),
                duration_map.unwrap_or(env.duration_map),
                root.unwrap_or(env.root),
            );
            if let Some(p) = instrument {
                sess.instrument.set_instrument(p);
            }
            Vec::new()
        }
        ClientMsg::Calibrate { calibration, .. } => match calibration.validate() {
            Ok(()) => {
                sess.instrument.set_calibration(calibration);
                sess.recogniser.set_calibration(calibration);
                sess.status("calibration reloaded")
            }
            Err(e) => vec![EngineMsg::Error {
                v: PROTOCOL_VERSION,
                code: "calibration".into(),
                text: e,
            }],
        },
        ClientMsg::Rename { id, name, .. } => {
            sess.instrument.rename(id, &name);
            Vec::new()
        }
        ClientMsg::Quit { .. } => Vec::new(),
    }
}

/// A scripted session, so the whole chain can be exercised without a headset.
fn selftest() {
    let (l, r) = defaults();
    let mut s = Session::new(l, r, Calibration::default());

    println!("F1R3Skein engine selftest — protocol v{PROTOCOL_VERSION}");
    println!("  streams: {} / {}", l.label(), r.label());

    // Play: set the phase, then zip.
    s.on_gesture(Gesture::PullLeft { steps: 40, velocity: 0.6 });
    s.on_gesture(Gesture::PullRight { steps: 7, velocity: 0.4 });
    s.on_gesture(Gesture::Zip { closing_speed: 0.7 });
    let tempo = s.instrument.mesh().unwrap().tempo_bpm;
    println!("  zipped at offset ({}, {}), tempo {tempo} bpm", 40, 7);

    let mut heard = 0usize;
    for _ in 0..250 {
        for m in s.tick(0.016) {
            if matches!(m, EngineMsg::Note { .. }) {
                heard += 1;
            }
        }
    }
    println!("  wave ran: {heard} notches sounded");

    // A silence, which must not appear in any capture.
    s.on_gesture(Gesture::Halt { on: true });
    for _ in 0..120 {
        s.tick(0.016);
    }
    let frozen = s.instrument.mesh().unwrap().n;
    s.on_gesture(Gesture::Halt { on: false });
    for _ in 0..120 {
        s.tick(0.016);
    }
    println!(
        "  halt held the front at {frozen}, resumed to {}",
        s.instrument.mesh().unwrap().n
    );
    assert_eq!(
        s.instrument.mesh().unwrap().tempo_bpm,
        tempo,
        "a mesh has one tempo"
    );

    // Meta: mount, audition, capture twice over overlapping windows.
    s.on_gesture(Gesture::Mount);
    s.on_gesture(Gesture::Loop { on: true });
    let n = s.instrument.mesh().unwrap().n;
    for (near, far) in [(0, n / 2), (n / 4, n)] {
        for m in s.on_gesture(Gesture::Snip { near, far }) {
            if let EngineMsg::SnipAck { id, name, count, i_left, i_right, .. } = m {
                println!(
                    "  capture {id} \"{name}\": {count} notches at ({i_left}, {i_right})"
                );
            }
        }
    }
    assert_eq!(
        s.instrument.mesh().unwrap().n,
        n,
        "the cut is virtual — the band is undisturbed"
    );

    // The acceptance test of the representation.
    let cap = s.instrument.captures()[0].clone();
    let a = s.instrument.render_capture(&cap);
    let b = s.instrument.render_capture(&cap);
    assert_eq!(a, b);
    assert!(
        a.iter().all(|n| n.pitch.is_some()),
        "a capture spanning a halt contains no silence"
    );
    println!("  re-realised capture 1: {} notes, reproducible", a.len());

    s.on_gesture(Gesture::Unmount);
    assert!(s.instrument.zipped(), "the mesh survives unmount");
    s.end();
    println!(
        "  trace: {} gestures, {} captures, {} ms",
        s.trace.gestures().len(),
        s.trace.capture_ids().len(),
        s.trace.duration_ms()
    );
    println!("selftest OK");
}
