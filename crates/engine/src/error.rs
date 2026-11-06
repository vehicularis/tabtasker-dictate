//! What can go wrong in a pass, each worded as the person sees it.
use std::fmt;

/// Why a pass or a model load failed. Its `Display` is what the app shows, word for word: the overlay ends a hold
/// quietly only on the exact text `unheard`.
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
  /// Nothing to send: silence, too short, or nothing Whisper was sure of.
  Unheard,
  /// The pass was stopped before it finished.
  Cancelled,
  /// A meeting piece gave the engine up before finishing; it is untouched and can be tried again.
  Interrupted,
  /// No model is loaded yet.
  NotLoaded,
  /// Whisper or the speech detection failed on this audio.
  NotUnderstood,
  /// More words than are worth typing.
  TooLong,
  /// Audio no pass takes: too long, or not finite.
  InvalidAudio,
  /// A language code Whisper doesn't know.
  UnknownLanguage,
  /// Anything else, as the text to show.
  Other(String),
}

/// A result whose error is the engine's.
pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(match self {
      Self::Unheard => "unheard",
      Self::Cancelled => "Voice command cancelled.",
      Self::Interrupted => "interrupted",
      Self::NotLoaded => "The speech model is still loading.",
      Self::NotUnderstood => "Couldn’t understand that",
      Self::TooLong => "That was too long to type. Try a shorter one.",
      Self::InvalidAudio => "Invalid audio",
      Self::UnknownLanguage => "Unknown language",
      Self::Other(text) => text,
    })
  }
}

impl std::error::Error for Error {}

impl From<Error> for String {
  fn from(error: Error) -> Self { error.to_string() }
}

impl From<String> for Error {
  fn from(text: String) -> Self { Self::Other(text) }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn errors_read_as_before() {
    let read = [
      (Error::Unheard, "unheard"),
      (Error::Cancelled, "Voice command cancelled."),
      (Error::Interrupted, "interrupted"),
      (Error::NotLoaded, "The speech model is still loading."),
      (Error::NotUnderstood, "Couldn’t understand that"),
      (Error::TooLong, "That was too long to type. Try a shorter one."),
      (Error::InvalidAudio, "Invalid audio"),
      (Error::UnknownLanguage, "Unknown language"),
      (Error::Other("Dictation is paused.".into()), "Dictation is paused."),
    ];
    for (error, text) in read {
      assert_eq!(error.to_string(), text);
      assert_eq!(String::from(error), text);
    }
    assert_eq!(Error::from("Dictation is paused.".to_owned()), Error::Other("Dictation is paused.".into()));
  }
}
