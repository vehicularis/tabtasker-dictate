//! The speech pipeline behind TabTasker Dictate, with no app around it.
//!
//! The engine turns audio that is already captured into the words to type. A hold goes through these
//! stages in order:
//!
//! 1. **Audio gate** ([`audio`]): level checks that drop silence and clips too short to be worth a pass.
//! 2. **Speech detection** ([`vad`]): Silero finds where voices are, so Whisper never sees dead air.
//! 3. **Language** ([`pipeline::language`]): the held language, or Whisper's own guess.
//! 4. **Whisper** ([`whisper`], [`pipeline::hear`]): the decode, with the person's vocabulary as a
//!    prompt, and the echo guard ([`prompt`]) that drops a prompt Whisper merely repeated.
//! 5. **Decode cleanup** ([`cleanup`]): silent segments and repetition loops are removed.
//! 6. **Text rules** ([`text`]): replacements, fillers and the app's style.
//!
//! A note is cut into [`pieces`] while it is spoken, and each piece goes through the stages above.
//! A [`meeting`] is kept as timed segments with speakers; [`models`] holds the files all of this needs.
//!
//! Not here: recording, typing into other apps, settings, history and the app itself. The engine
//! takes samples and returns text.
//!
//! ```
//! use dictate_engine::text::{finish, Replacement, Rules, Style};
//!
//! let replacements = [Replacement { from: "tab tasker".into(), to: "TabTasker".into() }];
//! let rules = Rules { style: Style::Formal, fillers: true, replacements: &replacements, language: Some("en"), live: false };
//! assert_eq!(finish("um so tab tasker ships on friday", &rules), "So TabTasker ships on friday.");
//! ```
#![deny(missing_docs)]
#![deny(unsafe_code)]
#![warn(missing_debug_implementations)]

pub mod audio;
pub mod cleanup;
pub mod error;
pub mod meeting;
pub mod models;
pub mod pieces;
pub mod pipeline;
pub mod prompt;
pub mod text;
pub mod vad;
#[allow(unsafe_code)]
pub mod whisper;

pub use audio::SAMPLE_RATE;
