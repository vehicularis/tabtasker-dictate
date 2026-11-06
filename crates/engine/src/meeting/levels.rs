//! Where a meeting's audio pauses and whether anyone spoke, from how loud it is.
use crate::audio::SAMPLE_RATE as RATE;

/// The longest meeting piece transcribed at once, in samples at 16 kHz (25 s: inside Whisper's 30 s
/// window). Not `pieces::PIECE`, which is the dictation notes' own piece length.
pub const WINDOW_SAMPLES: usize = 25 * RATE;
/// A pause ends a piece once it holds this much, so pieces are sentences rather than single words.
const ENOUGH: usize = 8 * RATE;
/// Loudness is measured over 30 ms frames...
const FRAME: usize = RATE * 3 / 100;
/// ...and half a second of quiet ones is a pause.
const PAUSE: usize = 17;

/// The loudness (RMS) of each FRAME of `pcm`.
fn levels(pcm: &[f32]) -> Vec<f32> {
  pcm.chunks(FRAME).map(|frame| (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt()).collect()
}

/// What counts as quiet and as a voice in `levels`: measured against the quietest stretch, so a
/// humming room and digital silence both work, within bounds so a window of nothing but speech still
/// has pauses.
fn thresholds(levels: &[f32]) -> (f32, f32) {
  let mut sorted = levels.to_vec();
  sorted.sort_by(f32::total_cmp);
  let floor = sorted.get(sorted.len() / 10).copied().unwrap_or(0.0);
  let quiet = (floor * 2.0).clamp(0.002, 0.012);
  (quiet, (quiet * 1.5).max(0.005))
}

/// Where to cut the untranscribed `pcm` (at most WINDOW_SAMPLES samples), as a sample index into it: at the last pause that closes a piece
/// of at least ENOUGH. A full window with no such pause is cut at its quietest moment near the end.
/// `last` means `pcm` is all that is left of a meeting that has ended: it goes whole. None while the
/// piece is still being said.
pub fn pause_cut(pcm: &[f32], last: bool) -> Option<usize> {
  if pcm.is_empty() {
    return None;
  }
  if last && pcm.len() <= WINDOW_SAMPLES {
    return Some(pcm.len());
  }
  let levels = levels(pcm);
  let (quiet, _) = thresholds(&levels);
  let mut at = None;
  let mut run = 0;
  for (i, level) in levels.iter().enumerate() {
    run = if *level < quiet { run + 1 } else { 0 };
    let closes = i + 1 == levels.len() || levels[i + 1] >= quiet;
    if run >= PAUSE && closes {
      // In the middle of a pause; one still going at the end keeps a moment for a word starting.
      let frame = if i + 1 == levels.len() { i + 1 - PAUSE / 2 } else { i + 1 - run / 2 };
      if frame * FRAME >= ENOUGH {
        at = Some(frame * FRAME);
      }
    }
  }
  if at.is_some() {
    return at;
  }
  if pcm.len() < WINDOW_SAMPLES {
    return None;
  }
  let from = (pcm.len() - 6 * RATE) / FRAME;
  let quietest = (from..levels.len()).min_by(|a, b| levels[*a].total_cmp(&levels[*b]))?;
  Some((quietest * FRAME).max(ENOUGH))
}

/// Whether `pcm` (16 kHz samples) holds a third of a second of voice: Whisper invents words for silence and hum.
pub fn has_speech(pcm: &[f32]) -> bool {
  let levels = levels(pcm);
  let (_, voice) = thresholds(&levels);
  levels.iter().filter(|level| **level >= voice).count() >= 10
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Speech-like audio for `seconds`, or silence with a little hiss.
  fn audio(parts: &[(bool, f64)]) -> Vec<f32> {
    parts
      .iter()
      .flat_map(|&(speech, seconds)| {
        (0..(seconds * RATE as f64) as usize).map(move |i| if speech { 0.2 * (i as f32 * 0.07).sin() } else { 0.0004 * (i as f32 * 1.3).sin() })
      })
      .collect()
  }

  #[test]
  fn pieces_are_cut_at_pauses_once_long_enough() {
    // Still talking, or a pause too early: wait.
    assert_eq!(pause_cut(&audio(&[(true, 6.0)]), false), None);
    assert_eq!(pause_cut(&audio(&[(true, 3.0), (false, 1.0), (true, 3.0)]), false), None);
    // A pause after 9 s of speech ends the piece in its middle.
    let at = pause_cut(&audio(&[(true, 9.0), (false, 1.0), (true, 2.0)]), false).unwrap();
    assert!((9 * RATE..10 * RATE).contains(&at), "{at}");
    // The last pause that fits wins.
    let at = pause_cut(&audio(&[(true, 9.0), (false, 1.0), (true, 5.0), (false, 1.0), (true, 1.0)]), false).unwrap();
    assert!((15 * RATE..16 * RATE).contains(&at), "{at}");
    // A pause still going at the end keeps a moment for the next word.
    let at = pause_cut(&audio(&[(true, 9.0), (false, 1.0)]), false).unwrap();
    assert!((9 * RATE + 4000..10 * RATE).contains(&at), "{at}");
    // 25 s without a pause is cut anyway, inside the window.
    let at = pause_cut(&audio(&[(true, 25.0)]), false).unwrap();
    assert!((ENOUGH..=WINDOW_SAMPLES).contains(&at), "{at}");
    // The end of a finished meeting goes whole.
    assert_eq!(pause_cut(&audio(&[(true, 3.0)]), true), Some(3 * RATE));
    assert_eq!(pause_cut(&[], true), None);
  }

  #[test]
  fn only_audio_with_a_voice_is_transcribed() {
    assert!(!has_speech(&audio(&[(false, 10.0)])));
    assert!(!has_speech(&vec![0.0; 5 * RATE]));
    assert!(has_speech(&audio(&[(false, 5.0), (true, 0.5), (false, 5.0)])));
    assert!(!has_speech(&audio(&[(false, 5.0), (true, 0.1), (false, 5.0)])));
  }
}
