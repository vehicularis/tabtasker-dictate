//! The `text` command: the text rules alone, no model.

use crate::args::Text;
use dictate_engine::text::{finish, Rules};

/// Finishes the raw string and returns what to print.
pub fn run(Text { raw, style, fillers, language, replacements, live }: &Text, json: bool) -> String {
  let finished = finish(raw, &Rules { style: *style, fillers: *fillers, replacements, language: language.as_deref(), live: *live });
  if json {
    serde_json::json!({ "raw": raw, "finished": finished }).to_string()
  } else {
    finished
  }
}
