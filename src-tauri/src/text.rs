//! The words after Whisper and before they are typed: vocabulary replacements, fillers and the app's
//! style. Drafts run through it too, so every rule keeps the words in their order: a draft is retyped
//! by the prefix it shares with the one before.
use crate::context::HoldContext;

/// The text to type for `raw`, in the hold `ctx`; `live` for a draft while the key is still held.
pub fn finish(raw: &str, _ctx: &HoldContext, _live: bool) -> String {
  raw.to_owned()
}
