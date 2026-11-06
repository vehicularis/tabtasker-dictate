//! Cleaning up what Whisper decoded.

/// Whisper's own test for a window nobody spoke in (openai/whisper transcribe.py, whisper.cpp, WhisperKit):
/// the no-speech token likely *and* the words found unsure. A likely no-speech token alone is not silence:
/// clear words after a pause score high on it too, and dropping them is "Didn't catch that" for nothing.
pub fn is_silent_segment(no_speech: f32, avg_logprob: f32) -> bool {
  no_speech > 0.6 && avg_logprob < -1.0
}

/// Over a phrase said again and again, Whisper can carry on saying it long after the voice stopped: hundreds of
/// "hello"s for fifteen seconds of them. Nobody says more than about five words a second, so past that the
/// extra repeats are the decoder's: the longest run of one phrase over and over gives back repeats until the
/// words fit the time. A ceiling, not a cure: what's left is as many as could have been said.
pub fn unloop(text: &str, seconds: f32) -> String {
  let mut words: Vec<&str> = text.split_whitespace().collect();
  let budget = (seconds.max(0.0) * 5.0).ceil() as usize + 3;
  let key = |word: &str| word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
  while words.len() > budget {
    let keys: Vec<String> = words.iter().map(|word| key(word)).collect();
    // The longest run: a phrase of one to four words, three times or more in a row.
    let mut best: Option<(usize, usize, usize)> = None; // (start, phrase length, repeats)
    for start in 0..keys.len() {
      for n in 1..=4.min(keys.len() - start) {
        let mut repeats = 1;
        while start + (repeats + 1) * n <= keys.len() && keys[start + repeats * n..start + (repeats + 1) * n] == keys[start..start + n] {
          repeats += 1;
        }
        if repeats >= 3 && best.is_none_or(|(_, m, r)| n * repeats > m * r) {
          best = Some((start, n, repeats));
        }
      }
    }
    let Some((start, n, repeats)) = best else { break }; // no run to blame: leave it be
    let keep = repeats.saturating_sub((words.len() - budget).div_ceil(n)).max(1);
    words.drain(start + keep * n..start + repeats * n);
  }
  words.join(" ")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_window_is_silence_only_when_whisper_is_unsure_of_its_words_too() {
    assert!(is_silent_segment(0.9, -1.6), "no speech, and the words a guess");
    assert!(!is_silent_segment(0.9, -0.3), "clear words after a pause are kept");
    assert!(!is_silent_segment(0.4, -1.6), "unsure words where someone spoke are kept");
    assert!(is_silent_segment(0.7, f32::NEG_INFINITY), "a window with no words at all");
  }

  #[test]
  fn a_phrase_the_decoder_keeps_repeating_is_cut_to_what_the_time_allows() {
    let looped = vec!["hello"; 400].join(" ");
    let cut = unloop(&looped, 15.0);
    assert_eq!(cut.split_whitespace().count(), 78, "five a second for 15 s, and three");
    assert!(cut.split_whitespace().all(|word| word == "hello"));
    // A loop after real words: the words stay, the loop gives way.
    let tail = format!("Call the venue about Thursday. {}", vec!["Thank you."; 60].join(" "));
    let cut = unloop(&tail, 4.0);
    assert!(cut.starts_with("Call the venue about Thursday. Thank you."), "{cut}");
    assert!(cut.split_whitespace().count() <= 23, "{cut}");
    // Punctuation and case don't hide a repeat.
    assert_eq!(unloop("Hello, hello. HELLO hello hello hello", 0.2), "Hello, hello. HELLO hello");
    // What could have been said is left alone, repeats and all.
    let said = "hello hello hello, can you hear me";
    assert_eq!(unloop(said, 3.0), said);
    // Too many words but no run to blame: nothing is cut.
    let fast = "one two three four five six seven eight nine ten eleven twelve";
    assert_eq!(unloop(fast, 1.0), fast);
  }
}
