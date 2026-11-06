//! The speech pipeline behind TabTasker Dictate, with no app around it.
#![deny(missing_docs)]

pub mod audio;
pub mod meeting;
pub mod cleanup;
pub mod error;
pub mod models;
pub mod pipeline;
pub mod pieces;
pub mod prompt;
pub mod text;
pub mod vad;
pub mod whisper;

pub use audio::SAMPLE_RATE;
