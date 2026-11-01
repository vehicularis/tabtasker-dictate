//! Dictation history and the stats drawn from it.
use serde::Serialize;

/// One finished dictation, command or note. `text` is kept only while History keeps words.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  pub at_ms: u64,
  pub mode: String,
  pub bundle_id: String,
  pub app_name: String,
  pub words: usize,
  pub seconds: f64,
  pub text: String,
}

impl Entry {
  /// An entry for `text` said now over `seconds`, in the hold `ctx`.
  pub fn new(ctx: &crate::context::HoldContext, text: &str, seconds: f64) -> Self {
    let at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
    Self { at_ms, mode: ctx.mode.as_str().into(), bundle_id: ctx.bundle_id.clone(), app_name: ctx.app_name.clone(), words: text.split_whitespace().count(), seconds, text: text.to_owned() }
  }
}

/// The newest entry, for Paste Last Transcript.
static LAST: std::sync::Mutex<Option<Entry>> = std::sync::Mutex::new(None);

pub fn record(entry: Entry) {
  if !entry.text.trim().is_empty() { *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(entry); }
}

pub fn last() -> Option<Entry> { LAST.lock().unwrap_or_else(|e| e.into_inner()).clone() }
