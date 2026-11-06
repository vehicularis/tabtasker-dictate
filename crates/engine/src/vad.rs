//! Speech detection (Silero): whether a hold has speech in it and where it ends, and where a note's
//! speech is, so it can be cut where it pauses.
use std::path::Path;
use whisper_rs::{WhisperVadContext, WhisperVadContextParams, WhisperVadParams};
use crate::{audio::{self, Levels}, error::{Error, Result}};

/// The speech detection model, loaded.
pub struct SpeechDetector { vad: WhisperVadContext }

impl std::fmt::Debug for SpeechDetector {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.debug_struct("SpeechDetector").finish_non_exhaustive() }
}

/// What the gates made of a hold's audio, for the log as much as for the pass: never the words.
#[derive(Debug)]
pub struct Gate {
  /// The audio's levels.
  pub levels: Levels,
  /// Whether it is speech, and where that ends.
  pub verdict: Verdict,
}

/// Whether a hold's audio is worth a pass.
#[derive(Debug)]
pub enum Verdict {
  /// Too quiet to hold a word (loudest RMS under 0.002).
  TooQuiet,
  /// No speech detected, and not loud enough to count as a voice.
  NoVoice,
  /// Speech, ending `end` samples in (all of the audio when even the keen pass found none).
  Speech {
    /// Where the speech ends, in samples.
    end: usize,
    /// The speech segments the detection found.
    segments: usize,
    /// The segments its keener pass found, which set the end.
    keen: usize,
    /// No segment was found, but the audio's level is plainly a voice.
    by_level: bool,
  },
}

/// Finds the end more keenly than whether there is speech at all, so a short or quiet last word still counts.
fn keen() -> WhisperVadParams {
  let mut keen = WhisperVadParams::default();
  keen.set_threshold(0.3); keen.set_min_speech_duration(0);
  keen
}

impl SpeechDetector {
  /// The Silero model file at `path`.
  pub fn load(path: &Path) -> Result<Self> {
    let path = path.to_str().ok_or_else(|| Error::Other("Invalid speech model path.".into()))?;
    WhisperVadContext::new(path, WhisperVadContextParams::default()).map(|vad| Self { vad })
      .map_err(|_| Error::Other("Couldn’t load speech detection. Try again.".into()))
  }

  /// What the gates make of a hold's audio: its levels, whether it is speech, and where that ends. Audio
  /// not worth a pass at all (see `audio::worth_a_pass`) is `Unheard`.
  pub fn gate(&mut self, pcm: &[f32]) -> Result<Gate> {
    if !audio::worth_a_pass(pcm) { return Err(Error::Unheard); }
    let levels = audio::levels(pcm);
    let gate = |verdict| Ok(Gate { levels, verdict });
    if audio::is_silent(pcm) { return gate(Verdict::TooQuiet); }
    self.vad.detect_speech(pcm).map_err(|_| Error::NotUnderstood)?;
    let speech = self.vad.segments_from_probabilities(WhisperVadParams::default()).map_err(|_| Error::NotUnderstood)?;
    // Speech detection wants a quarter of a second of speech, which one short word can fall short of, so
    // a level that is plainly a voice counts too.
    let found = speech.num_segments();
    if found == 0 && !audio::is_voiced(pcm) { return gate(Verdict::NoVoice); }
    let speech = self.vad.segments_from_probabilities(keen()).map_err(|_| Error::NotUnderstood)?;
    // In hundredths of a second; all of it when even the keen pass found no speech.
    let end = speech.get_segment_end_timestamp(speech.num_segments() - 1).map_or(pcm.len(), |end| (end * 160.0) as usize);
    gate(Verdict::Speech { end, segments: found as usize, keen: speech.num_segments() as usize, by_level: found == 0 })
  }

  /// The speech in `pcm` as sample ranges, found keenly like a hold's end; none for silence.
  pub fn speech_ranges(&mut self, pcm: &[f32]) -> Result<Vec<(usize, usize)>> {
    if pcm.len() < 4000 || audio::energy(pcm) < 1e-7 { return Ok(Vec::new()); }
    self.vad.detect_speech(pcm).map_err(|_| Error::NotUnderstood)?;
    let speech = self.vad.segments_from_probabilities(keen()).map_err(|_| Error::NotUnderstood)?;
    // In hundredths of a second.
    Ok((0..speech.num_segments()).filter_map(|i| Some(((speech.get_segment_start_timestamp(i)? * 160.0) as usize, (speech.get_segment_end_timestamp(i)? * 160.0) as usize))).collect())
  }
}
