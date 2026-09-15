//! Gesture detection.
//!
//! Spec §6.11 requires three kinds of detector, drawing on three input
//! sources. Only the first existed in the previous implementation:
//!
//! | kind          | source      | gestures                                     |
//! |---------------|-------------|----------------------------------------------|
//! | per-frame pose| hand anchor | pull, twist, zip, unzip, mount, unmount, snip |
//! | trajectory    | hand anchor | loop                                          |
//! | device pose   | head anchor | halt                                          |
//!
//! These live in Rust rather than in the client so that they can be tested
//! against synthetic traces, and so that S1 and S2 share one implementation.
//! The client's job is to sample ARKit and hand the samples over.
//!
//! Axes are M's, as in the spec: x is left-right, y is up-down, z is depth
//! away from M. So a pull is motion in *decreasing* z.

use serde::{Deserialize, Serialize};

use crate::calib::Calibration;
use crate::state::Mode;

// ------------------------------------------------------------------- geometry

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };

    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Vec3 { x, y, z }
    }
    pub fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    pub fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    pub fn scale(self, k: f32) -> Vec3 {
        Vec3::new(self.x * k, self.y * k, self.z * k)
    }
    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn len(self) -> f32 {
        self.dot(self).sqrt()
    }
    pub fn dist(self, o: Vec3) -> f32 {
        self.sub(o).len()
    }
    pub fn norm(self) -> Vec3 {
        let l = self.len();
        if l < 1e-9 {
            Vec3::ZERO
        } else {
            self.scale(1.0 / l)
        }
    }
}

/// Angle between two vectors, radians.
fn angle_between(a: Vec3, b: Vec3) -> f32 {
    let d = a.norm().dot(b.norm()).clamp(-1.0, 1.0);
    d.acos()
}

// --------------------------------------------------------------------- samples

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chirality {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Finger {
    Index,
    Middle,
    Ring,
    Little,
}

/// The four joints of one finger that the detectors need.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FingerJoints {
    /// Metacarpophalangeal — the knuckle.
    pub knuckle: Vec3,
    /// Proximal interphalangeal.
    pub pip: Vec3,
    /// Distal interphalangeal.
    pub dip: Vec3,
    pub tip: Vec3,
}

impl FingerJoints {
    /// **Scale-invariant** straightness in `[0, 1]`: the interior angle at the
    /// PIP joint divided by pi. One is fully straight, zero fully folded.
    ///
    /// This replaces the metric that made scissors unreachable. The old one
    /// divided a tip-to-metacarpal distance by a fixed 0.08 m, so a curled
    /// adult ring finger scored 0.75–1.0 against a threshold of 0.30, and the
    /// guard rejected every candidate pose. An angle involves no lengths, so
    /// it does not depend on hand size.
    pub fn straightness(&self) -> f32 {
        let a = self.knuckle.sub(self.pip);
        let b = self.dip.sub(self.pip);
        if a.len() < 1e-6 || b.len() < 1e-6 {
            return 1.0;
        }
        angle_between(a, b) / std::f32::consts::PI
    }

    /// Direction the finger points, knuckle to tip.
    pub fn direction(&self) -> Vec3 {
        self.tip.sub(self.knuckle).norm()
    }
}

/// One hand at one instant.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HandSample {
    pub chirality: Chirality,
    pub t: f64,
    pub wrist: Vec3,
    pub index: FingerJoints,
    pub middle: FingerJoints,
    pub ring: FingerJoints,
    pub little: FingerJoints,
}

impl HandSample {
    pub fn finger(&self, f: Finger) -> &FingerJoints {
        match f {
            Finger::Index => &self.index,
            Finger::Middle => &self.middle,
            Finger::Ring => &self.ring,
            Finger::Little => &self.little,
        }
    }
}

/// The head at one instant. Only roll is used: yaw is in constant use as M
/// looks between tray, spools and front, and pitch is what people do to keep
/// time.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HeadSample {
    pub t: f64,
    /// Roll in radians. Positive is one direction, negative the other; which
    /// is which is a client convention, and the sign selects halt or resume.
    pub roll: f32,
}

/// A frame of input.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub t: f64,
    pub left: Option<HandSample>,
    pub right: Option<HandSample>,
    pub head: Option<HeadSample>,
}

// -------------------------------------------------------------------- gestures

/// A recognised gesture. These are exactly the ten of spec §6.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "gesture", rename_all = "snake_case")]
pub enum Gesture {
    PullLeft { steps: u32, velocity: f32 },
    PullRight { steps: u32, velocity: f32 },
    Twist,
    Zip { closing_speed: f32 },
    Unzip,
    /// `on = true` halts, `on = false` resumes. Set and clear, never a toggle:
    /// on a noisy detector a missed fire and a double fire are
    /// indistinguishable to M, and she corrects by tilting again.
    Halt { on: bool },
    Mount,
    Unmount,
    Loop { on: bool },
    /// Notch offsets from the near end of the mesh.
    Snip { near: usize, far: usize },
}

// ------------------------------------------------------------- the trajectory

/// Ring buffer of fingertip positions, for the loop detector.
#[derive(Debug, Clone, Default)]
struct Trajectory {
    pts: Vec<(f64, Vec3)>,
}

impl Trajectory {
    fn push(&mut self, t: f64, p: Vec3, window: f64) {
        self.pts.push((t, p));
        let cutoff = t - window;
        self.pts.retain(|(ts, _)| *ts >= cutoff);
    }

    fn clear(&mut self) {
        self.pts.clear();
    }

    /// Total signed sweep about the centroid, in radians, together with the
    /// circularity diagnostics. Returns `None` when the window is too short.
    ///
    /// The plane is found from the discrete area vector — the sum of cross
    /// products of successive spokes — whose direction is the plane normal and
    /// whose sign gives the direction of rotation. That is cheaper than an
    /// eigendecomposition and gives the rotation sense for free, which is what
    /// distinguishes loop-set from loop-clear.
    fn sweep(&self) -> Option<Sweep> {
        if self.pts.len() < 12 {
            return None;
        }
        let n = self.pts.len() as f32;
        let mut c = Vec3::ZERO;
        for (_, p) in &self.pts {
            c = c.add(*p);
        }
        let c = c.scale(1.0 / n);

        let spokes: Vec<Vec3> = self.pts.iter().map(|(_, p)| p.sub(c)).collect();

        // The plane basis must NOT be derived from the signed area vector.
        // Doing so flips the basis with the direction of travel, so the
        // accumulated sweep comes out positive whichever way M circles — which
        // would silently destroy the set/clear distinction. Build the basis
        // from the data instead, and the sign of the sweep is then real.
        let u = spokes[0].norm();
        if u.len() < 1e-6 {
            return None;
        }
        let mut v = Vec3::ZERO;
        let mut best = 0.0f32;
        for s in &spokes {
            let perp = s.sub(u.scale(s.dot(u)));
            let l = perp.len();
            if l > best {
                best = l;
                v = perp;
            }
        }
        let v = v.norm();
        if v.len() < 1e-6 {
            return None;
        }
        let mut normal = u.cross(v).norm();
        if normal.len() < 1e-6 {
            return None;
        }
        // "Clockwise" is only meaningful relative to a viewpoint, and the
        // viewpoint here is M's. In her frame x is right, y is up and z is
        // depth away from her, so x cross y is +z, pointing away. Measuring
        // angles in a basis whose normal points away from her therefore makes
        // a positive sweep mean counter-clockwise *as she sees it*. Without
        // this the sign depends on which spoke happened to define the basis,
        // and set and clear become indistinguishable.
        let mut flip = false;
        if normal.dot(c) < 0.0 {
            normal = normal.scale(-1.0);
            flip = true;
        }

        let radii: Vec<f32> = spokes.iter().map(|s| s.len()).collect();
        let mean_r = radii.iter().sum::<f32>() / n;
        if mean_r < 1e-6 {
            return None;
        }
        let var = radii.iter().map(|r| (r - mean_r).powi(2)).sum::<f32>() / n;
        let radius_cv = var.sqrt() / mean_r;

        let residual =
            spokes.iter().map(|s| s.dot(normal).abs()).sum::<f32>() / n / mean_r;

        let mut total = 0.0f32;
        for w in spokes.windows(2) {
            let a = (w[0].dot(v)).atan2(w[0].dot(u));
            let b = (w[1].dot(v)).atan2(w[1].dot(u));
            let mut d = b - a;
            while d > std::f32::consts::PI {
                d -= 2.0 * std::f32::consts::PI;
            }
            while d < -std::f32::consts::PI {
                d += 2.0 * std::f32::consts::PI;
            }
            total += d;
        }

        if flip {
            total = -total;
        }
        Some(Sweep { total, mean_radius: mean_r, radius_cv, residual })
    }
}

#[derive(Debug, Clone, Copy)]
struct Sweep {
    total: f32,
    mean_radius: f32,
    radius_cv: f32,
    residual: f32,
}

// ------------------------------------------------------------- the recogniser

/// Where the mount fixture sits in M's space. Between the ribbons, just in
/// front of the hands.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MountPoint {
    pub position: Vec3,
}

impl Default for MountPoint {
    /// Spec axes: x right, y up, z away from M. Just in front of the hands and
    /// a little below them, between the ribbons. The client converts from
    /// ARKit's frame (whose forward is -z) when sampling, so this needs no
    /// adjustment there.
    fn default() -> Self {
        MountPoint { position: Vec3::new(0.0, 1.15, 0.35) }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct HandTrack {
    prev: Option<(f64, Vec3)>,
    last_pull: f64,
}

/// Turns frames into gestures, respecting the mode.
///
/// **The mode gate is not an optimisation.** Travelling a hand along z to
/// bracket a cut is indistinguishable from a pull; the two never collide only
/// because pull does not exist in meta play.
#[derive(Debug, Clone)]
pub struct Recogniser {
    calib: Calibration,
    mount: MountPoint,
    mode: Mode,

    left: HandTrack,
    right: HandTrack,

    zipped: bool,
    separation_window: Vec<(f64, f32)>,

    twist_frames: u32,
    scissors_frames: u32,
    last_scissors: f64,
    mount_frames: u32,
    last_mount: f64,

    traj: Trajectory,
    last_loop: f64,
    loop_on: bool,

    roll_armed: bool,
    roll_since: Option<(f64, f32)>,
    halted: bool,

    /// Length of the mesh in notches, needed to convert a snip's hand
    /// positions into notch offsets. Fed back from the state machine.
    mesh_len: usize,
    /// Extent of the meshed band along z, metres, for the same conversion.
    band_near_z: f32,
    band_far_z: f32,
}

impl Recogniser {
    pub fn new(calib: Calibration, mount: MountPoint) -> Self {
        Recogniser {
            calib,
            mount,
            mode: Mode::Play,
            left: HandTrack::default(),
            right: HandTrack::default(),
            zipped: false,
            separation_window: Vec::new(),
            twist_frames: 0,
            scissors_frames: 0,
            last_scissors: f64::NEG_INFINITY,
            mount_frames: 0,
            last_mount: f64::NEG_INFINITY,
            traj: Trajectory::default(),
            last_loop: f64::NEG_INFINITY,
            loop_on: false,
            roll_armed: true,
            roll_since: None,
            halted: false,
            mesh_len: 0,
            band_near_z: 0.45,
            band_far_z: 1.60,
        }
    }

    pub fn calibration(&self) -> &Calibration {
        &self.calib
    }

    /// Reload the profile without a rebuild.
    pub fn set_calibration(&mut self, c: Calibration) {
        self.calib = c;
    }

    /// The state machine tells the recogniser what it needs for the snip
    /// conversion and the mode gate.
    pub fn sync(&mut self, mode: Mode, zipped: bool, mesh_len: usize, halted: bool) {
        self.mode = mode;
        self.zipped = zipped;
        self.mesh_len = mesh_len;
        self.halted = halted;
    }

    pub fn set_band_extent(&mut self, near_z: f32, far_z: f32) {
        self.band_near_z = near_z;
        self.band_far_z = far_z;
    }

    /// Consume one frame, emitting whatever fired.
    pub fn feed(&mut self, f: &Frame) -> Vec<Gesture> {
        let mut out = Vec::new();

        // Halt is available in play only, and is the one control that costs no
        // hands — which is why it is a head gesture.
        if self.mode == Mode::Play {
            if let Some(h) = f.head {
                if let Some(g) = self.head_roll(h) {
                    out.push(g);
                }
            }
        }

        match self.mode {
            Mode::Play => self.play_mode(f, &mut out),
            Mode::Meta => self.meta_mode(f, &mut out),
        }
        out
    }

    // ---------------------------------------------------------------- play

    fn play_mode(&mut self, f: &Frame, out: &mut Vec<Gesture>) {
        let (l, r) = match (f.left, f.right) {
            (Some(l), Some(r)) => (l, r),
            _ => {
                self.twist_frames = 0;
                return;
            }
        };

        let sep = l.wrist.dist(r.wrist);
        self.separation_window.push((f.t, sep));
        let cutoff = f.t - self.calib.zip.closing_window;
        self.separation_window.retain(|(t, _)| *t >= cutoff);

        // Zip and unzip.
        if !self.zipped && sep < self.calib.zip.distance {
            let speed = self.closing_speed();
            out.push(Gesture::Zip { closing_speed: speed });
            self.zipped = true;
            self.twist_frames = 0;
        } else if self.zipped && sep > self.calib.zip.unzip_distance {
            out.push(Gesture::Unzip);
            self.zipped = false;
        }

        // Mount: both hands at the fixture. Checked before pull so that
        // reaching for the clips is not read as playing.
        let at_mount = l.wrist.dist(self.mount.position) < self.calib.mount.radius
            && r.wrist.dist(self.mount.position) < self.calib.mount.radius;
        if at_mount {
            self.mount_frames += 1;
            if self.mount_frames >= self.calib.mount.hold_frames
                && f.t - self.last_mount > self.calib.mount.cooldown
            {
                self.last_mount = f.t;
                self.mount_frames = 0;
                out.push(Gesture::Mount);
                return;
            }
        } else {
            self.mount_frames = 0;
        }

        // Twist: requires the hands apart, so twist and zip are never
        // simultaneously satisfiable, and requires unzipped, because the mesh
        // has committed the pairing.
        if !self.zipped && sep > self.calib.zip.unzip_distance {
            let dy = (l.wrist.y - r.wrist.y).abs();
            if dy > self.calib.twist.height_delta {
                self.twist_frames += 1;
                if self.twist_frames == self.calib.twist.hold_frames {
                    out.push(Gesture::Twist);
                }
            } else {
                self.twist_frames = 0;
            }
        } else {
            self.twist_frames = 0;
        }

        // Pull: only while unzipped. Once meshed the ribbons are locked
        // together and the front, not the hands, advances the material.
        if !self.zipped {
            if let Some(g) = Self::pull(&mut self.left, &l, f.t, &self.calib) {
                out.push(g);
            }
            if let Some(g) = Self::pull(&mut self.right, &r, f.t, &self.calib) {
                out.push(g);
            }
        } else {
            self.left.prev = Some((f.t, l.wrist));
            self.right.prev = Some((f.t, r.wrist));
        }
    }

    fn pull(
        track: &mut HandTrack,
        h: &HandSample,
        t: f64,
        c: &Calibration,
    ) -> Option<Gesture> {
        let prev = track.prev.replace((t, h.wrist));
        let (pt, pp) = prev?;
        let dt = (t - pt) as f32;
        if dt <= 1e-4 {
            return None;
        }
        // Toward M is decreasing z.
        let toward = (pp.z - h.wrist.z) / dt;
        if toward < c.pull.velocity_min || t - track.last_pull < c.pull.cooldown {
            return None;
        }
        track.last_pull = t;
        let steps = ((toward / c.pull.step_divisor) as u32).max(1);
        let velocity = (toward / 1.2).min(1.0);
        Some(match h.chirality {
            Chirality::Left => Gesture::PullLeft { steps, velocity },
            Chirality::Right => Gesture::PullRight { steps, velocity },
        })
    }

    fn closing_speed(&self) -> f32 {
        // Measured over the window *before* the threshold was crossed.
        if self.separation_window.len() < 2 {
            return self.calib.zip.closing_min;
        }
        let (t0, s0) = self.separation_window[0];
        let (t1, s1) = *self.separation_window.last().unwrap();
        let dt = (t1 - t0) as f32;
        if dt <= 1e-4 {
            return self.calib.zip.closing_min;
        }
        ((s0 - s1) / dt).max(0.0)
    }

    // ---------------------------------------------------------------- meta

    fn meta_mode(&mut self, f: &Frame, out: &mut Vec<Gesture>) {
        let (l, r) = match (f.left, f.right) {
            (Some(l), Some(r)) => (l, r),
            _ => {
                self.scissors_frames = 0;
                self.traj.clear();
                return;
            }
        };

        // Unmount: both hands return to the fixture and take the ribbons back.
        let at_mount = l.wrist.dist(self.mount.position) < self.calib.mount.radius
            && r.wrist.dist(self.mount.position) < self.calib.mount.radius;
        if at_mount {
            self.mount_frames += 1;
            if self.mount_frames >= self.calib.mount.hold_frames
                && f.t - self.last_mount > self.calib.mount.cooldown
            {
                self.last_mount = f.t;
                self.mount_frames = 0;
                self.traj.clear();
                out.push(Gesture::Unmount);
                return;
            }
        } else {
            self.mount_frames = 0;
        }

        // Loop: a trajectory, not a pose. Direction of rotation gives set
        // against clear, matching halt, so a missed fire cannot invert state.
        self.traj.push(f.t, r.index.tip, self.calib.loop_.window);
        if f.t - self.last_loop > self.calib.loop_.cooldown {
            if let Some(s) = self.traj.sweep() {
                let full = s.total.abs() >= 2.0 * std::f32::consts::PI;
                let round = s.mean_radius >= self.calib.loop_.min_radius
                    && s.radius_cv <= self.calib.loop_.radius_variance
                    && s.residual <= self.calib.loop_.plane_residual;
                if full && round {
                    let on = s.total > 0.0;
                    if on != self.loop_on {
                        self.loop_on = on;
                        self.last_loop = f.t;
                        self.traj.clear();
                        out.push(Gesture::Loop { on });
                    }
                }
            }
        }

        // Snip: both hands, roles by z-ordering rather than chirality.
        if self.mesh_len > 0 && Self::is_scissors(&l, &self.calib)
            && Self::is_scissors(&r, &self.calib)
        {
            self.scissors_frames += 1;
            if self.scissors_frames >= self.calib.scissors.hold_frames
                && f.t - self.last_scissors > self.calib.scissors.cooldown
            {
                self.scissors_frames = 0;
                self.last_scissors = f.t;
                if let Some(g) = self.snip_from(&l, &r) {
                    out.push(g);
                }
            }
        } else {
            self.scissors_frames = 0;
        }
    }

    fn is_scissors(h: &HandSample, c: &Calibration) -> bool {
        let s = &c.scissors;
        if h.index.straightness() < s.extended || h.middle.straightness() < s.extended {
            return false;
        }
        if h.ring.straightness() > s.curled || h.little.straightness() > s.curled {
            return false;
        }
        angle_between(h.index.direction(), h.middle.direction()) > s.spread
    }

    /// Convert two hand positions into notch offsets. The near hand is the one
    /// at lower z — **not** the left hand. Either hand may be the near one,
    /// depending on how M reaches.
    fn snip_from(&self, l: &HandSample, r: &HandSample) -> Option<Gesture> {
        let (near_z, far_z) = {
            let a = l.wrist.z;
            let b = r.wrist.z;
            if a <= b {
                (a, b)
            } else {
                (b, a)
            }
        };
        let near = self.notch_at(near_z)?;
        let far = self.notch_at(far_z)?;
        if far <= near {
            return None;
        }
        Some(Gesture::Snip { near, far })
    }

    /// Both boundaries must lie inside the meshed span: bracketing unmeshed
    /// lead would capture two unpaired ribbons rather than a tune.
    fn notch_at(&self, z: f32) -> Option<usize> {
        if z < self.band_near_z || z > self.band_far_z {
            return None;
        }
        let span = self.band_far_z - self.band_near_z;
        if span <= 1e-6 {
            return None;
        }
        let frac = (z - self.band_near_z) / span;
        Some(((frac * self.mesh_len as f32).round() as usize).min(self.mesh_len))
    }

    // ---------------------------------------------------------------- head

    fn head_roll(&mut self, h: HeadSample) -> Option<Gesture> {
        let c = &self.calib.halt;
        let mag = h.roll.abs();

        if mag < c.roll_rearm {
            self.roll_armed = true;
            self.roll_since = None;
            return None;
        }
        if !self.roll_armed || mag < c.roll_fire {
            if mag < c.roll_fire {
                self.roll_since = None;
            }
            return None;
        }

        let started = match self.roll_since {
            Some((t0, sign)) if sign.signum() == h.roll.signum() => t0,
            _ => {
                self.roll_since = Some((h.t, h.roll));
                return None;
            }
        };
        if h.t - started < c.hold {
            return None;
        }

        self.roll_armed = false;
        self.roll_since = None;
        // Positive roll halts, negative resumes. Idempotent by design: a
        // repeat in the same direction is a no-op.
        let want_halt = h.roll > 0.0;
        if want_halt == self.halted {
            return None;
        }
        self.halted = want_halt;
        Some(Gesture::Halt { on: want_halt })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn straight(base: Vec3, dir: Vec3) -> FingerJoints {
        let d = dir.norm();
        FingerJoints {
            knuckle: base,
            pip: base.add(d.scale(0.035)),
            dip: base.add(d.scale(0.060)),
            tip: base.add(d.scale(0.080)),
        }
    }

    fn curled(base: Vec3, dir: Vec3) -> FingerJoints {
        let d = dir.norm();
        let pip = base.add(d.scale(0.035));
        // Fold back sharply at the PIP joint.
        FingerJoints {
            knuckle: base,
            pip,
            dip: pip.add(d.scale(-0.020)).add(Vec3::new(0.0, -0.012, 0.0)),
            tip: pip.add(d.scale(-0.035)).add(Vec3::new(0.0, -0.020, 0.0)),
        }
    }

    fn hand(ch: Chirality, t: f64, wrist: Vec3, scissors: bool, scale: f32) -> HandSample {
        let fwd = Vec3::new(0.0, 0.0, 1.0);
        let idx_dir = if scissors { Vec3::new(-0.35, 0.0, 1.0) } else { fwd };
        let mid_dir = if scissors { Vec3::new(0.35, 0.0, 1.0) } else { fwd };
        let mk = |b: Vec3, d: Vec3, s: bool| {
            let f = if s { straight(b, d) } else { curled(b, d) };
            // Scale the whole finger about its knuckle, to test invariance.
            FingerJoints {
                knuckle: f.knuckle,
                pip: f.knuckle.add(f.pip.sub(f.knuckle).scale(scale)),
                dip: f.knuckle.add(f.dip.sub(f.knuckle).scale(scale)),
                tip: f.knuckle.add(f.tip.sub(f.knuckle).scale(scale)),
            }
        };
        HandSample {
            chirality: ch,
            t,
            wrist,
            index: mk(wrist.add(Vec3::new(0.0, 0.02, 0.0)), idx_dir, true),
            middle: mk(wrist.add(Vec3::new(0.01, 0.02, 0.0)), mid_dir, true),
            ring: mk(wrist.add(Vec3::new(0.02, 0.02, 0.0)), fwd, !scissors),
            little: mk(wrist.add(Vec3::new(0.03, 0.02, 0.0)), fwd, !scissors),
        }
    }

    fn rec() -> Recogniser {
        Recogniser::new(Calibration::default(), MountPoint::default())
    }

    // ---- the curl metric ------------------------------------------------

    #[test]
    fn straightness_separates_extended_from_curled() {
        let s = straight(Vec3::ZERO, Vec3::new(0.0, 0.0, 1.0)).straightness();
        let c = curled(Vec3::ZERO, Vec3::new(0.0, 0.0, 1.0)).straightness();
        assert!(s > 0.9, "straight finger scored {s}");
        assert!(c < 0.5, "curled finger scored {c}");
    }

    #[test]
    fn straightness_is_scale_invariant() {
        // The defect being fixed: the old metric divided by a fixed 0.08 m, so
        // a small hand and a large hand scored differently for the same pose.
        let small = curled(Vec3::ZERO, Vec3::new(0.0, 0.0, 1.0));
        let scaled = FingerJoints {
            knuckle: small.knuckle,
            pip: small.pip.scale(2.0),
            dip: small.dip.scale(2.0),
            tip: small.tip.scale(2.0),
        };
        let a = small.straightness();
        let b = scaled.straightness();
        assert!((a - b).abs() < 1e-4, "{a} vs {b}");
    }

    #[test]
    fn scissors_actually_fires() {
        // The previous implementation could not reach this at all.
        let c = Calibration::default();
        let h = hand(Chirality::Right, 0.0, Vec3::new(0.0, 0.0, 1.0), true, 1.0);
        assert!(Recogniser::is_scissors(&h, &c));
        let flat = hand(Chirality::Right, 0.0, Vec3::new(0.0, 0.0, 1.0), false, 1.0);
        assert!(!Recogniser::is_scissors(&flat, &c));
    }

    #[test]
    fn scissors_fires_for_hands_of_different_size() {
        let c = Calibration::default();
        for scale in [0.7f32, 1.0, 1.4] {
            let h = hand(Chirality::Right, 0.0, Vec3::new(0.0, 0.0, 1.0), true, scale);
            assert!(Recogniser::is_scissors(&h, &c), "scale {scale}");
        }
    }

    // ---- halt -----------------------------------------------------------

    fn head_frame(t: f64, roll_deg: f32) -> Frame {
        Frame {
            t,
            left: None,
            right: None,
            head: Some(HeadSample { t, roll: roll_deg.to_radians() }),
        }
    }

    #[test]
    fn halt_fires_after_the_hold() {
        let mut r = rec();
        assert!(r.feed(&head_frame(0.0, 20.0)).is_empty(), "no instant fire");
        let out = r.feed(&head_frame(0.5, 20.0));
        assert_eq!(out, vec![Gesture::Halt { on: true }]);
    }

    #[test]
    fn halt_is_set_and_clear_not_toggle() {
        let mut r = rec();
        r.feed(&head_frame(0.0, 20.0));
        assert_eq!(r.feed(&head_frame(0.5, 20.0)), vec![Gesture::Halt { on: true }]);
        // Re-arm, then tilt the same way again: must be a no-op.
        r.feed(&head_frame(1.0, 0.0));
        r.feed(&head_frame(1.5, 20.0));
        assert!(r.feed(&head_frame(2.0, 20.0)).is_empty(), "repeat must not resume");
        // The other direction resumes.
        r.feed(&head_frame(2.5, 0.0));
        r.feed(&head_frame(3.0, -20.0));
        assert_eq!(r.feed(&head_frame(3.5, -20.0)), vec![Gesture::Halt { on: false }]);
    }

    #[test]
    fn halt_needs_rearm_between_firings() {
        let mut r = rec();
        r.feed(&head_frame(0.0, 20.0));
        r.feed(&head_frame(0.5, 20.0));
        // Without dropping below the re-arm angle, the opposite tilt is ignored.
        r.feed(&head_frame(1.0, -20.0));
        assert!(r.feed(&head_frame(1.5, -20.0)).is_empty());
    }

    #[test]
    fn small_leans_do_not_halt() {
        let mut r = rec();
        for i in 0..20 {
            let t = i as f64 * 0.05;
            assert!(r.feed(&head_frame(t, 8.0)).is_empty(), "8 degrees must not fire");
        }
    }

    // ---- the trajectory detector ---------------------------------------

    fn circle_frames(turns: f32, n: usize, clockwise: bool) -> Vec<Frame> {
        let mut out = Vec::new();
        for i in 0..n {
            let t = i as f64 * 0.02;
            let a = turns * 2.0 * std::f32::consts::PI * (i as f32 / n as f32);
            let a = if clockwise { -a } else { a };
            let p = Vec3::new(0.06 * a.cos(), 0.06 * a.sin(), 1.0);
            let mut h = hand(Chirality::Right, t, Vec3::new(0.0, 0.0, 1.0), false, 1.0);
            h.index.tip = p;
            let l = hand(Chirality::Left, t, Vec3::new(-0.4, 0.0, 1.0), false, 1.0);
            out.push(Frame { t, left: Some(l), right: Some(h), head: None });
        }
        out
    }

    #[test]
    fn loop_fires_on_a_full_circle() {
        let mut r = rec();
        r.sync(Mode::Meta, true, 64, false);
        let mut fired = None;
        for f in circle_frames(1.05, 70, false) {
            for g in r.feed(&f) {
                if let Gesture::Loop { on } = g {
                    fired = Some(on);
                }
            }
        }
        assert_eq!(fired, Some(true));
    }

    #[test]
    fn loop_direction_selects_set_or_clear() {
        let mut r = rec();
        r.sync(Mode::Meta, true, 64, false);
        for f in circle_frames(1.05, 70, false) {
            r.feed(&f);
        }
        assert!(r.loop_on);
        let mut cleared = false;
        for (i, mut f) in circle_frames(1.05, 70, true).into_iter().enumerate() {
            f.t += 3.0 + i as f64 * 0.0;
            for g in r.feed(&f) {
                if g == (Gesture::Loop { on: false }) {
                    cleared = true;
                }
            }
        }
        assert!(cleared, "opposite rotation must clear the loop");
    }

    #[test]
    fn a_straight_sweep_is_not_a_loop() {
        let mut r = rec();
        r.sync(Mode::Meta, true, 64, false);
        for i in 0..70 {
            let t = i as f64 * 0.02;
            let mut h = hand(Chirality::Right, t, Vec3::new(0.0, 0.0, 1.0), false, 1.0);
            h.index.tip = Vec3::new(0.004 * i as f32, 0.0, 1.0);
            let l = hand(Chirality::Left, t, Vec3::new(-0.4, 0.0, 1.0), false, 1.0);
            let f = Frame { t, left: Some(l), right: Some(h), head: None };
            for g in r.feed(&f) {
                assert!(!matches!(g, Gesture::Loop { .. }), "straight line fired loop");
            }
        }
    }

    // ---- the mode gate --------------------------------------------------

    #[test]
    fn pull_does_not_exist_in_meta() {
        // Bracketing a cut travels the hands along z, which is exactly a pull.
        // The two never collide only because of the mode gate.
        let mut r = rec();
        r.sync(Mode::Meta, true, 64, false);
        let mut saw_pull = false;
        for i in 0..20 {
            let t = i as f64 * 0.05;
            let z = 1.6 - 0.05 * i as f32;
            let l = hand(Chirality::Left, t, Vec3::new(-0.2, 0.0, z), true, 1.0);
            let rh = hand(Chirality::Right, t, Vec3::new(0.2, 0.0, z), true, 1.0);
            let f = Frame { t, left: Some(l), right: Some(rh), head: None };
            for g in r.feed(&f) {
                if matches!(g, Gesture::PullLeft { .. } | Gesture::PullRight { .. }) {
                    saw_pull = true;
                }
            }
        }
        assert!(!saw_pull, "pull must not fire in meta play");
    }

    #[test]
    fn pull_fires_in_play() {
        let mut r = rec();
        r.sync(Mode::Play, false, 0, false);
        let mut saw = false;
        for i in 0..20 {
            let t = i as f64 * 0.05;
            let z = 1.6 - 0.05 * i as f32;
            let l = hand(Chirality::Left, t, Vec3::new(-0.4, 0.0, z), false, 1.0);
            let rh = hand(Chirality::Right, t, Vec3::new(0.4, 0.0, 1.6), false, 1.0);
            let f = Frame { t, left: Some(l), right: Some(rh), head: None };
            for g in r.feed(&f) {
                if matches!(g, Gesture::PullLeft { .. }) {
                    saw = true;
                }
            }
        }
        assert!(saw, "pull must fire in play");
    }

    #[test]
    fn snip_roles_go_by_depth_not_chirality() {
        let mut r = rec();
        r.sync(Mode::Meta, true, 100, false);
        r.set_band_extent(0.45, 1.60);
        // Right hand nearer than left: the right is the near hand.
        let mut got = None;
        for i in 0..10 {
            let t = i as f64 * 0.05;
            let l = hand(Chirality::Left, t, Vec3::new(-0.1, 0.0, 1.30), true, 1.0);
            let rh = hand(Chirality::Right, t, Vec3::new(0.1, 0.0, 0.70), true, 1.0);
            let f = Frame { t, left: Some(l), right: Some(rh), head: None };
            for g in r.feed(&f) {
                if let Gesture::Snip { near, far } = g {
                    got = Some((near, far));
                }
            }
        }
        let (near, far) = got.expect("snip should fire");
        assert!(near < far, "near {near} far {far}");
        // z = 0.70 is about 22% along a band from 0.45 to 1.60.
        assert!((near as i64 - 22).abs() <= 2, "near was {near}");
        assert!((far as i64 - 74).abs() <= 2, "far was {far}");
    }

    #[test]
    fn zip_reports_a_closing_speed() {
        let mut r = rec();
        r.sync(Mode::Play, false, 0, false);
        let mut speed = None;
        for i in 0..12 {
            let t = i as f64 * 0.03;
            let sep = 0.40 - 0.03 * i as f32;
            let l = hand(Chirality::Left, t, Vec3::new(-sep / 2.0, 0.0, 1.0), false, 1.0);
            let rh = hand(Chirality::Right, t, Vec3::new(sep / 2.0, 0.0, 1.0), false, 1.0);
            let f = Frame { t, left: Some(l), right: Some(rh), head: None };
            for g in r.feed(&f) {
                if let Gesture::Zip { closing_speed } = g {
                    speed = Some(closing_speed);
                }
            }
        }
        let s = speed.expect("zip should fire");
        assert!(s > 0.5, "closing speed {s} should reflect a brisk close");
    }
}

