//! One pass end to end: choose the language, then transcribe.
use std::time::Instant;
use crate::{error::{Error, Result}, whisper::{Ask, Whisper}};

/// How sure detection must be for a hold to keep its language for later passes.
pub const SURE: f32 = 0.9;

/// Where a pass's language came from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LanguageFrom {
  /// Pinned in Settings.
  Settings,
  /// Kept by an earlier pass of the same hold.
  Hold,
  /// Detected from this pass's audio, with how sure Whisper was.
  Detected {
    /// Whisper's confidence, 0 to 1.
    sure: f32,
  },
}

/// What a pass heard.
#[derive(Debug)]
pub struct Heard {
  /// The words.
  pub text: String,
  /// Whisper's language id.
  pub language: i32,
  /// Where the language came from.
  pub from: LanguageFrom,
  /// Whether Whisper recited the vocabulary, so the audio was heard again without it. True even if the retry was discarded.
  pub retried_without_prompt: bool,
  /// How long the pass took, detection included.
  pub ms: u128,
}

/// The language of a pass: `ask`'s if Settings pins one, else `held`, else detected. Nothing is kept:
/// the caller decides whether a detected language is sure enough (see [`SURE`]). Stops first if `stop` says so.
pub fn language(whisper: &mut Whisper, pcm: &[f32], ask: &Ask, held: Option<i32>, stop: &(dyn Fn() -> bool + Sync)) -> Result<(i32, LanguageFrom)> {
  choose_language(ask, held, stop, || whisper.detect_language(pcm))
}

/// [`language`]'s rules alone, with `detect` giving the detected language and how sure it is; `detect`
/// runs only when neither Settings nor the hold has a language, and never once `stop` says so.
pub fn choose_language(ask: &Ask, held: Option<i32>, stop: &(dyn Fn() -> bool + Sync), detect: impl FnOnce() -> Result<(i32, f32)>) -> Result<(i32, LanguageFrom)> {
  if stop() { return Err(Error::Cancelled); }
  match (ask.language, held) {
    (Some(language), _) => Ok((language, LanguageFrom::Settings)),
    (None, Some(language)) => Ok((language, LanguageFrom::Hold)),
    (None, None) => {
      let (language, sure) = detect()?;
      Ok((language, LanguageFrom::Detected { sure }))
    }
  }
}

/// A whole pass: [`language`], then the words. Keeps nothing; the only logging is `Whisper::transcribe`'s vocabulary-retry line.
pub fn hear(whisper: &mut Whisper, pcm: &[f32], ask: &Ask, held: Option<i32>, stop: &(dyn Fn() -> bool + Sync), quick: bool) -> Result<Heard> {
  let started = Instant::now();
  let (language, from) = language(whisper, pcm, ask, held, stop)?;
  let heard = whisper.transcribe(pcm, language, ask, stop, quick)?;
  Ok(Heard { text: heard.text, language, from, retried_without_prompt: heard.retried_without_prompt, ms: started.elapsed().as_millis() })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models;

  #[test]
  fn language_precedence() {
    let unasked = || -> Result<(i32, f32)> { panic!("detected a language it already had") };
    let (pinned, ask) = (Ask { language: Some(3), ..Ask::default() }, Ask::default());
    assert_eq!(choose_language(&pinned, Some(5), &|| false, unasked), Ok((3, LanguageFrom::Settings)));
    assert_eq!(choose_language(&ask, Some(5), &|| false, unasked), Ok((5, LanguageFrom::Hold)));
    assert_eq!(choose_language(&ask, None, &|| false, || Ok((7, 0.95))), Ok((7, LanguageFrom::Detected { sure: 0.95 })));
    // Stopping comes first, before any language.
    assert_eq!(choose_language(&ask, None, &|| true, unasked), Err(Error::Cancelled));
    assert_eq!(choose_language(&pinned, Some(5), &|| true, unasked), Err(Error::Cancelled));
  }

  #[test]
  #[ignore = "needs the Small model in DICTATE_MODELS"]
  fn a_stopped_pass_does_no_work() {
    let dir = std::env::var("DICTATE_MODELS").expect("set DICTATE_MODELS");
    let mut whisper = Whisper::load(&std::path::Path::new(&dir).join(models::SMALL.name), models::ModelKind::Small).unwrap();
    let ask = Ask { language: None, translate: false, words: Vec::new() };
    let started = Instant::now();
    let heard = hear(&mut whisper, &[0.0; 16_000], &ask, None, &|| true, false);
    assert!(matches!(heard, Err(Error::Cancelled)));
    assert!(started.elapsed().as_millis() < 50);
  }
}
