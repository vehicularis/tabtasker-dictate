//! How a note is cut into pieces while it is said, and the pieces put back together.

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
  if len - last_end.min(len) >= PAUSE { pauses.push((last_end + len) / 2); }
  let mut within = pauses.iter().copied().filter(|&at| at <= PIECE);
  if let Some(at) = within.clone().rfind(|&at| at >= ENOUGH) { return Some(at); }
  if len <= PIECE { return None; }
  Some(within.next_back().unwrap_or(PIECE))
}

/// `text` and `more` with one space between, whichever is empty left out.
pub fn join(text: &str, more: &str) -> String {
  match (text.is_empty(), more.is_empty()) { (true, _) => more.to_owned(), (_, true) => text.to_owned(), _ => format!("{text} {more}") }
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
}
