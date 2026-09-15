//! skein-core — the authoritative model of the F1R3Skein instrument.
//!
//! Specification: *The F1R3Skein Virtual Instrument*, revision 4.
//!
//! The crate is deliberately free of I/O, ARKit, audio and rendering. It holds
//! the term representation, the realisation rewrite, the instrument state
//! machine, and the gesture detectors. Two consequences:
//!
//! * the detectors are unit-testable against synthetic traces, which matters
//!   because every threshold in the spec is currently a guess and one of them
//!   was provably unreachable;
//! * configuration S1 (tethered) and S2 (on-device, over a C FFI) run the same
//!   code, so the client never becomes a second, divergent implementation.

pub mod calib;
pub mod envelope;
pub mod gesture;
pub mod state;
pub mod term;
pub mod trace;

pub use envelope::{DurationMap, Envelope, Note, PitchMap};
pub use state::{Instrument, Mode, Rejection, StopReason};
pub use term::{realise, Cell, Material, Skein, Tune};
