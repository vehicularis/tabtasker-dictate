//! A meeting's transcript: the lines each stream said, the audio that has none, and the Markdown they make.
pub mod levels;
pub mod speakers;
pub mod transcript;

use serde::{Deserialize, Serialize};

/// One of the two audio streams of a meeting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
  /// The microphone.
  Mic,
  /// The Mac's own sound.
  System,
}
/// Both streams, microphone first.
pub const SOURCES: [Source; 2] = [Source::Mic, Source::System];
impl Source {
  /// The stream's place in a pair of per-stream arrays.
  pub fn index(self) -> usize {
    self as usize
  }
}

/// Words heard in one stream, `start` and `end` in samples from the start of the meeting. `speaker` is
/// the voice that said them, once the voices are told apart (speakers.rs); None until then, or when no
/// voice was found there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
  /// The stream it was heard in.
  pub source: Source,
  /// First sample, from the start of the meeting.
  pub start: u64,
  /// Last sample, from the start of the meeting.
  pub end: u64,
  /// What was said.
  pub text: String,
  /// The voice that said it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub speaker: Option<u32>,
}

/// Audio of one stream that has no transcript, in samples from the start of the meeting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gap {
  /// The stream the audio is in.
  pub source: Source,
  /// First sample, from the start of the meeting.
  pub from: u64,
  /// End sample, from the start of the meeting.
  pub to: u64,
}

/// Takes `from..to` out of the gap that holds it: true when one did.
pub fn fill(gaps: &mut Vec<Gap>, source: Source, from: u64, to: u64) -> bool {
  let Some(at) = gaps.iter().position(|gap| gap.source == source && gap.from <= from && to <= gap.to) else { return false };
  let gap = gaps.remove(at);
  if gap.from < from {
    gaps.push(Gap { to: from, ..gap });
  }
  if to < gap.to {
    gaps.push(Gap { from: to, ..gap });
  }
  true
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn spool_lines_read_as_before() {
    let said = Line { source: Source::Mic, start: 0, end: 16_000, text: "Hi".into(), speaker: Some(1) };
    assert_eq!(serde_json::to_string(&said).unwrap(), r#"{"source":"mic","start":0,"end":16000,"text":"Hi","speaker":1}"#);
    let unknown = Line { speaker: None, source: Source::System, ..said };
    assert_eq!(serde_json::to_string(&unknown).unwrap(), r#"{"source":"system","start":0,"end":16000,"text":"Hi"}"#);
  }
}
