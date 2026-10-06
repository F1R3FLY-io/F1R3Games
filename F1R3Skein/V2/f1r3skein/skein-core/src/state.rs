//! The instrument state machine.
//!
//! Spec §5. The organising principle is the mode split:
//!
//! > While M holds the ribbons she is playing. While the ribbons are mounted
//! > she is in meta play.
//!
//! That principle removes machinery rather than adding it. What an earlier
//! draft specified as "pull must be suppressed during a cut" is not a rule at
//! all: pull does not exist in meta play, because there are no ribbons in her
//! hands to pull.

use serde::{Deserialize, Serialize};
use skein_spigot::{Constant, DigitCache, SpigotConfig};

use crate::calib::Calibration;
use crate::envelope::{DurationMap, Envelope, Note, PitchMap};
use crate::gesture::Gesture;
use crate::term::{realise, Material, Skein, Tune};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Play,
    Meta,
}

/// Why the wave is not propagating. The wave can now end without a gesture,
/// and a run that stops mid-phrase with no explanation reads as a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Halt,
    Mount,
    Exhausted,
}

/// A committed mesh. Created by a zip, destroyed by an unzip, and outliving
/// both mount and halt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mesh {
    /// Cursor positions at the moment of zipping. The relative offset between
    /// them is M's compositional choice, made with the hands before zipping.
    pub i_l: usize,
    pub i_r: usize,
    /// Notches committed so far — the position of the zip front.
    pub n: usize,
    /// Set from the closing speed and fixed for this mesh's whole life:
    /// resuming after a halt involves no closing motion, so there is no new
    /// speed to read.
    pub tempo_bpm: u32,
    pub running: bool,
    pub stopped_by: Option<StopReason>,
    /// Fractional notch carried between ticks.
    accum: f64,
}

impl Mesh {
    pub fn budget_left(&self, max: usize) -> usize {
        max.saturating_sub(self.n)
    }
}

/// A captured tune. The term is the material; the envelope is the
/// interpretation, copied in at capture time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Capture {
    pub id: u64,
    pub name: String,
    pub term: Tune,
    pub envelope: Envelope,
    pub notches: usize,
}

/// Why a gesture was refused. Rejections are reported rather than swallowed,
/// so that the debug overlay can show M what the instrument thought.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rejection {
    WrongMode,
    NotZipped,
    AlreadyZipped,
    NoMesh,
    OutsideMesh,
    EmptySpan,
    FrontierExhausted,
}

/// What the engine did with a gesture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Outcome {
    Accepted,
    Captured(Capture),
    Rejected(Rejection),
}

#[derive(Debug, Clone)]
pub struct Instrument {
    calib: Calibration,
    mode: Mode,

    /// The constant currently in the pitch role, and the one in the duration
    /// role. A twist exchanges these two and nothing else.
    pitch_constant: Constant,
    duration_constant: Constant,
    /// The pitch role's base — 16, 22 or 37. The duration role is always
    /// `DURATION_BASE` and never varies.
    pitch_base: u32,
    p_l: usize,
    p_r: usize,

    mesh: Option<Mesh>,
    looping: bool,

    pitch_map: PitchMap,
    duration_map: DurationMap,
    root: u8,
    instrument: u8,

    captures: Vec<Capture>,
    next_id: u64,

    cache: DigitCache,
    /// Notes emitted by the advancing front since the last drain.
    pending: Vec<Note>,
}

impl Instrument {
    pub fn new(left: SpigotConfig, right: SpigotConfig, calib: Calibration) -> Self {
        let e = Envelope::default();
        Instrument {
            calib,
            mode: Mode::Play,
            pitch_constant: left.constant,
            duration_constant: right.constant,
            pitch_base: left.base,
            p_l: 0,
            p_r: 0,
            mesh: None,
            looping: false,
            pitch_map: e.pitch_map,
            duration_map: e.duration_map,
            root: e.root,
            instrument: e.instrument,
            captures: Vec::new(),
            next_id: 1,
            cache: DigitCache::new(),
            pending: Vec::new(),
        }
    }

    // ------------------------------------------------------------ accessors

    pub fn mode(&self) -> Mode {
        self.mode
    }
    pub fn mesh(&self) -> Option<&Mesh> {
        self.mesh.as_ref()
    }
    pub fn zipped(&self) -> bool {
        self.mesh.is_some()
    }
    pub fn looping(&self) -> bool {
        self.looping
    }
    pub fn cursors(&self) -> (usize, usize) {
        (self.p_l, self.p_r)
    }
    pub fn configs(&self) -> (SpigotConfig, SpigotConfig) {
        self.skein().normalise()
    }

    /// The constant in each role, for display.
    pub fn role_constants(&self) -> (Constant, Constant) {
        (self.pitch_constant, self.duration_constant)
    }
    pub fn captures(&self) -> &[Capture] {
        &self.captures
    }
    pub fn calibration(&self) -> &Calibration {
        &self.calib
    }

    /// The skein as a term. `Weave` with the pitch side first.
    pub fn skein(&self) -> Skein {
        Skein::weave(self.pitch_constant, self.duration_constant, self.pitch_base)
    }

    /// The envelope in force right now. Tempo comes from the mesh, because a
    /// mesh has one tempo for its whole life.
    pub fn envelope(&self) -> Envelope {
        Envelope {
            pitch_map: self.pitch_map,
            duration_map: self.duration_map,
            root: self.root,
            tempo_bpm: self.mesh.as_ref().map(|m| m.tempo_bpm).unwrap_or(96),
            instrument: self.instrument,
            velocity: 100,
            top_digit_is_rest: true,
        }
    }

    /// Change the streams. Only while unzipped: the mesh has committed the
    /// pairing, and swapping a stream underneath it has no coherent reading.
    ///
    /// A pitch base should be three octaves of its scale plus a rest
    /// (`base = 3 * degrees + 1`); a mismatch is permitted and folds modulo the
    /// scale, which is legitimate but should be a choice.
    /// Change the pitch role's base, and optionally which constant sits in
    /// each role. Only while unzipped: the mesh has committed the pairing.
    ///
    /// The duration role's base is never an argument. It is
    /// [`DURATION_BASE`](crate::term::DURATION_BASE) and does not vary.
    pub fn set_streams(
        &mut self,
        left: Option<SpigotConfig>,
        right: Option<SpigotConfig>,
    ) -> Outcome {
        if self.mesh.is_some() {
            return Outcome::Rejected(Rejection::AlreadyZipped);
        }
        if let Some(l) = left {
            // The base travels with the ROLE; only the constant is taken from
            // the request.
            if l.constant != self.pitch_constant {
                self.pitch_constant = l.constant;
                self.p_l = 0;
            }
            if l.base != self.pitch_base {
                self.pitch_base = l.base;
                // A base change means the same cursor indexes a different
                // sequence entirely, so the position is meaningless now.
                self.p_l = 0;
            }
        }
        if let Some(r) = right {
            if r.constant != self.duration_constant {
                self.duration_constant = r.constant;
                self.p_r = 0;
            }
            // r.base is ignored: the duration role is always DURATION_BASE.
        }
        Outcome::Accepted
    }

    pub fn set_maps(&mut self, pitch: PitchMap, duration: DurationMap, root: u8) {
        self.pitch_map = pitch;
        self.duration_map = duration;
        self.root = root;
    }

    pub fn set_instrument(&mut self, program: u8) {
        self.instrument = program;
    }

    pub fn set_calibration(&mut self, c: Calibration) {
        self.calib = c;
    }

    /// Notes produced by the front since the last call.
    pub fn drain_notes(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.pending)
    }

    // ------------------------------------------------------------- the wave

    /// Advance wall-clock time by `dt` seconds. The zip front is the playhead:
    /// each notch pair sounds as it engages, and the propagation rate is the
    /// tempo.
    pub fn tick(&mut self, dt: f64) {
        let max = self.calib.zip.frontier_max;
        let (i_l, i_r, to_emit) = {
            let mesh = match self.mesh.as_mut() {
                Some(m) if m.running => m,
                _ => return,
            };
            // Notches per second: one per eighth note at the mesh tempo.
            let per_sec = (mesh.tempo_bpm as f64) / 60.0 * 2.0;
            mesh.accum += dt * per_sec;
            let mut count = mesh.accum.floor() as usize;
            mesh.accum -= count as f64;
            if count == 0 {
                return;
            }
            let room = max.saturating_sub(mesh.n);
            let exhausted = count >= room;
            if exhausted {
                count = room;
            }
            let start_l = mesh.i_l + mesh.n;
            let start_r = mesh.i_r + mesh.n;
            mesh.n += count;
            if exhausted {
                mesh.running = false;
                mesh.stopped_by = Some(StopReason::Exhausted);
                mesh.accum = 0.0;
            }
            (start_l, start_r, count)
        };
        if to_emit == 0 {
            return;
        }
        let env = self.envelope();
        let m = realise(
            &Tune::snip(self.skein(), i_l, i_r, to_emit),
            &mut self.cache,
        );
        self.pending.extend(env.render(&m));
    }

    // ---------------------------------------------------------- the gestures

    pub fn apply(&mut self, g: Gesture) -> Outcome {
        use Gesture::*;
        match g {
            PullLeft { steps, .. } => self.pull(true, steps),
            PullRight { steps, .. } => self.pull(false, steps),
            Twist => self.twist(),
            Zip { closing_speed } => self.zip(closing_speed),
            Unzip => self.unzip(),
            Halt { on } => self.halt(on),
            Mount => self.mount(),
            Unmount => self.unmount(),
            Loop { on } => self.set_loop(on),
            Snip { near, far } => self.snip(near, far),
        }
    }

    fn pull(&mut self, left: bool, steps: u32) -> Outcome {
        if self.mode != Mode::Play {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        // Once meshed the ribbons are locked together; the front advances the
        // material, not the hands.
        if self.mesh.is_some() {
            return Outcome::Rejected(Rejection::AlreadyZipped);
        }
        if left {
            self.p_l += steps as usize;
        } else {
            self.p_r += steps as usize;
        }
        Outcome::Accepted
    }

    fn twist(&mut self) -> Outcome {
        if self.mode != Mode::Play {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        if self.mesh.is_some() {
            return Outcome::Rejected(Rejection::AlreadyZipped);
        }
        // Only the constants exchange. The bases belong to the roles, so the
        // pitch role keeps the scale's base and the duration role stays at
        // DURATION_BASE — which means a twist also changes what each spigot
        // emits. Swapping whole configurations, as this once did, put five
        // pitches and twenty-two durations on the ribbons.
        std::mem::swap(&mut self.pitch_constant, &mut self.duration_constant);
        // Cursors travel with the constants: how far a ribbon has been pulled
        // is a property of that ribbon.
        std::mem::swap(&mut self.p_l, &mut self.p_r);
        Outcome::Accepted
    }

    fn zip(&mut self, closing_speed: f32) -> Outcome {
        if self.mode != Mode::Play {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        if self.mesh.is_some() {
            return Outcome::Rejected(Rejection::AlreadyZipped);
        }
        self.mesh = Some(Mesh {
            i_l: self.p_l,
            i_r: self.p_r,
            n: 0,
            tempo_bpm: self.calib.tempo_for(closing_speed),
            running: true,
            stopped_by: None,
            accum: 0.0,
        });
        Outcome::Accepted
    }

    fn unzip(&mut self) -> Outcome {
        if self.mode != Mode::Play {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        match self.mesh.take() {
            None => Outcome::Rejected(Rejection::NotZipped),
            Some(m) => {
                // The meshed material has passed; play resumes beyond it.
                self.p_l = m.i_l + m.n;
                self.p_r = m.i_r + m.n;
                self.looping = false;
                Outcome::Accepted
            }
        }
    }

    /// Set and clear, never a toggle. Idempotent in both directions.
    fn halt(&mut self, on: bool) -> Outcome {
        if self.mode != Mode::Play {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        let max = self.calib.zip.frontier_max;
        match self.mesh.as_mut() {
            None => Outcome::Rejected(Rejection::NotZipped),
            Some(m) => {
                if on {
                    m.running = false;
                    m.stopped_by = Some(StopReason::Halt);
                } else {
                    if m.n >= max {
                        return Outcome::Rejected(Rejection::FrontierExhausted);
                    }
                    m.running = true;
                    m.stopped_by = None;
                }
                Outcome::Accepted
            }
        }
    }

    fn mount(&mut self) -> Outcome {
        if self.mode != Mode::Play {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        self.mode = Mode::Meta;
        if let Some(m) = self.mesh.as_mut() {
            m.running = false;
            m.stopped_by = Some(StopReason::Mount);
        }
        Outcome::Accepted
    }

    /// The mesh survives. M picks up a still-zipped assembly with the wave
    /// stopped, and resumes with a head tilt at the mesh's existing tempo.
    fn unmount(&mut self) -> Outcome {
        if self.mode != Mode::Meta {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        self.mode = Mode::Play;
        self.looping = false;
        Outcome::Accepted
    }

    fn set_loop(&mut self, on: bool) -> Outcome {
        if self.mode != Mode::Meta {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        if self.mesh.is_none() {
            return Outcome::Rejected(Rejection::NoMesh);
        }
        self.looping = on;
        Outcome::Accepted
    }

    /// The capture. **Virtual**: a copy of the bracketed region is lifted and
    /// the band is undisturbed, so M may take overlapping captures, the same
    /// region twice, or work back over material she has already harvested.
    fn snip(&mut self, near: usize, far: usize) -> Outcome {
        if self.mode != Mode::Meta {
            return Outcome::Rejected(Rejection::WrongMode);
        }
        let mesh = match self.mesh.as_ref() {
            None => return Outcome::Rejected(Rejection::NoMesh),
            Some(m) => m,
        };
        if far <= near {
            return Outcome::Rejected(Rejection::EmptySpan);
        }
        // Both boundaries must lie inside the meshed span; bracketing unmeshed
        // lead would capture two unpaired ribbons rather than a tune.
        if far > mesh.n {
            return Outcome::Rejected(Rejection::OutsideMesh);
        }
        let n = far - near;
        let term = Tune::snip(
            self.skein(),
            mesh.i_l + near,
            mesh.i_r + near,
            n,
        );
        let id = self.next_id;
        self.next_id += 1;
        let capture = Capture {
            id,
            // Auto-named at the moment it is taken; renaming is a tray
            // operation, because text entry on the headset is slow and naming
            // is curatorial rather than performing.
            name: format!("take-{id:03}"),
            term,
            envelope: self.envelope(),
            notches: n,
        };
        self.captures.push(capture.clone());
        Outcome::Captured(capture)
    }

    pub fn rename(&mut self, id: u64, name: &str) -> bool {
        for c in self.captures.iter_mut() {
            if c.id == id {
                c.name = name.to_string();
                return true;
            }
        }
        false
    }

    /// Re-realise a capture from its term and envelope. This is the acceptance
    /// test of the whole representation: it must equal what M heard.
    pub fn render_capture(&mut self, c: &Capture) -> Vec<Note> {
        let m = realise(&c.term, &mut self.cache);
        c.envelope.render(&m)
    }

    pub fn material(&mut self, t: &Tune) -> Material {
        realise(t, &mut self.cache)
    }

    /// Raw digits from one role, for display.
    ///
    /// Read directly rather than through a `Snip` term with the configurations
    /// swapped, which is how the ribbons came to show the same constant twice:
    /// that hack conflated the pitch/duration roles with the left/right
    /// ribbons, so each ribbon's digits arrived through machinery with its own
    /// opinion about which stream was which.
    pub fn ribbon(&mut self, pitch_role: bool, from: usize, n: usize) -> Vec<u8> {
        let cfg = if pitch_role {
            self.skein().pitch_config()
        } else {
            self.skein().duration_config()
        };
        self.cache.range(cfg, from, n)
    }

    /// Raw digits of one stream, for display.
    ///
    /// A ribbon is one stream. Reading it through a `Snip` term means going via
    /// machinery that assigns pitch and duration roles, which is a different
    /// question from which ribbon is which — and getting the right ribbon out
    /// of it required swapping the configs, a hack that made both ribbons show
    /// the same stream as soon as the bases differed.
    pub fn stream_digits(&mut self, cfg: SpigotConfig, from: usize, n: usize) -> Vec<u8> {
        self.cache.range(cfg, from, n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skein_spigot::Constant;

    fn cfg(c: Constant, b: u32) -> SpigotConfig {
        SpigotConfig::new(c, b).unwrap()
    }

    fn inst() -> Instrument {
        Instrument::new(
            cfg(Constant::Pi, 22),
            cfg(Constant::E, 5),
            Calibration::default(),
        )
    }

    fn zipped() -> Instrument {
        let mut i = inst();
        assert_eq!(i.apply(Gesture::Zip { closing_speed: 0.6 }), Outcome::Accepted);
        i
    }

    #[test]
    fn starts_in_play_unzipped() {
        let i = inst();
        assert_eq!(i.mode(), Mode::Play);
        assert!(!i.zipped());
    }

    #[test]
    fn pull_moves_one_cursor_only() {
        let mut i = inst();
        i.apply(Gesture::PullLeft { steps: 5, velocity: 0.5 });
        assert_eq!(i.cursors(), (5, 0));
        i.apply(Gesture::PullRight { steps: 2, velocity: 0.5 });
        assert_eq!(i.cursors(), (5, 2));
    }

    #[test]
    fn zip_anchors_both_cursors() {
        let mut i = inst();
        i.apply(Gesture::PullLeft { steps: 7, velocity: 0.5 });
        i.apply(Gesture::PullRight { steps: 3, velocity: 0.5 });
        i.apply(Gesture::Zip { closing_speed: 0.6 });
        let m = i.mesh().unwrap();
        assert_eq!((m.i_l, m.i_r), (7, 3), "phase offset is M's choice");
    }

    #[test]
    fn faster_closing_gives_a_faster_tempo() {
        let mut slow = inst();
        slow.apply(Gesture::Zip { closing_speed: 0.2 });
        let mut fast = inst();
        fast.apply(Gesture::Zip { closing_speed: 1.0 });
        assert!(fast.mesh().unwrap().tempo_bpm > slow.mesh().unwrap().tempo_bpm);
    }

    #[test]
    fn the_wave_advances_and_sounds() {
        let mut i = zipped();
        i.tick(1.0);
        assert!(i.mesh().unwrap().n > 0);
        assert!(!i.drain_notes().is_empty(), "each notch pair sounds as it engages");
    }

    #[test]
    fn halt_is_idempotent_in_both_directions() {
        let mut i = zipped();
        i.tick(0.5);
        i.apply(Gesture::Halt { on: true });
        let n = i.mesh().unwrap().n;
        i.apply(Gesture::Halt { on: true });
        i.tick(1.0);
        assert_eq!(i.mesh().unwrap().n, n, "repeat halt must not resume");
        i.apply(Gesture::Halt { on: false });
        i.tick(1.0);
        assert!(i.mesh().unwrap().n > n);
    }

    #[test]
    fn tempo_survives_a_halt_and_resume() {
        let mut i = zipped();
        let t0 = i.mesh().unwrap().tempo_bpm;
        i.tick(0.5);
        i.apply(Gesture::Halt { on: true });
        i.apply(Gesture::Halt { on: false });
        assert_eq!(i.mesh().unwrap().tempo_bpm, t0, "a mesh has one tempo");
    }

    #[test]
    fn the_frontier_is_bounded_and_reports_why() {
        let mut i = inst();
        let mut c = Calibration::default();
        c.zip.frontier_max = 12;
        i.set_calibration(c);
        i.apply(Gesture::Zip { closing_speed: 1.0 });
        i.tick(60.0);
        let m = i.mesh().unwrap();
        assert_eq!(m.n, 12);
        assert!(!m.running);
        assert_eq!(m.stopped_by, Some(StopReason::Exhausted));
    }

    #[test]
    fn mount_stops_the_wave_and_enters_meta() {
        let mut i = zipped();
        i.tick(0.5);
        i.apply(Gesture::Mount);
        assert_eq!(i.mode(), Mode::Meta);
        let n = i.mesh().unwrap().n;
        assert_eq!(i.mesh().unwrap().stopped_by, Some(StopReason::Mount));
        i.tick(2.0);
        assert_eq!(i.mesh().unwrap().n, n, "the wave must not run in meta");
    }

    #[test]
    fn unmount_preserves_the_mesh_and_the_tempo() {
        let mut i = zipped();
        let tempo = i.mesh().unwrap().tempo_bpm;
        i.tick(1.0);
        let n = i.mesh().unwrap().n;
        i.apply(Gesture::Mount);
        i.apply(Gesture::Unmount);
        assert_eq!(i.mode(), Mode::Play);
        let m = i.mesh().unwrap();
        assert_eq!(m.n, n);
        assert_eq!(m.tempo_bpm, tempo);
    }

    #[test]
    fn play_gestures_are_refused_in_meta() {
        let mut i = zipped();
        i.tick(1.0);
        i.apply(Gesture::Mount);
        for g in [
            Gesture::PullLeft { steps: 1, velocity: 0.5 },
            Gesture::Twist,
            Gesture::Unzip,
            Gesture::Halt { on: true },
        ] {
            assert_eq!(i.apply(g), Outcome::Rejected(Rejection::WrongMode), "{g:?}");
        }
    }

    #[test]
    fn meta_gestures_are_refused_in_play() {
        let mut i = zipped();
        i.tick(1.0);
        assert_eq!(
            i.apply(Gesture::Loop { on: true }),
            Outcome::Rejected(Rejection::WrongMode)
        );
        assert_eq!(
            i.apply(Gesture::Snip { near: 0, far: 4 }),
            Outcome::Rejected(Rejection::WrongMode)
        );
    }

    #[test]
    fn twist_exchanges_constants_not_bases() {
        // Roles are positional and hold the bases: left is always pitch at the
        // scale's base, right is always duration at base 5. A twist moves the
        // constants between roles, so each spigot changes what it emits.
        let mut i = inst();
        i.apply(Gesture::PullLeft { steps: 9, velocity: 0.5 });
        let (l0, r0) = i.configs();
        assert_eq!((l0.constant, l0.base), (Constant::Pi, 22));
        assert_eq!((r0.constant, r0.base), (Constant::E, 5));

        i.apply(Gesture::Twist);
        let (l1, r1) = i.configs();
        assert_eq!((l1.constant, l1.base), (Constant::E, 22), "e takes the pitch base");
        assert_eq!((r1.constant, r1.base), (Constant::Pi, 5), "pi takes base 5");
        // Cursors travel with the constants: how far a ribbon has been pulled
        // is a property of that ribbon.
        assert_eq!(i.cursors(), (0, 9));
    }

    #[test]
    fn the_pitch_base_follows_the_scale_and_the_duration_base_does_not() {
        let mut i = inst();
        for base in [16u32, 22, 37] {
            let out = i.set_streams(
                Some(SpigotConfig::new(Constant::Pi, base).unwrap()),
                None,
            );
            assert_eq!(out, Outcome::Accepted);
            let (l, r) = i.configs();
            assert_eq!(l.base, base, "pitch role takes the scale base");
            assert_eq!(r.base, 5, "duration role never varies");
        }
    }

    #[test]
    fn a_base_change_is_refused_while_zipped() {
        let mut i = zipped();
        assert_eq!(
            i.set_streams(Some(SpigotConfig::new(Constant::Pi, 16).unwrap()), None),
            Outcome::Rejected(Rejection::AlreadyZipped)
        );
    }

    #[test]
    fn twist_is_refused_while_zipped() {
        let mut i = zipped();
        assert_eq!(i.apply(Gesture::Twist), Outcome::Rejected(Rejection::AlreadyZipped));
    }

    // ---- the acceptance tests of the representation ---------------------

    #[test]
    fn a_capture_re_realises_to_what_was_heard() {
        // Spec conformance item 17. This cannot pass on an implementation that
        // derives the snip window from one cursor.
        let mut i = inst();
        i.apply(Gesture::PullLeft { steps: 40, velocity: 0.5 });
        i.apply(Gesture::PullRight { steps: 7, velocity: 0.5 });
        i.apply(Gesture::Zip { closing_speed: 0.8 });
        i.tick(4.0);
        let heard = i.drain_notes();
        i.apply(Gesture::Mount);
        let n = i.mesh().unwrap().n;
        let out = i.apply(Gesture::Snip { near: 0, far: n });
        let cap = match out {
            Outcome::Captured(c) => c,
            other => panic!("expected a capture, got {other:?}"),
        };
        let again = i.render_capture(&cap);
        assert_eq!(again, heard[..again.len()].to_vec());
    }

    #[test]
    fn captures_may_overlap_because_the_cut_is_virtual() {
        // Spec conformance item 16.
        let mut i = zipped();
        i.tick(6.0);
        i.apply(Gesture::Mount);
        let n = i.mesh().unwrap().n.min(40);
        let a = i.apply(Gesture::Snip { near: 0, far: n });
        let b = i.apply(Gesture::Snip { near: n / 4, far: n });
        let c = i.apply(Gesture::Snip { near: 0, far: n });
        for o in [&a, &b, &c] {
            assert!(matches!(o, Outcome::Captured(_)), "{o:?}");
        }
        assert_eq!(i.captures().len(), 3);
        assert_eq!(i.mesh().unwrap().n >= n, true, "the band is undisturbed");
    }

    #[test]
    fn a_capture_carries_its_envelope() {
        let mut i = zipped();
        i.set_maps(PitchMap::WholeTone, DurationMap::Linear, 60);
        i.tick(3.0);
        i.apply(Gesture::Mount);
        let n = i.mesh().unwrap().n.min(8);
        let cap = match i.apply(Gesture::Snip { near: 0, far: n }) {
            Outcome::Captured(c) => c,
            o => panic!("{o:?}"),
        };
        assert_eq!(cap.envelope.pitch_map, PitchMap::WholeTone);
        // Changing the maps afterwards must not change the capture.
        i.set_maps(PitchMap::Major, DurationMap::Fixed, 48);
        assert_eq!(cap.envelope.pitch_map, PitchMap::WholeTone);
    }

    #[test]
    fn snips_outside_the_mesh_are_refused() {
        let mut i = zipped();
        i.tick(1.0);
        i.apply(Gesture::Mount);
        let n = i.mesh().unwrap().n;
        assert_eq!(
            i.apply(Gesture::Snip { near: 0, far: n + 50 }),
            Outcome::Rejected(Rejection::OutsideMesh)
        );
        assert_eq!(
            i.apply(Gesture::Snip { near: 3, far: 3 }),
            Outcome::Rejected(Rejection::EmptySpan)
        );
    }

    #[test]
    fn silence_is_not_captured() {
        // Spec conformance item 18: a halt consumes no notches, so a capture
        // spanning it yields consecutive notes.
        let mut i = zipped();
        i.tick(2.0);
        let before = i.mesh().unwrap().n;
        i.apply(Gesture::Halt { on: true });
        i.tick(5.0); // three wall-clock seconds of silence
        assert_eq!(i.mesh().unwrap().n, before, "a halt consumes no notches");
        i.apply(Gesture::Halt { on: false });
        i.tick(2.0);
        i.apply(Gesture::Mount);
        let n = i.mesh().unwrap().n;
        let cap = match i.apply(Gesture::Snip { near: 0, far: n }) {
            Outcome::Captured(c) => c,
            o => panic!("{o:?}"),
        };
        assert_eq!(cap.notches, n);
        let notes = i.render_capture(&cap);
        // Performed silence adds no cells. Generated silence — the rest digit
        // of the pitch base — is a notch and is captured, so the test is the
        // cell count, not the absence of rests.
        assert_eq!(notes.len(), n, "the halt contributed no cells");
    }

    #[test]
    fn captures_are_auto_named_and_renameable() {
        let mut i = zipped();
        i.tick(2.0);
        i.apply(Gesture::Mount);
        let cap = match i.apply(Gesture::Snip { near: 0, far: 4 }) {
            Outcome::Captured(c) => c,
            o => panic!("{o:?}"),
        };
        assert_eq!(cap.name, "take-001");
        assert!(i.rename(cap.id, "moth"));
        assert_eq!(i.captures()[0].name, "moth");
    }

    #[test]
    fn a_run_yields_a_family_of_adjacent_or_overlapping_terms() {
        let mut i = zipped();
        i.tick(5.0);
        i.apply(Gesture::Mount);
        let n = i.mesh().unwrap().n.min(30);
        let a = match i.apply(Gesture::Snip { near: 0, far: n / 2 }) {
            Outcome::Captured(c) => c,
            o => panic!("{o:?}"),
        };
        let b = match i.apply(Gesture::Snip { near: n / 2, far: n }) {
            Outcome::Captured(c) => c,
            o => panic!("{o:?}"),
        };
        // Adjacency is visible in the syntax rather than stored in a table.
        if let (Tune::Snip { i_l: al, n: an, .. }, Tune::Snip { i_l: bl, .. }) =
            (&a.term, &b.term)
        {
            assert_eq!(al + an, *bl);
        } else {
            panic!("captures should be Snip leaves");
        }
    }
}
