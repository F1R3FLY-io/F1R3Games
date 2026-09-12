//! Performance traces.
//!
//! Spec §8. The engine records a trace for every session without being asked.
//! Because the streams are deterministic and the state machine is total, the
//! trace replays the session exactly, so no audio is stored.
//!
//! Recording by default is safe because M's back-end data is guarded by her
//! private key: nothing becomes visible to anyone else without an explicit
//! publishing action, which is never a side effect of capture or of any
//! gesture.

use serde::{Deserialize, Serialize};
use skein_spigot::SpigotConfig;

use crate::envelope::{DurationMap, PitchMap};
use crate::gesture::Gesture;

/// The opening declaration of a trace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceHeader {
    pub left: SpigotConfig,
    pub right: SpigotConfig,
    pub pitch_map: PitchMap,
    pub duration_map: DurationMap,
    pub root: u8,
    pub instrument: u8,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TraceEvent {
    /// A gesture, with the raw metrics that produced it where available. The
    /// spec asks for these because the thresholds are guesses and the corpus
    /// they will be tuned against does not exist yet.
    Gesture {
        t_ms: u64,
        gesture: Gesture,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metrics: Option<serde_json::Value>,
    },
    /// A capture taken during the session, so a performance resolves to the
    /// tunes harvested from it and each tune resolves back to its performance.
    Capture { t_ms: u64, id: u64, near: usize, far: usize },
    /// A map or instrument change, which alters interpretation from here on.
    Interpretation {
        t_ms: u64,
        pitch_map: PitchMap,
        duration_map: DurationMap,
        root: u8,
        instrument: u8,
    },
    /// The wave stopping of its own accord.
    Exhausted { t_ms: u64, at_notch: usize },
}

impl TraceEvent {
    pub fn t_ms(&self) -> u64 {
        match self {
            TraceEvent::Gesture { t_ms, .. }
            | TraceEvent::Capture { t_ms, .. }
            | TraceEvent::Interpretation { t_ms, .. }
            | TraceEvent::Exhausted { t_ms, .. } => *t_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trace {
    pub header: TraceHeader,
    pub events: Vec<TraceEvent>,
    pub ended_at_ms: Option<u64>,
}

impl Trace {
    pub fn new(header: TraceHeader) -> Self {
        Trace { header, events: Vec::new(), ended_at_ms: None }
    }

    /// Timestamps must be monotonic: a replay depends on it.
    pub fn push(&mut self, e: TraceEvent) {
        debug_assert!(
            self.events.last().map(|l| l.t_ms() <= e.t_ms()).unwrap_or(true),
            "trace timestamps must be monotonic"
        );
        self.events.push(e);
    }

    pub fn gesture(&mut self, t_ms: u64, g: Gesture) {
        self.push(TraceEvent::Gesture { t_ms, gesture: g, metrics: None });
    }

    pub fn end(&mut self, t_ms: u64) {
        self.ended_at_ms = Some(t_ms);
    }

    pub fn duration_ms(&self) -> u64 {
        self.ended_at_ms
            .unwrap_or_else(|| self.events.last().map(|e| e.t_ms()).unwrap_or(0))
            .saturating_sub(self.header.started_at_ms)
    }

    /// The gestures in order, which is what a replay consumes.
    pub fn gestures(&self) -> Vec<(u64, Gesture)> {
        self.events
            .iter()
            .filter_map(|e| match e {
                TraceEvent::Gesture { t_ms, gesture, .. } => Some((*t_ms, *gesture)),
                _ => None,
            })
            .collect()
    }

    /// Captures taken during this performance.
    pub fn capture_ids(&self) -> Vec<u64> {
        self.events
            .iter()
            .filter_map(|e| match e {
                TraceEvent::Capture { id, .. } => Some(*id),
                _ => None,
            })
            .collect()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("trace serialises")
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skein_spigot::Constant;

    fn header() -> TraceHeader {
        TraceHeader {
            left: SpigotConfig::new(Constant::Pi, 22).unwrap(),
            right: SpigotConfig::new(Constant::E, 5).unwrap(),
            pitch_map: PitchMap::PentatonicMinor,
            duration_map: DurationMap::Musical,
            root: 57,
            instrument: 0,
            started_at_ms: 1000,
        }
    }

    #[test]
    fn a_trace_round_trips() {
        let mut t = Trace::new(header());
        t.gesture(1100, Gesture::Zip { closing_speed: 0.6 });
        t.gesture(4000, Gesture::Halt { on: true });
        t.push(TraceEvent::Capture { t_ms: 5000, id: 1, near: 0, far: 32 });
        t.end(6000);
        let back = Trace::from_json(&t.to_json()).unwrap();
        assert_eq!(back, t);
        assert_eq!(back.duration_ms(), 5000);
    }

    #[test]
    fn a_performance_resolves_to_its_captures() {
        let mut t = Trace::new(header());
        t.push(TraceEvent::Capture { t_ms: 2000, id: 7, near: 0, far: 8 });
        t.push(TraceEvent::Capture { t_ms: 3000, id: 9, near: 4, far: 12 });
        assert_eq!(t.capture_ids(), vec![7, 9]);
    }

    #[test]
    fn gestures_come_back_in_order() {
        let mut t = Trace::new(header());
        t.gesture(1100, Gesture::Zip { closing_speed: 0.6 });
        t.push(TraceEvent::Exhausted { t_ms: 1200, at_notch: 1024 });
        t.gesture(1300, Gesture::Unzip);
        let gs = t.gestures();
        assert_eq!(gs.len(), 2);
        assert!(gs[0].0 < gs[1].0);
    }
}
