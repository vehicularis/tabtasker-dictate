//! The speech pipeline behind TabTasker Dictate, with no app around it.
#![deny(missing_docs)]

pub mod audio;
pub mod cleanup;
pub mod pieces;
pub mod prompt;
pub mod text;

pub use audio::SAMPLE_RATE;
