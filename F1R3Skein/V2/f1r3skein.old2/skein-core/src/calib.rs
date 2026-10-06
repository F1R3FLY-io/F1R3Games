//! The calibration profile.
//!
//! Spec §6.12: every threshold lives here, loaded at launch and reloadable
//! without a rebuild. No detection constant may be hardcoded in a recogniser.
//! The reason is blunt — the thresholds are guesses, one of them was provably
//! unreachable in the previous implementation, and there is no corpus yet to
//! tune them against.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PullCalib {
    /// Minimum speed toward M, metres per second.
    pub velocity_min: f32,
    /// Speed divided by this gives the step count.
    pub step_divisor: f32,
    /// Minimum interval between firings, seconds.
    pub cooldown: f64,
}

impl Default for PullCalib {
    fn default() -> Self {
        PullCalib { velocity_min: 0.25, step_divisor: 0.15, cooldown: 0.08 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ZipCalib {
    /// Hands-together distance, metres.
    pub distance: f32,
    /// Hands-apart distance, metres. Strictly greater than `distance`.
    pub unzip_distance: f32,
    /// Window over which closing speed is measured, seconds. Measured
    /// *before* the threshold is crossed, not at the crossing frame, or the
    /// tempo is noisy.
    pub closing_window: f64,
    /// Slowest closing that still registers, metres per second.
    pub closing_min: f32,
    /// Fastest closing that still registers.
    pub closing_max: f32,
    /// Tempo range the closing speed maps onto.
    pub tempo_min_bpm: u32,
    pub tempo_max_bpm: u32,
    /// Wave budget in notches. Spec §6.3: a generous looper phrase.
    pub frontier_max: usize,
    /// Fraction of the budget remaining when the approach signal begins.
    pub frontier_warn: f32,
}

impl Default for ZipCalib {
    fn default() -> Self {
        ZipCalib {
            distance: 0.10,
            unzip_distance: 0.22,
            closing_window: 0.30,
            closing_min: 0.10,
            closing_max: 1.20,
            tempo_min_bpm: 50,
            tempo_max_bpm: 200,
            // ~1000 notches: a two-minute phrase at eight notes per second,
            // which is the order of a generous looper take.
            frontier_max: 1024,
            frontier_warn: 0.15,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TwistCalib {
    pub height_delta: f32,
    pub hold_frames: u32,
}

impl Default for TwistCalib {
    fn default() -> Self {
        TwistCalib { height_delta: 0.06, hold_frames: 8 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HaltCalib {
    /// Head roll at which the gesture fires, radians.
    pub roll_fire: f32,
    /// Roll below which it re-arms, radians. Strictly less than `roll_fire`.
    pub roll_rearm: f32,
    /// Hold required before firing, seconds.
    pub hold: f64,
}

impl Default for HaltCalib {
    fn default() -> Self {
        HaltCalib {
            roll_fire: 15.0_f32.to_radians(),
            roll_rearm: 6.0_f32.to_radians(),
            hold: 0.25,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScissorsCalib {
    /// Extension floor for index and middle, as a fraction of straight.
    pub extended: f32,
    /// Curl ceiling for ring and little, as a fraction of straight.
    pub curled: f32,
    /// Spread angle between index and middle, radians.
    pub spread: f32,
    pub hold_frames: u32,
    pub cooldown: f64,
}

impl Default for ScissorsCalib {
    /// `extended` and `curled` are expressed against a *scale-invariant*
    /// metric — the interior angle at the proximal interphalangeal joint,
    /// divided by pi. The previous implementation divided a tip-to-metacarpal
    /// distance by a fixed 0.08 m, which made detection depend on hand size
    /// and put the curl threshold out of reach entirely.
    fn default() -> Self {
        ScissorsCalib {
            extended: 0.80,
            curled: 0.55,
            spread: 0.40,
            hold_frames: 5,
            cooldown: 0.60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LoopCalib {
    /// Trajectory window, seconds.
    pub window: f64,
    /// Minimum mean radius of the circle, metres.
    pub min_radius: f32,
    /// Maximum ratio of radius standard deviation to mean radius.
    pub radius_variance: f32,
    /// Maximum out-of-plane residual, as a fraction of mean radius.
    pub plane_residual: f32,
    pub cooldown: f64,
}

impl Default for LoopCalib {
    fn default() -> Self {
        LoopCalib {
            window: 1.4,
            min_radius: 0.04,
            radius_variance: 0.35,
            plane_residual: 0.30,
            cooldown: 0.80,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MountCalib {
    /// Radius around the mount fixture within which a hand counts as at it.
    pub radius: f32,
    pub hold_frames: u32,
    pub cooldown: f64,
}

impl Default for MountCalib {
    fn default() -> Self {
        MountCalib { radius: 0.12, hold_frames: 6, cooldown: 0.50 }
    }
}

/// The whole profile.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Calibration {
    pub pull: PullCalib,
    pub zip: ZipCalib,
    pub twist: TwistCalib,
    pub halt: HaltCalib,
    pub scissors: ScissorsCalib,
    pub loop_: LoopCalib,
    pub mount: MountCalib,
}

impl Calibration {
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("calibration serialises")
    }

    /// Internal consistency. Violations are configuration errors, not runtime
    /// conditions, so they are surfaced at load.
    pub fn validate(&self) -> Result<(), String> {
        if self.zip.unzip_distance <= self.zip.distance {
            return Err("zip.unzip_distance must exceed zip.distance".into());
        }
        if self.halt.roll_rearm >= self.halt.roll_fire {
            return Err("halt.roll_rearm must be below halt.roll_fire".into());
        }
        if self.zip.tempo_min_bpm >= self.zip.tempo_max_bpm {
            return Err("zip tempo range is inverted".into());
        }
        if self.zip.frontier_max == 0 {
            return Err("zip.frontier_max must be positive".into());
        }
        Ok(())
    }

    /// Closing speed to tempo, clamped to the configured range.
    pub fn tempo_for(&self, closing_speed: f32) -> u32 {
        let z = &self.zip;
        let t = ((closing_speed - z.closing_min) / (z.closing_max - z.closing_min))
            .clamp(0.0, 1.0);
        let lo = z.tempo_min_bpm as f32;
        let hi = z.tempo_max_bpm as f32;
        (lo + t * (hi - lo)).round() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        assert!(Calibration::default().validate().is_ok());
    }

    #[test]
    fn inverted_zip_distances_are_rejected() {
        let mut c = Calibration::default();
        c.zip.unzip_distance = 0.05;
        assert!(c.validate().is_err());
    }

    #[test]
    fn halt_hysteresis_must_be_ordered() {
        let mut c = Calibration::default();
        c.halt.roll_rearm = c.halt.roll_fire;
        assert!(c.validate().is_err());
    }

    #[test]
    fn tempo_mapping_is_monotone_and_clamped() {
        let c = Calibration::default();
        assert_eq!(c.tempo_for(0.0), c.zip.tempo_min_bpm);
        assert_eq!(c.tempo_for(99.0), c.zip.tempo_max_bpm);
        assert!(c.tempo_for(0.6) > c.tempo_for(0.3));
    }

    #[test]
    fn profile_round_trips() {
        let c = Calibration::default();
        assert_eq!(Calibration::from_json(&c.to_json()).unwrap(), c);
    }

    #[test]
    fn partial_json_keeps_defaults() {
        let c = Calibration::from_json(r#"{"zip":{"frontier_max":32}}"#).unwrap();
        assert_eq!(c.zip.frontier_max, 32);
        assert_eq!(c.zip.distance, ZipCalib::default().distance);
    }
}
