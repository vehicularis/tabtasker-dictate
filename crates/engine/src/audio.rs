//! The gates audio passes before Whisper is asked anything.

/// The rate every sample is at.
pub const SAMPLE_RATE: usize = 16_000;
/// A hold listens for up to five minutes.
pub const HOLD_SAMPLES: usize = 5 * 60 * 16_000;
/// A hands-free session listens for up to ten minutes.
pub const HANDS_FREE_SAMPLES: usize = 10 * 60 * 16_000;

/// Too quiet to hold a word: even its loudest tenth of a second is below the level of a breath (OpenWhispr
/// localSpeechGate.js, its first rule). Whisper is never asked there, where it would make words up.
pub fn is_silent(pcm: &[f32]) -> bool {
  pcm.chunks(1_600).map(|window| (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt()).fold(0.0, f32::max) < 0.002
}

/// The loudest sample and the loudest tenth of a second (RMS) of a clip.
#[derive(Clone, Copy, Debug)]
pub struct Levels {
  /// The loudest sample.
  pub peak: f32,
  /// The RMS of the loudest tenth of a second.
  pub rms: f32,
}

/// The loudest sample and the loudest tenth of a second (RMS) of `pcm`: what the gates below judge, for the log.
pub fn levels(pcm: &[f32]) -> Levels {
  let peak = pcm.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
  let rms = pcm.chunks(1_600).map(|window| (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt()).fold(0.0, f32::max);
  Levels { peak, rms }
}

/// Loud enough somewhere to be a voice (OpenWhispr localSpeechGate.js, its speech rule): a tenth of a second
/// at the level of a word, RMS 0.003 with a peak of 0.02, or plainly above it at RMS 0.006.
pub fn is_voiced(pcm: &[f32]) -> bool {
  pcm.chunks(1_600).any(|window| {
    let rms = (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt();
    let peak = window.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
    rms >= 0.006 || (rms >= 0.003 && peak >= 0.02)
  })
}

/// The mean square of `pcm`, 0 for an empty slice.
pub fn energy(pcm: &[f32]) -> f64 {
  pcm.iter().map(|sample| (*sample as f64).powi(2)).sum::<f64>() / pcm.len().max(1) as f64
}

/// Audio worth a pass: long enough, finite, not silent, and no longer than the longest hold.
pub fn worth_a_pass(pcm: &[f32]) -> bool {
  pcm.len() >= 4000 && pcm.len() <= HANDS_FREE_SAMPLES && pcm.iter().all(|sample| sample.is_finite()) && energy(pcm) >= 1e-7
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tone(seconds: f32, amplitude: f32) -> Vec<f32> {
    (0..(seconds * SAMPLE_RATE as f32) as usize).map(|i| amplitude * (std::f32::consts::TAU * 440.0 * i as f32 / SAMPLE_RATE as f32).sin()).collect()
  }

  #[test]
  fn a_tone_is_voiced_and_zeros_are_silent() {
    let loud = tone(0.5, 0.1);
    assert!(is_voiced(&loud));
    assert!(!is_silent(&loud));
    let at = levels(&loud);
    assert!((at.peak - 0.1).abs() < 1e-3);
    assert!((at.rms - 0.0707).abs() < 1e-3);
    let none = vec![0.0; 8000];
    assert!(is_silent(&none));
    assert!(!is_voiced(&none));
  }

  #[test]
  fn a_pass_needs_enough_finite_sound() {
    assert!(!worth_a_pass(&tone(3999.0 / 16000.0, 0.1)));
    assert!(worth_a_pass(&tone(4000.0 / 16000.0, 0.1)));
    let mut nan = tone(1.0, 0.1);
    nan[100] = f32::NAN;
    assert!(!worth_a_pass(&nan));
    assert!(!worth_a_pass(&vec![0.1; HANDS_FREE_SAMPLES + 1]));
    assert!(!worth_a_pass(&tone(1.0, 1e-4)));
  }

  #[test]
  fn invalid_and_silent_audio_never_reaches_the_model() {
    assert!(!worth_a_pass(&[]));
    assert!(!worth_a_pass(&vec![0.0; 16000]));
    assert!(!worth_a_pass(&vec![f32::NAN; 16000]));
    assert!(!worth_a_pass(&vec![0.5; HANDS_FREE_SAMPLES + 1]));
    assert!(worth_a_pass(&vec![0.25; HANDS_FREE_SAMPLES])); // a hands-free session reaches ten minutes
    assert!(worth_a_pass(&vec![0.25; 16000]));
  }

  #[test]
  fn audio_quieter_than_a_breath_is_silence() {
    assert!(is_silent(&vec![0.0005; 16_000]));
    let mut said = vec![0.0005; 16_000];
    for (i, sample) in said[4_000..6_000].iter_mut().enumerate() { *sample = 0.02 * (i as f32 * 0.3).sin(); } // a quiet word on the built-in mic
    assert!(!is_silent(&said));
  }

  #[test]
  fn one_short_word_is_loud_enough_where_speech_detection_may_miss_it() {
    let room = |level: f32| (0..16_000).map(|i| level * (i as f32 * 0.7).sin()).collect::<Vec<f32>>();
    assert!(!is_voiced(&room(0.001)), "a quiet room");
    // A word: one tenth of a second at RMS 0.004 with a click of 0.025 in it.
    let mut word = room(0.001);
    for (i, sample) in word[3_200..4_800].iter_mut().enumerate() { *sample = 0.0057 * (i as f32 * 0.3).sin(); }
    assert!(!is_voiced(&word), "RMS 0.004 alone, with no peak, isn't a word");
    word[4_000] = 0.025;
    assert!(is_voiced(&word));
    // Or plainly above that level, peak or not.
    let mut loud = room(0.001);
    for (i, sample) in loud[8_000..9_600].iter_mut().enumerate() { *sample = 0.0092 * (i as f32 * 0.3).sin(); }
    assert!(is_voiced(&loud));
    assert!(!is_voiced(&[]));
  }
}
