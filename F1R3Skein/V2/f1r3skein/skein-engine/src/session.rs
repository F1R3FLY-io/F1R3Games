//! One playing session: the instrument, the recogniser, the trace, and the
//! rate discipline that keeps the client from being flooded.
//!
//! The previous engine emitted a status message on every frame of its 60 Hz
//! loop, beneath a comment reading "Push status if changed" describing a check
//! the code did not perform. Each message invalidated the entire client panel.
//! Spec §9.3 now requires the check; `Session` performs it.

use skein_core::calib::Calibration;
use skein_core::envelope::Note;
use skein_core::gesture::{Frame, Gesture, MountPoint, Recogniser};
use skein_core::state::{Instrument, Mode, Outcome};
use skein_core::term::Tune;
use skein_core::trace::{Trace, TraceEvent, TraceHeader};
use skein_proto::{EngineMsg, ZipStateMsg, PROTOCOL_VERSION};
use skein_spigot::SpigotConfig;

/// How much of each ribbon is sent for display.
const RIBBON_WIDTH: usize = 60;
/// Digits are coalesced to at most this rate, per spec §9.3.
const DIGITS_HZ: f64 = 30.0;

pub struct Session {
    pub instrument: Instrument,
    pub recogniser: Recogniser,
    pub trace: Trace,

    t: f64,
    last_digits_at: f64,

    // Last-sent values, so that state is emitted only on change.
    last_zip: Option<ZipStateMsg>,
    last_state: Option<EngineMsg>,
    last_status: String,
    last_digits: Option<(Vec<u8>, Vec<u8>, usize, usize)>,
}

impl Session {
    pub fn new(left: SpigotConfig, right: SpigotConfig, calib: Calibration) -> Self {
        let instrument = Instrument::new(left, right, calib);
        let env = instrument.envelope();
        let header = TraceHeader {
            left,
            right,
            pitch_map: env.pitch_map,
            duration_map: env.duration_map,
            root: env.root,
            instrument: env.instrument,
            started_at_ms: 0,
        };
        Session {
            recogniser: Recogniser::new(calib, MountPoint::default()),
            instrument,
            trace: Trace::new(header),
            t: 0.0,
            last_digits_at: f64::NEG_INFINITY,
            last_zip: None,
            last_state: None,
            last_status: String::new(),
            last_digits: None,
        }
    }

    /// Session clock, for the trace and for tests.
    #[allow(dead_code)]
    pub fn now(&self) -> f64 {
        self.t
    }

    fn ms(&self) -> u64 {
        (self.t * 1000.0) as u64
    }

    /// Feed one frame of samples. Returns whatever the gestures produced.
    pub fn on_frame(&mut self, f: &Frame) -> Vec<EngineMsg> {
        let mesh_len = self.instrument.mesh().map(|m| m.n).unwrap_or(0);
        let halted = self
            .instrument
            .mesh()
            .map(|m| !m.running)
            .unwrap_or(false);
        self.recogniser.sync(
            self.instrument.mode(),
            self.instrument.zipped(),
            mesh_len,
            halted,
        );
        let gestures = self.recogniser.feed(f);
        let mut out = Vec::new();
        for g in gestures {
            out.extend(self.on_gesture(g));
        }
        out
    }

    /// Apply a gesture, recording it and reporting the outcome.
    pub fn on_gesture(&mut self, g: Gesture) -> Vec<EngineMsg> {
        let ms = self.ms();
        let outcome = self.instrument.apply(g);
        let mut out = Vec::new();
        match outcome {
            Outcome::Accepted => {
                self.trace.gesture(ms, g);
            }
            Outcome::Captured(c) => {
                self.trace.gesture(ms, g);
                if let Gesture::Snip { near, far } = g {
                    self.trace.push(TraceEvent::Capture {
                        t_ms: ms,
                        id: c.id,
                        near,
                        far,
                    });
                }
                let (i_l, i_r) = match &c.term {
                    Tune::Snip { i_l, i_r, .. } => (*i_l, *i_r),
                    _ => (0, 0),
                };
                out.push(EngineMsg::SnipAck {
                    v: PROTOCOL_VERSION,
                    id: c.id,
                    name: c.name.clone(),
                    count: c.notches,
                    i_left: i_l,
                    i_right: i_r,
                    term: c.term.clone(),
                });
            }
            Outcome::Rejected(reason) => {
                // Reported rather than swallowed, so the debug overlay can show
                // M what the instrument thought.
                out.push(EngineMsg::Rejected {
                    v: PROTOCOL_VERSION,
                    reason,
                });
            }
        }
        out
    }

    /// Advance time and emit whatever changed.
    pub fn tick(&mut self, dt: f64) -> Vec<EngineMsg> {
        let was_running = self
            .instrument
            .mesh()
            .map(|m| m.running)
            .unwrap_or(false);
        let before = self.instrument.mesh().map(|m| m.n).unwrap_or(0);

        self.t += dt;
        self.instrument.tick(dt);

        let mut out = Vec::new();

        // Notes are per note and are never coalesced.
        let notes: Vec<Note> = self.instrument.drain_notes();
        for (k, note) in notes.into_iter().enumerate() {
            out.push(EngineMsg::Note {
                v: PROTOCOL_VERSION,
                note,
                notch_index: before + k,
            });
        }

        // The wave can stop without a gesture.
        if was_running {
            if let Some(m) = self.instrument.mesh() {
                if !m.running {
                    self.trace.push(TraceEvent::Exhausted {
                        t_ms: self.ms(),
                        at_notch: m.n,
                    });
                }
            }
        }

        out.extend(self.zip_state_if_changed());
        out.extend(self.state_if_changed());
        out.extend(self.digits_if_due());
        out
    }

    fn zip_state_if_changed(&mut self) -> Vec<EngineMsg> {
        let cal = *self.instrument.calibration();
        let max = cal.zip.frontier_max;
        let msg = match self.instrument.mesh() {
            None => ZipStateMsg {
                zipped: false,
                front: 0,
                running: false,
                tempo: 0,
                budget_left: max,
                stopped_by: None,
                warning: false,
            },
            Some(m) => {
                let left = m.budget_left(max);
                ZipStateMsg {
                    zipped: true,
                    front: m.n,
                    running: m.running,
                    tempo: m.tempo_bpm,
                    budget_left: left,
                    stopped_by: m.stopped_by,
                    // The approach signal, so a run does not simply stop.
                    warning: (left as f32) < (max as f32) * cal.zip.frontier_warn,
                }
            }
        };
        if self.last_zip.as_ref() == Some(&msg) {
            return Vec::new();
        }
        self.last_zip = Some(msg.clone());
        vec![EngineMsg::ZipState {
            v: PROTOCOL_VERSION,
            state: msg,
        }]
    }

    fn state_if_changed(&mut self) -> Vec<EngineMsg> {
        let (l, r) = self.instrument.configs();
        let env = self.instrument.envelope();
        let msg = EngineMsg::State {
            v: PROTOCOL_VERSION,
            mode: self.instrument.mode(),
            looping: self.instrument.looping(),
            left_label: l.label(),
            right_label: r.label(),
            pitch_map: env.pitch_map,
            duration_map: env.duration_map,
            instrument: env.instrument,
        };
        if self.last_state.as_ref() == Some(&msg) {
            return Vec::new();
        }
        self.last_state = Some(msg.clone());
        vec![msg]
    }

    fn digits_if_due(&mut self) -> Vec<EngineMsg> {
        if self.t - self.last_digits_at < 1.0 / DIGITS_HZ {
            return Vec::new();
        }
        let (l_cfg, r_cfg) = self.instrument.configs();
        let (p_l, p_r) = match self.instrument.mesh() {
            Some(m) => (m.i_l + m.n, m.i_r + m.n),
            None => self.instrument.cursors(),
        };

        // The window runs FORWARD from the cursor, not backward.
        //
        // The spool holds the future: the present section is the ribbon
        // between M's hands and the spool, which is material that has not been
        // consumed yet. A backward window also emptied whenever the cursor sat
        // at zero, which is exactly where a stream change leaves it.
        //
        // Each role is read directly. Building a `Snip` with the
        // configurations swapped to get the other ribbon conflated roles with
        // ribbons, and showed the same constant on both.
        let left = self.instrument.ribbon(true, p_l, RIBBON_WIDTH);
        let right = self.instrument.ribbon(false, p_r, RIBBON_WIDTH);

        let key = (left.clone(), right.clone(), p_l, p_r);
        if self.last_digits.as_ref() == Some(&key) {
            return Vec::new();
        }
        self.last_digits = Some(key);
        self.last_digits_at = self.t;
        vec![EngineMsg::Digits {
            v: PROTOCOL_VERSION,
            left,
            right,
            left_pos: p_l,
            right_pos: p_r,
            left_base: l_cfg.base,
            right_base: r_cfg.base,
        }]
    }

    /// Advisory text, emitted only on change.
    pub fn status(&mut self, text: &str) -> Vec<EngineMsg> {
        if self.last_status == text {
            return Vec::new();
        }
        self.last_status = text.to_string();
        vec![EngineMsg::Status {
            v: PROTOCOL_VERSION,
            text: text.to_string(),
        }]
    }

    #[allow(dead_code)]
    pub fn mode(&self) -> Mode {
        self.instrument.mode()
    }

    pub fn end(&mut self) {
        let ms = self.ms();
        self.trace.end(ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skein_spigot::Constant;

    fn cfg(c: Constant, b: u32) -> SpigotConfig {
        SpigotConfig::new(c, b).unwrap()
    }

    fn session() -> Session {
        Session::new(
            cfg(Constant::Pi, 22),
            cfg(Constant::E, 5),
            Calibration::default(),
        )
    }

    fn count<F: Fn(&EngineMsg) -> bool>(msgs: &[EngineMsg], f: F) -> usize {
        msgs.iter().filter(|m| f(m)).count()
    }

    #[test]
    fn steady_state_is_quiet() {
        // The defect: 60 status messages a second, each invalidating the panel.
        let mut s = session();
        s.tick(0.016);
        let mut noisy = 0;
        for _ in 0..120 {
            let out = s.tick(0.016);
            noisy += count(&out, |m| {
                matches!(m, EngineMsg::ZipState { .. } | EngineMsg::State { .. })
            });
        }
        assert_eq!(noisy, 0, "unchanged state must not be re-sent");
    }

    #[test]
    fn digits_are_coalesced() {
        let mut s = session();
        s.on_gesture(Gesture::Zip { closing_speed: 1.0 });
        let mut digits = 0;
        for _ in 0..60 {
            digits += count(&s.tick(0.016), |m| matches!(m, EngineMsg::Digits { .. }));
        }
        // One second at 60 Hz must not exceed the 30 Hz cap.
        assert!(digits <= 31, "sent {digits} digit messages in a second");
        assert!(digits > 0);
    }

    #[test]
    fn the_ribbon_is_populated_from_a_standing_start() {
        // A stream change resets the cursors to zero. The ribbon shows the
        // material ahead of the cursor — what is still on the spool — so it
        // must be full immediately rather than waiting for motion.
        let mut s = session();
        let mut found = None;
        for _ in 0..8 {
            for m in s.tick(0.05) {
                if let EngineMsg::Digits { left, right, .. } = m {
                    found = Some((left.len(), right.len()));
                }
            }
        }
        let (l, r) = found.expect("digits should be sent at rest");
        assert_eq!(l, RIBBON_WIDTH, "left ribbon empty at cursor zero");
        assert_eq!(r, RIBBON_WIDTH, "right ribbon empty at cursor zero");
    }

    #[test]
    fn each_ribbon_shows_its_own_stream() {
        // Both ribbons showed pi once the bases differed, because the right
        // ribbon was read through a Snip term with the configs swapped.
        let mut s = Session::new(
            cfg(Constant::Pi, 16),
            cfg(Constant::E, 5),
            Calibration::default(),
        );
        let mut got = None;
        for _ in 0..8 {
            for m in s.tick(0.05) {
                if let EngineMsg::Digits {
                    left, right, left_base, right_base, ..
                } = m
                {
                    got = Some((left, right, left_base, right_base));
                }
            }
        }
        let (l, r, lb, rb) = got.expect("digits");
        assert_eq!((lb, rb), (16, 5), "each ribbon reports its own base");
        assert!(l.iter().any(|d| *d >= 5), "left should use the full base 16");
        assert!(r.iter().all(|d| *d < 5), "right must stay inside base 5");
        assert_ne!(l[..8], r[..8], "the two ribbons are different streams");
    }

    #[test]
    fn the_two_ribbons_are_different_streams() {
        // They showed the same constant twice, because each ribbon's digits
        // were fetched through a Snip term with the configurations swapped.
        let mut s = session();
        let mut got = None;
        for _ in 0..8 {
            for m in s.tick(0.05) {
                if let EngineMsg::Digits { left, right, left_base, right_base, .. } = m {
                    got = Some((left, right, left_base, right_base));
                }
            }
        }
        let (l, r, lb, rb) = got.expect("digits");
        assert_eq!(lb, 22, "pitch role carries the scale base");
        assert_eq!(rb, 5, "duration role is always base 5");
        assert!(r.iter().all(|d| (*d as u32) < 5), "right ribbon must be base 5");
        assert!(l.iter().any(|d| *d >= 5), "left ribbon should exceed base 5");
        assert_ne!(l[..10], r[..10], "the ribbons are pi and e, not pi twice");
    }

    #[test]
    fn a_twist_moves_the_constants_and_leaves_the_bases(){
        let mut s = session();
        s.on_gesture(Gesture::Twist);
        let mut got = None;
        for _ in 0..8 {
            for m in s.tick(0.05) {
                if let EngineMsg::Digits { left_base, right_base, right, .. } = m {
                    got = Some((left_base, right_base, right));
                }
            }
        }
        let (lb, rb, r) = got.expect("digits");
        assert_eq!((lb, rb), (22, 5), "bases stay with the roles");
        assert!(r.iter().all(|d| (*d as u32) < 5));
    }

    #[test]
    fn notes_are_not_coalesced() {
        let mut s = session();
        s.on_gesture(Gesture::Zip { closing_speed: 1.0 });
        let mut notes = 0;
        for _ in 0..120 {
            notes += count(&s.tick(0.016), |m| matches!(m, EngineMsg::Note { .. }));
        }
        assert!(notes > 4, "the front should have sounded several notches");
    }

    #[test]
    fn exhaustion_is_reported_and_traced() {
        let mut s = session();
        let mut c = Calibration::default();
        c.zip.frontier_max = 8;
        s.instrument.set_calibration(c);
        s.on_gesture(Gesture::Zip { closing_speed: 1.0 });
        let mut saw = false;
        for _ in 0..600 {
            for m in s.tick(0.016) {
                if let EngineMsg::ZipState { state, .. } = m {
                    if state.stopped_by
                        == Some(skein_core::state::StopReason::Exhausted)
                    {
                        saw = true;
                    }
                }
            }
        }
        assert!(saw, "the client must be told why the wave stopped");
        assert!(s
            .trace
            .events
            .iter()
            .any(|e| matches!(e, TraceEvent::Exhausted { .. })));
    }

    #[test]
    fn a_capture_is_acknowledged_with_its_term() {
        let mut s = session();
        s.on_gesture(Gesture::Zip { closing_speed: 1.0 });
        for _ in 0..120 {
            s.tick(0.016);
        }
        s.on_gesture(Gesture::Mount);
        let n = s.instrument.mesh().unwrap().n;
        let out = s.on_gesture(Gesture::Snip { near: 0, far: n });
        match &out[0] {
            EngineMsg::SnipAck { count, term, .. } => {
                assert_eq!(*count, n);
                assert!(matches!(term, Tune::Snip { .. }));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rejections_are_reported() {
        let mut s = session();
        let out = s.on_gesture(Gesture::Loop { on: true });
        assert!(matches!(out[0], EngineMsg::Rejected { .. }));
    }

    #[test]
    fn the_session_is_traced_without_being_asked() {
        let mut s = session();
        s.on_gesture(Gesture::Zip { closing_speed: 0.5 });
        s.tick(1.0);
        s.on_gesture(Gesture::Mount);
        s.end();
        assert!(s.trace.gestures().len() >= 2);
        assert!(s.trace.ended_at_ms.is_some());
    }
}
