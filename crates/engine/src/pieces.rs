//! How a note is cut into pieces while it is said, and the pieces put back together.
use crate::error::{Error, Result};
use std::sync::atomic::{AtomicBool, Ordering};

/// The longest piece transcribed at once: inside Whisper's 30 s window.
pub const PIECE: usize = 25 * 16000;
/// A pause this long ends a piece...
pub const PAUSE: usize = 16000 * 4 / 10;
/// ...once the piece holds this much, so pieces are sentences rather than single words.
pub const ENOUGH: usize = 6 * 16000;
/// The untranscribed audio a note may hold at once; the Mac drops what is transcribed.
pub const TAIL: usize = 10 * 60 * 16000;

/// Where to cut `len` untranscribed samples, given the speech in them as (start, end) sample ranges:
/// in the middle of the last pause that closes a piece of at least ENOUGH, within PIECE. A tail that
/// has run past PIECE is cut at its last pause, or at PIECE if the speech never paused. None while the
/// piece is still being said.
pub fn cut(speech: &[(usize, usize)], len: usize) -> Option<usize> {
  let Some(&(_, last_end)) = speech.last() else {
    return (len > ENOUGH).then(|| len - PAUSE); // silence: let it go, keeping a moment for a word starting
  };
  let mut pauses: Vec<usize> = speech.windows(2).filter(|pair| pair[1].0 - pair[0].1 >= PAUSE).map(|pair| (pair[0].1 + pair[1].0) / 2).collect();
  if len - last_end.min(len) >= PAUSE {
    pauses.push((last_end + len) / 2);
  }
  let mut within = pauses.iter().copied().filter(|&at| at <= PIECE);
  if let Some(at) = within.clone().rfind(|&at| at >= ENOUGH) {
    return Some(at);
  }
  if len <= PIECE {
    return None;
  }
  Some(within.next_back().unwrap_or(PIECE))
}

/// `text` and `more` with one space between, whichever is empty left out.
pub fn join(text: &str, more: &str) -> String {
  match (text.is_empty(), more.is_empty()) {
    (true, _) => more.to_owned(),
    (_, true) => text.to_owned(),
    _ => format!("{text} {more}"),
  }
}

/// `pcm` heard piece by piece after the words in `text` already: `ranges` finds the speech in what is
/// left and `piece` hears one piece. Audio within [`PIECE`] is one piece; longer audio is cut where [`cut`]
/// says, and silence left ends it. A piece that fails is skipped with a warning, unless `cancelled` is
/// set, when its error is returned. Unheard when no words come of it at all.
pub fn hear_long(
  mut text: String,
  pcm: &[f32],
  mut ranges: impl FnMut(&[f32]) -> Result<Vec<(usize, usize)>>,
  mut piece: impl FnMut(&[f32]) -> Result<String>,
  cancelled: &AtomicBool,
) -> Result<String> {
  let mut at = 0;
  while at < pcm.len() {
    let rest = &pcm[at..];
    let speech = ranges(rest)?;
    if speech.is_empty() {
      break;
    }
    let end = if rest.len() <= PIECE { rest.len() } else { cut(&speech, rest.len()).unwrap_or(PIECE) };
    match piece(&rest[..end]) {
      Ok(words) => text = join(&text, &words),
      Err(error) if cancelled.load(Ordering::Relaxed) => return Err(error),
      // One piece Whisper could not read does not cost the rest of the note.
      Err(error) => log::warn!("voice note: a piece was not transcribed: {error}"),
    }
    at += end;
  }
  if text.is_empty() {
    Err(Error::Unheard)
  } else {
    Ok(text)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_note_is_cut_where_a_pause_closes_a_long_enough_piece() {
    let ms = |m: usize| m * 16;
    let said = |a: usize, b: usize| (ms(a), ms(b));
    assert_eq!(cut(&[said(0, 4000)], ms(4100)), None); // still talking
    assert_eq!(cut(&[said(0, 7000), said(7600, 9000)], ms(9000)), Some(ms(7300))); // in the middle of the pause
    assert_eq!(cut(&[said(0, 2000), said(2600, 5000)], ms(5000)), None); // a piece is a sentence, not a word
    assert_eq!(cut(&[said(0, 8000)], ms(9000)), Some(ms(8500))); // the speech stopped
                                                                 // Past Whisper's window: its last pause, or the window itself when the speech never paused.
    assert_eq!(cut(&[said(0, 3000), said(3500, 26000)], ms(26000)), Some(ms(3250)));
    assert_eq!(cut(&[said(0, 26000)], ms(26000)), Some(PIECE));
    assert_eq!(cut(&[], ms(7000)), Some(ms(6600))); // silence goes, keeping a moment for a word starting
    assert_eq!(cut(&[], ms(3000)), None);
  }

  /// Fake speech detection: `said`, in samples of the whole audio, as seen from where `rest` starts.
  fn speech(said: &[(usize, usize)], rest: &[f32]) -> Result<Vec<(usize, usize)>> {
    let from = rest[0] as usize;
    Ok(said.iter().filter(|&&(_, end)| end > from).map(|&(start, end)| (start.saturating_sub(from), end - from)).collect())
  }

  #[test]
  fn long_audio_is_heard_piece_by_piece() {
    let ms = |m: usize| m * 16;
    let said = |a: usize, b: usize| (ms(a), ms(b));
    // Every sample is its own position, so a fake stage knows where its slice starts.
    let audio = |len: usize| (0..len).map(|at| at as f32).collect::<Vec<f32>>();
    // A fake pass that names each piece by where it starts and ends, in ms.
    let span = |rest: &[f32]| -> Result<String> {
      let from = rest[0] as usize / 16;
      Ok(format!("{from}-{}", from + rest.len() / 16))
    };
    let unasked = |_: &[f32]| -> Result<String> { panic!("heard a piece of silence") };
    let silence = |_: &[f32]| -> Result<Vec<(usize, usize)>> { Ok(Vec::new()) };
    let no = AtomicBool::new(false);

    // Past one piece, the audio is cut where `cut` says, and the pieces joined after the words already in.
    let paused = [said(0, 10_000), said(10_600, 30_000)];
    assert_eq!(cut(&paused, ms(30_000)), Some(ms(10_300)));
    assert_eq!(hear_long("So far".into(), &audio(ms(30_000)), |rest| speech(&paused, rest), span, &no), Ok("So far 0-10300 10300-30000".into()));
    let talking = [said(0, 30_000)];
    assert_eq!(hear_long(String::new(), &audio(ms(30_000)), |rest| speech(&talking, rest), span, &no), Ok("0-25000 25000-30000".into()));
    // Within one piece, it is heard whole, pause and all.
    let short = [said(0, 8_000), said(8_600, 20_000)];
    assert_eq!(hear_long(String::new(), &audio(ms(20_000)), |rest| speech(&short, rest), span, &no), Ok("0-20000".into()));
    // Silence left ends it: the tail after the speech is never heard.
    let stopped = [said(0, 10_000)];
    assert_eq!(hear_long(String::new(), &audio(ms(30_000)), |rest| speech(&stopped, rest), span, &no), Ok("0-20000".into()));

    // A piece that fails is skipped and the rest kept.
    let first_fails = |rest: &[f32]| if rest[0] == 0.0 { Err(Error::NotUnderstood) } else { span(rest) };
    assert_eq!(hear_long(String::new(), &audio(ms(30_000)), |rest| speech(&paused, rest), first_fails, &no), Ok("10300-30000".into()));
    // Once cancelled, a failing piece's error is the note's, and nothing after it is heard.
    let mut heard = 0;
    let failed = hear_long(
      "So far".into(),
      &audio(ms(30_000)),
      |rest| speech(&paused, rest),
      |_| {
        heard += 1;
        Err(Error::Cancelled)
      },
      &AtomicBool::new(true),
    );
    assert_eq!((failed, heard), (Err(Error::Cancelled), 1));
    // Speech detection failing fails the note.
    assert_eq!(hear_long("So far".into(), &audio(ms(5_000)), |_| Err(Error::NotLoaded), unasked, &no), Err(Error::NotLoaded));

    // No speech at all, or only pieces that come to nothing, is unheard; silence after words keeps them.
    assert_eq!(hear_long(String::new(), &audio(ms(5_000)), silence, unasked, &no), Err(Error::Unheard));
    assert_eq!(hear_long(String::new(), &[], silence, unasked, &no), Err(Error::Unheard));
    assert_eq!(hear_long(String::new(), &audio(ms(30_000)), |rest| speech(&paused, rest), |_| Ok(String::new()), &no), Err(Error::Unheard));
    assert_eq!(hear_long("So far".into(), &audio(ms(5_000)), silence, unasked, &no), Ok("So far".into()));
  }
}
