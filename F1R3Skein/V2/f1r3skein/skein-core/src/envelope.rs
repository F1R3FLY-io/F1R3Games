//! The envelope — interpretation, as opposed to material.
//!
//! Spec §7.4. The term says which digits and how they are paired; the envelope
//! says which pitch map, which duration map, which tempo and which instrument.
//! The envelope is copied into a tune at capture time, because the maps are
//! changeable during a session and the same term would otherwise sound
//! different later.
//!
//! Breeding operates on material and is therefore map-agnostic, which is what
//! is wanted when crossing two tunes made in different scales.

use serde::{Deserialize, Serialize};

use crate::term::{Cell, Material};

/// Pitch vocabularies required by the specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PitchMap {
    Major,
    Minor,
    PentatonicMajor,
    PentatonicMinor,
    Dorian,
    WholeTone,
    Chromatic,
}

impl PitchMap {
    fn degrees(&self) -> &'static [i32] {
        match self {
            PitchMap::Major => &[0, 2, 4, 5, 7, 9, 11],
            PitchMap::Minor => &[0, 2, 3, 5, 7, 8, 10],
            PitchMap::PentatonicMajor => &[0, 2, 4, 7, 9],
            PitchMap::PentatonicMinor => &[0, 3, 5, 7, 10],
            PitchMap::Dorian => &[0, 2, 3, 5, 7, 9, 10],
            PitchMap::WholeTone => &[0, 2, 4, 6, 8, 10],
            PitchMap::Chromatic => &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        }
    }

    /// Cardinality of one octave of this map. A stream's base *should* match
    /// a whole number of octaves of the map it drives; a mismatch produces a
    /// modular fold, which is legitimate but should be a choice.
    pub fn cardinality(&self) -> usize {
        self.degrees().len()
    }

    /// Index to MIDI note number, spreading across octaves above `root`.
    pub fn midi(&self, root: u8, index: u8) -> u8 {
        let d = self.degrees();
        let i = index as usize;
        let octave = (i / d.len()) as i32;
        let semis = d[i % d.len()] + 12 * octave;
        (root as i32 + semis).clamp(0, 127) as u8
    }
}

/// Duration vocabularies required by the specification. Values are in ticks at
/// 480 per quarter note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurationMap {
    Musical,
    Linear,
    Exponential,
    Fixed,
}

impl DurationMap {
    pub fn ticks(&self, index: u8) -> u32 {
        let i = index as u32;
        match self {
            // thirty-second, sixteenth, eighth, quarter, half
            DurationMap::Musical => [60u32, 120, 240, 480, 960][(i % 5) as usize],
            DurationMap::Linear => 120 + 120 * (i % 8),
            DurationMap::Exponential => 60u32.saturating_mul(1 << (i % 5)),
            DurationMap::Fixed => 240,
        }
    }
}

/// A realised note, ready for the sampler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    /// MIDI note number, or `None` for a silence.
    pub pitch: Option<u8>,
    pub ticks: u32,
    pub velocity: u8,
}

/// Everything that turns material into sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub pitch_map: PitchMap,
    pub duration_map: DurationMap,
    pub root: u8,
    /// Beats per minute. Set from the closing speed of M's hands at the zip
    /// that created the mesh, and fixed for that mesh's life.
    pub tempo_bpm: u32,
    /// General MIDI program number.
    pub instrument: u8,
    pub velocity: u8,
    /// Whether the pitch stream's top digit means silence.
    ///
    /// A pitch base is three octaves of a scale plus a rest, so
    /// `base = 3 * degrees + 1` and the highest value is the rest. This is
    /// **generated** silence: unlike the silence M places with a halt, it is a
    /// notch, so it is addressed, it breeds and it is captured for free.
    pub top_digit_is_rest: bool,
}

impl Default for Envelope {
    /// Defaults that PAIR with the default streams.
    ///
    /// The pitch stream is base 22, and `base = 3 * degrees + 1` makes that
    /// three octaves of a 7-degree scale plus a rest — so the map must be
    /// diatonic. Pairing a base-22 stream with a 5-degree map folds modulo 5
    /// and spreads the digits over four-plus octaves, which is legitimate but
    /// should be chosen rather than inherited from a default.
    fn default() -> Self {
        Envelope {
            pitch_map: PitchMap::Major,
            duration_map: DurationMap::Musical,
            root: 57, // A3
            tempo_bpm: 96,
            instrument: 0,
            velocity: 100,
            top_digit_is_rest: true,
        }
    }
}

impl Envelope {
    /// Render material under this interpretation.
    pub fn render(&self, m: &Material) -> Vec<Note> {
        let rest = if self.top_digit_is_rest && m.pitch_base > 0 {
            Some((m.pitch_base - 1) as u8)
        } else {
            None
        };
        m.cells
            .iter()
            .map(|c| match *c {
                // The rest is applied at render time, not in realisation, so
                // the term stays map-agnostic material: one tune can be
                // reinterpreted under another scale, and breeding inherits no
                // mapping decision.
                Cell::Sound { p, d } if Some(p) == rest => Note {
                    pitch: None,
                    ticks: self.duration_map.ticks(d),
                    velocity: 0,
                },
                Cell::Sound { p, d } => Note {
                    pitch: Some(self.pitch_map.midi(self.root, p)),
                    ticks: self.duration_map.ticks(d),
                    velocity: self.velocity,
                },
                Cell::Silence { d } => Note {
                    pitch: None,
                    ticks: self.duration_map.ticks(d),
                    velocity: 0,
                },
            })
            .collect()
    }

    /// Seconds per tick at this tempo, 480 ticks to the quarter note.
    pub fn seconds_per_tick(&self) -> f64 {
        60.0 / (self.tempo_bpm.max(1) as f64) / 480.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::term::Cell;

    fn mat(cells: Vec<Cell>) -> Material {
        Material { pitch_base: 22, dur_base: 5, cells }
    }

    #[test]
    fn the_defaults_pair() {
        // A default that does not pair with the default stream is how the
        // panel came to claim diatonic while the engine played pentatonic.
        let e = Envelope::default();
        assert_eq!(22, 3 * e.pitch_map.cardinality() as u32 + 1);
    }

    #[test]
    fn the_top_digit_is_a_rest() {
        let e = Envelope { pitch_map: PitchMap::PentatonicMinor, ..Default::default() };
        let m = Material {
            pitch_base: 16, dur_base: 5,
            cells: vec![Cell::Sound { p: 15, d: 2 }, Cell::Sound { p: 3, d: 2 }],
        };
        let notes = e.render(&m);
        assert_eq!(notes[0].pitch, None, "digit 15 of base 16 is the rest");
        assert!(notes[1].pitch.is_some());
        assert!(notes[0].ticks > 0, "a rest still takes its duration");
    }

    #[test]
    fn rests_can_be_turned_off() {
        let e = Envelope { top_digit_is_rest: false, ..Default::default() };
        let m = Material { pitch_base: 16, dur_base: 5,
                           cells: vec![Cell::Sound { p: 15, d: 1 }] };
        assert!(e.render(&m)[0].pitch.is_some());
    }

    #[test]
    fn the_musical_bases_pair_with_their_maps() {
        // base = 3 * degrees + 1
        for (base, map) in [
            (16u32, PitchMap::PentatonicMinor),
            (22, PitchMap::Major),
            (37, PitchMap::Chromatic),
        ] {
            assert_eq!(base, 3 * map.cardinality() as u32 + 1);
            let e = Envelope { pitch_map: map, ..Default::default() };
            let m = Material { pitch_base: base, dur_base: 5,
                               cells: vec![Cell::Sound { p: (base - 1) as u8, d: 0 }] };
            assert_eq!(e.render(&m)[0].pitch, None);
        }
    }

    #[test]
    fn pitch_index_climbs_octaves() {
        let m = PitchMap::PentatonicMinor;
        assert_eq!(m.cardinality(), 5);
        let a = m.midi(60, 0);
        let b = m.midi(60, 5);
        assert_eq!(b - a, 12, "one full map cycle is one octave");
    }

    #[test]
    fn silence_renders_without_pitch() {
        let e = Envelope::default();
        let notes = e.render(&mat(vec![Cell::Silence { d: 3 }]));
        assert_eq!(notes[0].pitch, None);
        assert!(notes[0].ticks > 0);
    }

    #[test]
    fn same_material_sounds_different_under_different_maps() {
        // This is why the envelope must be captured with the tune.
        let m = mat(vec![Cell::Sound { p: 3, d: 2 }]);
        let a = Envelope { pitch_map: PitchMap::Major, ..Default::default() };
        let b = Envelope { pitch_map: PitchMap::WholeTone, ..Default::default() };
        assert_ne!(a.render(&m)[0].pitch, b.render(&m)[0].pitch);
    }

    #[test]
    fn tempo_scales_wall_clock_not_material() {
        let slow = Envelope { tempo_bpm: 60, ..Default::default() };
        let fast = Envelope { tempo_bpm: 120, ..Default::default() };
        let m = mat(vec![Cell::Sound { p: 1, d: 3 }]);
        assert_eq!(slow.render(&m)[0].ticks, fast.render(&m)[0].ticks);
        assert!(slow.seconds_per_tick() > fast.seconds_per_tick());
    }
}
