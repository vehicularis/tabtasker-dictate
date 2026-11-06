//! A meeting as Markdown: who said what, when, and the file around it.
use super::speakers::Turn as Voice;
use super::{Gap, Line, Source};
use crate::audio::SAMPLE_RATE as RATE;

/// Each line of `source` takes the voice that spoke for most of it; a line no voice covers keeps none.
pub fn assign_speakers(lines: &mut [Line], source: Source, turns: &[Voice]) {
  for line in lines.iter_mut().filter(|line| line.source == source) {
    let mut best: Option<(u64, u32)> = None;
    for turn in turns {
      let overlap = turn.end.min(line.end).saturating_sub(turn.start.max(line.start));
      if overlap > 0 && best.is_none_or(|(most, _)| overlap > most) { best = Some((overlap, turn.speaker)); }
    }
    line.speaker = best.map(|(_, speaker)| speaker);
  }
}

/// What each voice is called. The microphone's main voice, by time spoken, is `you`; every other voice is
/// numbered in order of first appearance, Person 1, Person 2 and on; a stream whose voices weren't told
/// apart keeps its own label, `you` for the microphone and `others` for the Mac's sound.
pub fn speaker_names(lines: &[Line], you: &str, others: &str) -> std::collections::HashMap<(Source, Option<u32>), String> {
  let (you, others) = (label(you, "You"), label(others, "Others"));
  let mut spoke: std::collections::HashMap<u32, u64> = std::collections::HashMap::new();
  for line in lines.iter().filter(|line| line.source == Source::Mic) {
    if let Some(voice) = line.speaker { *spoke.entry(voice).or_default() += line.end.saturating_sub(line.start); }
  }
  let main = spoke.iter().max_by_key(|(voice, time)| (**time, std::cmp::Reverse(**voice))).map(|(voice, _)| *voice);
  let mut names = std::collections::HashMap::new();
  names.insert((Source::Mic, None), you.clone());
  names.insert((Source::System, None), others);
  if let Some(main) = main { names.insert((Source::Mic, Some(main)), you); }
  let mut heard: Vec<&Line> = lines.iter().filter(|line| line.speaker.is_some()).collect();
  heard.sort_by_key(|line| (line.start, line.source.index()));
  let mut n = 0;
  for line in heard {
    let key = (line.source, line.speaker);
    names.entry(key).or_insert_with(|| { n += 1; format!("Person {n}") });
  }
  names
}

/// `samples` into the meeting as HH:MM:SS.
pub fn clock(samples: u64) -> String {
  let seconds = samples / RATE as u64;
  format!("{:02}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
}

/// A speaker label that stays one bold word in Markdown, whatever was typed in Settings.
pub fn label(name: &str, fallback: &str) -> String {
  let clean = name.replace(['*', '_', '`', '[', ']'], " ").split_whitespace().collect::<Vec<_>>().join(" ");
  if clean.is_empty() { fallback.to_owned() } else { clean }
}

/// Both streams' lines in the order they were said: one paragraph per turn, a speaker's lines that
/// follow on within two seconds joined up to a minute long. Audio with no transcript says so where it
/// was. Answers the Markdown (`**You** 00:01:23 words`) and a plain version for Claude
/// (`You 00:01:23: words`). Speakers are named by `speaker_names`.
pub fn transcript(lines: &[Line], gaps: &[Gap], you: &str, others: &str) -> (String, String) {
  struct Turn { who: String, source: Source, start: u64, end: u64, words: String, gap: bool }
  let names = speaker_names(lines, you, others);
  let name = |source: Source, speaker: Option<u32>| names.get(&(source, speaker)).or_else(|| names.get(&(source, None))).cloned().unwrap_or_default();
  let mut said: Vec<Turn> = lines.iter().filter(|line| !line.text.trim().is_empty())
    .map(|line| Turn { who: name(line.source, line.speaker), source: line.source, start: line.start, end: line.end, words: line.text.trim().to_owned(), gap: false })
    .chain(gaps.iter().map(|gap| Turn { who: name(gap.source, None), source: gap.source, start: gap.from, end: gap.to, words: String::new(), gap: true }))
    .collect();
  said.sort_by_key(|turn| (turn.start, turn.source.index(), turn.who.clone())); // the same moment: the microphone first
  let mut turns: Vec<Turn> = Vec::new();
  for turn in said {
    match turns.last_mut() {
      Some(last) if !last.gap && !turn.gap && last.who == turn.who && turn.start <= last.end + 2 * RATE as u64 && turn.start < last.start + 60 * RATE as u64 => {
        last.words.push(' ');
        last.words.push_str(&turn.words);
        last.end = last.end.max(turn.end);
      }
      _ => turns.push(turn),
    }
  }
  let words = |turn: &Turn, italic: &str| if turn.gap {
    format!("{italic}({} not transcribed){italic}", length((turn.end - turn.start) / RATE as u64))
  } else { turn.words.clone() };
  let markdown = turns.iter().map(|turn| format!("**{}** {} {}", turn.who, clock(turn.start), words(turn, "_"))).collect::<Vec<_>>().join("\n\n");
  let plain = turns.iter().map(|turn| format!("{} {}: {}", turn.who, clock(turn.start), words(turn, ""))).collect::<Vec<_>>().join("\n");
  (markdown, plain)
}

/// A length for people: "40 s", "12 min", "1 h 5 min".
pub fn length(seconds: u64) -> String {
  if seconds < 60 { return format!("{} s", seconds.max(1)); }
  let minutes = (seconds + 30) / 60;
  match (minutes / 60, minutes % 60) {
    (0, m) => format!("{m} min"),
    (h, 0) => format!("{h} h"),
    (h, m) => format!("{h} h {m} min"),
  }
}

/// A meeting Claude didn't name is called for when it began, "Meeting 2026-11-02 14.05": the notes
/// template can leave the date and time out of the file name.
pub fn untitled(stamp: &str) -> String { format!("Meeting {stamp}") }

/// When the meeting was and how long it ran, under its title: "2026-11-02 14:05 · 47 min".
pub fn dateline(stamp: &str, samples: u64) -> String {
  let at = match stamp.split_once(' ') { Some((date, time)) => format!("{date} {}", time.replace('.', ":")), None => stamp.to_owned() };
  format!("{at} · {}", length(samples / RATE as u64))
}

/// The file's body under its title: when it was, Claude's summary, decisions and action items when
/// there are any, then the transcript.
pub fn document(dateline: &str, summary: Option<&str>, transcript: &str) -> String {
  let mut body = format!("{dateline}\n\n");
  if let Some(summary) = summary.map(str::trim).filter(|summary| !summary.is_empty()) {
    if !summary.starts_with('#') { body.push_str("## Summary\n\n"); }
    body.push_str(summary);
    body.push_str("\n\n");
  }
  body.push_str("## Transcript\n\n");
  body.push_str(transcript);
  body
}


#[cfg(test)]
mod tests {
  use super::*;
  use crate::meeting::speakers::Turn;

  fn line(source: Source, seconds: f64, text: &str) -> Line {
    let start = (seconds * RATE as f64) as u64;
    Line { source, start, end: start + 2 * RATE as u64, text: text.into(), speaker: None }
  }


  #[test]
  fn the_clock_reads_hours_minutes_and_seconds() {
    assert_eq!(clock(0), "00:00:00");
    assert_eq!(clock(83 * 16000 + 15999), "00:01:23");
    assert_eq!(clock((3600 * 2 + 61) * 16000), "02:01:01");
  }

  #[test]
  fn lines_merge_by_time_into_turns() {
    let lines = [
      line(Source::System, 4.0, "Hi, can you hear me?"),
      line(Source::Mic, 0.5, "Hello."),
      line(Source::Mic, 9.0, "Yes, loud and clear."),
      line(Source::Mic, 11.5, "Shall we start?"), // follows on: the same turn
      line(Source::System, 13.0, " "),             // nothing said
      line(Source::Mic, 30.0, "Then the budget."),  // a pause: a new turn
    ];
    let (markdown, plain) = transcript(&lines, &[], "Can", "Others");
    assert_eq!(markdown, "**Can** 00:00:00 Hello.\n\n**Others** 00:00:04 Hi, can you hear me?\n\n**Can** 00:00:09 Yes, loud and clear. Shall we start?\n\n**Can** 00:00:30 Then the budget.");
    assert_eq!(plain.lines().next(), Some("Can 00:00:00: Hello."));
    // Same moment: the microphone first, every time.
    let (tie, _) = transcript(&[line(Source::System, 1.0, "b"), line(Source::Mic, 1.0, "a")], &[], "You", "Others");
    assert_eq!(tie, "**You** 00:00:01 a\n\n**Others** 00:00:01 b");
  }

  #[test]
  fn voices_told_apart_are_named_in_order_and_the_microphones_main_voice_is_you() {
    
    let s = RATE as u64;
    let mut lines = vec![line(Source::Mic, 0.0, "Hello all."), line(Source::Mic, 3.0, "Thanks for coming."), line(Source::Mic, 6.0, "Glad to be here."), line(Source::System, 9.0, "Hi from the call.")];
    // The second voice in the room speaks at 6 s; a stretch nobody covers keeps no voice.
    assign_speakers(&mut lines, Source::Mic, &[Turn { start: 0, end: 5 * s, speaker: 0 }, Turn { start: 6 * s, end: 8 * s, speaker: 1 }]);
    assign_speakers(&mut lines, Source::System, &[Turn { start: 9 * s, end: 11 * s, speaker: 0 }]);
    assert_eq!(lines.iter().map(|line| line.speaker).collect::<Vec<_>>(), vec![Some(0), Some(0), Some(1), Some(0)]);
    let (markdown, _) = transcript(&lines, &[], "Can", "Others");
    assert_eq!(markdown, "**Can** 00:00:00 Hello all. Thanks for coming.\n\n**Person 1** 00:00:06 Glad to be here.\n\n**Person 2** 00:00:09 Hi from the call.");
    // A line no voice covers keeps its stream's label; without any voices, the old labels stand.
    let plain = [line(Source::Mic, 0.0, "a"), line(Source::System, 3.0, "b")];
    assert_eq!(transcript(&plain, &[], "You", "Others").0, "**You** 00:00:00 a\n\n**Others** 00:00:03 b");
  }

  #[test]
  fn a_long_turn_starts_a_new_line_each_minute_and_labels_stay_bold() {
    let lines: Vec<Line> = (0..40).map(|i| line(Source::Mic, i as f64 * 2.0, "word")).collect();
    let (markdown, _) = transcript(&lines, &[], "**Me**", "  ");
    let turns: Vec<&str> = markdown.split("\n\n").collect();
    assert_eq!(turns.len(), 2);
    assert!(turns[0].starts_with("**Me** 00:00:00 word word"));
    assert!(turns[1].starts_with("**Me** 00:01:00 word"));
    let (others, _) = transcript(&[line(Source::System, 0.0, "hi")], &[], "You", " ** ");
    assert_eq!(others, "**Others** 00:00:00 hi");
  }

  #[test]
  fn audio_with_no_transcript_says_so_where_it_was() {
    let lines = [line(Source::Mic, 0.0, "Can you hear me?"), line(Source::Mic, 30.0, "Sorry, go on.")];
    let gaps = [Gap { source: Source::System, from: 2 * 16000, to: 27 * 16000 }];
    let (markdown, plain) = transcript(&lines, &gaps, "You", "Others");
    assert_eq!(markdown, "**You** 00:00:00 Can you hear me?\n\n**Others** 00:00:02 _(25 s not transcribed)_\n\n**You** 00:00:30 Sorry, go on.");
    assert_eq!(plain.lines().nth(1), Some("Others 00:00:02: (25 s not transcribed)"));
    // A gap never joins a turn, even the same speaker's.
    let (markdown, _) = transcript(&[line(Source::Mic, 0.0, "One.")], &[Gap { source: Source::Mic, from: 16000, to: 3 * 16000 }], "You", "Others");
    assert_eq!(markdown, "**You** 00:00:00 One.\n\n**You** 00:00:01 _(2 s not transcribed)_");
  }

  #[test]
  fn lengths_and_the_dateline_read_plainly() {
    assert_eq!(length(0), "1 s");
    assert_eq!(length(42), "42 s");
    assert_eq!(length(89), "1 min");
    assert_eq!(length(47 * 60 + 10), "47 min");
    assert_eq!(length(3600), "1 h");
    assert_eq!(length(3900), "1 h 5 min");
    assert_eq!(dateline("2026-11-02 14.05", 47 * 60 * 16000), "2026-11-02 14:05 · 47 min");
  }

  #[test]
  fn the_file_has_when_then_the_summary_then_the_transcript() {
    let (when, transcript) = ("2026-11-02 14:05 · 47 min", "**You** 00:00:00 Hello.");
    assert_eq!(document(when, None, transcript), "2026-11-02 14:05 · 47 min\n\n## Transcript\n\n**You** 00:00:00 Hello.");
    assert_eq!(document(when, Some("  "), transcript), document(when, None, transcript));
    let summary = "## Summary\n\nWe met.\n\n## Decisions\n\n- Ship it\n\n## Action items\n\n- [ ] Can: write it up\n";
    assert_eq!(document(when, Some(summary), transcript), format!("{when}\n\n{}\n\n## Transcript\n\n{transcript}", summary.trim()));
    assert!(document(when, Some("We met."), transcript).ends_with("\n\n## Summary\n\nWe met.\n\n## Transcript\n\n**You** 00:00:00 Hello."));
  }
}
