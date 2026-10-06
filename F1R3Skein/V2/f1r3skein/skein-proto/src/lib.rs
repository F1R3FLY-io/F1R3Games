//! Wire protocol, version 4.
//!
//! Spec §9. Newline-delimited JSON, one object per line, every message
//! carrying `type` and `"v": 4`. Both sides serialise through `serde` /
//! `Codable`; neither constructs JSON by string interpolation, which is how
//! the previous client produced malformed messages for any name containing a
//! backslash.
//!
//! The protocol is defined over an abstract bidirectional channel. In S1 that
//! is a TCP stream; in S2 a pair of FFI ring buffers. Nothing else in the
//! system distinguishes them.

use serde::{Deserialize, Serialize};
use skein_core::calib::Calibration;
use skein_core::envelope::{DurationMap, Note, PitchMap};
use skein_core::gesture::Frame;
use skein_core::state::{Mode, Rejection, StopReason};
use skein_core::term::Tune;
use skein_spigot::SpigotConfig;

pub const PROTOCOL_VERSION: u32 = 4;

fn v() -> u32 {
    PROTOCOL_VERSION
}

// ------------------------------------------------------------ client → engine

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Raw samples. Detection runs in the engine so that S1 and S2 share one
    /// implementation and the detectors stay unit-testable.
    Frame {
        #[serde(default = "v")]
        v: u32,
        frame: Frame,
    },
    /// A gesture the client resolved itself — the panel equivalents that the
    /// spec requires for accessibility, and the debug overlay's controls.
    Gesture {
        #[serde(default = "v")]
        v: u32,
        gesture: skein_core::gesture::Gesture,
    },
    Configure {
        #[serde(default = "v")]
        v: u32,
        left: Option<SpigotConfig>,
        right: Option<SpigotConfig>,
        pitch_map: Option<PitchMap>,
        duration_map: Option<DurationMap>,
        root: Option<u8>,
        instrument: Option<u8>,
    },
    /// Reload the calibration profile without a rebuild.
    Calibrate {
        #[serde(default = "v")]
        v: u32,
        calibration: Calibration,
    },
    Rename {
        #[serde(default = "v")]
        v: u32,
        id: u64,
        name: String,
    },
    Quit {
        #[serde(default = "v")]
        v: u32,
    },
}

// ------------------------------------------------------------ engine → client

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZipStateMsg {
    pub zipped: bool,
    pub front: usize,
    pub running: bool,
    pub tempo: u32,
    pub budget_left: usize,
    /// Distinguishes `halt`, `mount` and `exhausted`. The wave can end without
    /// a gesture, and a run that stops mid-phrase with no explanation reads as
    /// a crash.
    pub stopped_by: Option<StopReason>,
    /// True once the budget is close enough to warrant an approach signal.
    pub warning: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineMsg {
    Digits {
        #[serde(default = "v")]
        v: u32,
        left: Vec<u8>,
        right: Vec<u8>,
        left_pos: usize,
        right_pos: usize,
        /// Each ribbon's own base. The client colours and labels against it;
        /// assuming a shared base makes a base-5 ribbon and a base-16 ribbon
        /// indistinguishable.
        left_base: u32,
        right_base: u32,
    },
    Note {
        #[serde(default = "v")]
        v: u32,
        note: Note,
        notch_index: usize,
    },
    ZipState {
        #[serde(default = "v")]
        v: u32,
        #[serde(flatten)]
        state: ZipStateMsg,
    },
    SnipAck {
        #[serde(default = "v")]
        v: u32,
        id: u64,
        name: String,
        count: usize,
        i_left: usize,
        i_right: usize,
        term: Tune,
    },
    State {
        #[serde(default = "v")]
        v: u32,
        mode: Mode,
        looping: bool,
        left_label: String,
        right_label: String,
        pitch_map: PitchMap,
        duration_map: DurationMap,
        instrument: u8,
    },
    /// Advisory and human-readable only. Nothing in the client may parse it.
    Status {
        #[serde(default = "v")]
        v: u32,
        text: String,
    },
    Error {
        #[serde(default = "v")]
        v: u32,
        code: String,
        text: String,
    },
    Rejected {
        #[serde(default = "v")]
        v: u32,
        reason: Rejection,
    },
}

impl EngineMsg {
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).expect("engine message serialises");
        s.push('\n');
        s
    }
}

impl ClientMsg {
    pub fn parse(line: &str) -> Result<Self, String> {
        serde_json::from_str(line.trim()).map_err(|e| e.to_string())
    }

    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).expect("client message serialises");
        s.push('\n');
        s
    }

    pub fn version(&self) -> u32 {
        match self {
            ClientMsg::Frame { v, .. }
            | ClientMsg::Gesture { v, .. }
            | ClientMsg::Configure { v, .. }
            | ClientMsg::Calibrate { v, .. }
            | ClientMsg::Rename { v, .. }
            | ClientMsg::Quit { v } => *v,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skein_core::gesture::Gesture;

    #[test]
    fn gestures_round_trip() {
        let m = ClientMsg::Gesture {
            v: PROTOCOL_VERSION,
            gesture: Gesture::Snip { near: 3, far: 19 },
        };
        assert_eq!(ClientMsg::parse(&m.to_line()).unwrap(), m);
    }

    #[test]
    fn names_with_awkward_characters_survive() {
        // The previous client escaped only the double quote, so a backslash
        // produced malformed JSON the engine silently dropped.
        let m = ClientMsg::Rename {
            v: PROTOCOL_VERSION,
            id: 1,
            name: r#"back\slash "quoted" ♪"#.to_string(),
        };
        let back = ClientMsg::parse(&m.to_line()).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn zip_state_carries_a_reason() {
        let m = EngineMsg::ZipState {
            v: PROTOCOL_VERSION,
            state: ZipStateMsg {
                zipped: true,
                front: 1024,
                running: false,
                tempo: 120,
                budget_left: 0,
                stopped_by: Some(StopReason::Exhausted),
                warning: true,
            },
        };
        let line = m.to_line();
        assert!(line.contains("exhausted"));
        assert!(line.contains("\"v\":4"));
    }

    #[test]
    fn unknown_versions_are_visible() {
        let line = r#"{"type":"quit","v":99}"#;
        assert_eq!(ClientMsg::parse(line).unwrap().version(), 99);
    }

    #[test]
    fn malformed_lines_are_errors_not_panics() {
        assert!(ClientMsg::parse("{not json").is_err());
    }
}
