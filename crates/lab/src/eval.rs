//! The `eval` command: every fixture in a folder heard through `run`'s stages, its words scored
//! against what was said, and each held to its budget.

use crate::{
  fixtures::{self, Fixture},
  run::{self, Engine, Hearing, Spoken, Trace, Transcriber},
  score::{diff, score, words, Score},
  wav, Failure,
};
use dictate_engine::models::ModelKind;
use serde::Serialize;
use std::{fmt, io::Write, path::Path};

/// One fixture to hear: its settings, and its audio when it was rendered.
pub struct Case {
  /// The fixture's name, its file's without `.json`.
  pub name: String,
  /// Its settings.
  pub fixture: Fixture,
  /// How it is heard.
  pub hearing: Hearing,
  /// Its audio; None when there is no `.wav` beside its `.json`.
  pub pcm: Option<Vec<f32>>,
}

/// Every `x.json` in `dir`, by name, each with `x.wav` when it is there. A fixture that can't be read,
/// or a WAV the lab can't read, fails the lot at once as a fixture, before any model loads; a folder
/// that can't be read, or holds none, stops the lab.
pub fn cases(dir: &Path) -> Result<Vec<Case>, Failure> {
  let render = "Render them with: dictate-lab fixtures";
  let listed = fixtures::listed(dir).map_err(|e| format!("{e}. {render}"))?;
  if listed.is_empty() {
    return Err(Failure::Broken(format!("{} holds no fixtures. {render}", dir.display())));
  }
  listed
    .into_iter()
    .map(|(name, json)| {
      let fixture = fixtures::load(&json)?;
      let hearing = fixture.hearing().map_err(|e| format!("{name}.json: {e}"))?;
      let audio = dir.join(format!("{name}.wav"));
      let pcm = audio.exists().then(|| wav::read(&audio)).transpose()?;
      Ok(Case { name, fixture, hearing, pcm })
    })
    .collect::<Result<_, String>>()
    .map_err(Failure::Failed)
}

/// What came of one fixture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
  /// Within its budget, and a sticky or send as expected.
  Pass,
  /// Its word error rate is over its budget.
  OverBudget,
  /// Its words are within budget, but not the exact text, the sticky or the send it expects, or it
  /// should be unheard and words were heard.
  Mismatch,
  /// A known issue: scored like any fixture, passing or not, and never a failure.
  Known,
  /// It has no audio to hear.
  Skipped,
  /// A stage failed, or a note skipped a piece.
  Error,
}

impl fmt::Display for Verdict {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(match self {
      Verdict::Pass => "pass",
      Verdict::OverBudget => "over budget",
      Verdict::Mismatch => "mismatch",
      Verdict::Known => "known",
      Verdict::Skipped => "skipped",
      Verdict::Error => "error",
    })
  }
}

/// One fixture's row.
#[derive(Debug, Serialize)]
pub struct Row {
  /// The fixture.
  pub name: String,
  /// What came of it.
  pub verdict: Verdict,
  /// Why, for a mismatch, a known issue, a skip or an error.
  pub why: Option<String>,
  /// The word error rate; None when it wasn't heard, or a stage failed.
  pub wer: Option<f64>,
  /// The substitutions, deletions and insertions the WER counts, with the words said; None with no WER.
  pub score: Option<Score>,
  /// The words said with what was heard instead marked in them, for a row that didn't pass and has an
  /// edit to show.
  pub diff: Option<String>,
  /// Its budget.
  pub max_wer: f64,
  /// The words that should be typed: empty when it should be unheard.
  pub expect: String,
  /// The words after `text::finish`; None when nothing came of it.
  pub heard: Option<String>,
  /// Milliseconds in every stage.
  pub ms: u128,
  /// What each stage made of it.
  pub trace: Option<Trace>,
}

/// How many fixtures came to each verdict.
#[derive(Debug, Default, Serialize)]
pub struct Counts {
  /// Passed.
  pub pass: usize,
  /// Over budget.
  pub over_budget: usize,
  /// Within budget, but the wrong text, sticky or send.
  pub mismatch: usize,
  /// Known issues, passing or not.
  pub known: usize,
  /// Not heard, for want of audio.
  pub skipped: usize,
  /// A stage failed.
  pub error: usize,
}

/// The whole eval, as `--json` prints it.
#[derive(Debug, Serialize)]
struct Report {
  fixtures: Vec<Row>,
  /// The mean word error rate of the fixtures with words that were scored.
  mean_wer: Option<f64>,
  /// How many that is.
  with_words: usize,
  counts: Counts,
}

/// What `fixture` expects and wasn't `heard`, said as a reason: no words at all, or the typed text,
/// sticky or send `spoken` doesn't have.
fn mismatch(fixture: &Fixture, heard: &str, spoken: Option<&Spoken>) -> Option<String> {
  // Whatever its budget: with nothing said, any word heard is a WER of 1, which a budget of 1 lets by.
  if fixture.expect_unheard && !words(heard).is_empty() {
    return Some("words were heard, expected none".into());
  }
  let typed = spoken.map_or("", |s| s.text.as_str());
  if let Some(want) = &fixture.expect_typed {
    if typed.trim() != want.trim() {
      return Some(format!("typed {}, expected exactly \"{want}\"", quoted(Some(typed))));
    }
  }
  let sticky = spoken.and_then(|s| s.sticky.as_deref());
  if let Some(want) = &fixture.expect_sticky {
    match sticky {
      None => return Some(format!("no sticky, expected \"{want}\"")),
      Some(got) if words(got) != words(want) => return Some(format!("sticky \"{got}\", expected \"{want}\"")),
      Some(_) => {}
    }
  }
  match (fixture.expect_send, spoken.is_some_and(|s| s.send)) {
    (Some(true), false) => Some("no spoken send, expected one".into()),
    (Some(false), true) => Some("a spoken send, expected none".into()),
    _ => None,
  }
}

/// The row for `case`, heard as `trace`.
fn judge(case: &Case, trace: Trace) -> Row {
  let fixture = &case.fixture;
  let heard = trace.typed.clone();
  let got = heard.as_deref().unwrap_or_default();
  let scored = score(fixture.expected(), got);
  let wer = scored.wer();
  let s = if trace.skipped == 1 { "" } else { "s" };
  let (verdict, why) = if let Some(error) = &trace.error {
    (Verdict::Error, Some(error.clone()))
  } else if trace.skipped > 0 {
    (Verdict::Error, Some(format!("skipped {} piece{s}", trace.skipped)))
  // ponytail: serde_json may read a budget a bit off its decimal, so a WER equal to it passes.
  } else if wer > fixture.max_wer + 1e-9 {
    (Verdict::OverBudget, None)
  } else if let Some(why) = mismatch(fixture, got, trace.spoken.as_ref()) {
    (Verdict::Mismatch, Some(why))
  } else {
    (Verdict::Pass, None)
  };
  // A known issue is scored like any fixture and never fails; it says whether it still shows. A stage
  // that failed is not the issue it is known for, so that stays an error.
  let (verdict, why) = match (&fixture.known_issue, verdict) {
    (Some(issue), Verdict::Pass) => (Verdict::Known, Some(format!("{issue}, passes now, so take known_issue out of {}.json", case.name))),
    (Some(issue), Verdict::OverBudget) => (Verdict::Known, Some(format!("{issue}, still over budget"))),
    (Some(issue), Verdict::Mismatch) => (Verdict::Known, Some(format!("{issue}, still a mismatch: {}", why.unwrap_or_default()))),
    (_, verdict) => (verdict, why),
  };
  let edits = scored.substitutions + scored.deletions + scored.insertions;
  let ms = &trace.ms;
  Row {
    name: case.name.clone(),
    verdict,
    why,
    wer: (verdict != Verdict::Error).then_some(wer),
    score: (verdict != Verdict::Error).then_some(scored),
    diff: (verdict != Verdict::Pass && verdict != Verdict::Error && edits > 0).then(|| diff(fixture.expected(), got)),
    max_wer: fixture.max_wer,
    expect: fixture.expected().to_string(),
    heard,
    ms: ms.gate + ms.speech + ms.language + ms.whisper,
    trace: Some(trace),
  }
}

fn quoted(text: Option<&str>) -> String {
  match text {
    Some(text) if !text.is_empty() => format!("\"{text}\""),
    _ => "nothing".into(),
  }
}

impl fmt::Display for Row {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.name, self.verdict)?;
    if let Some(why) = &self.why {
      write!(f, ", {why}")?;
    }
    if self.verdict == Verdict::Skipped {
      return Ok(());
    }
    if let Some(wer) = self.wer {
      write!(f, ", WER {wer:.3} (budget {:.2})", self.max_wer)?;
    }
    if let Some(Score { substitutions, deletions, insertions, .. }) = self.score {
      write!(f, ", S/D/I {substitutions}/{deletions}/{insertions}")?;
    }
    write!(f, ", {} ms, heard {}, expected {}", self.ms, quoted(self.heard.as_deref()), quoted(Some(&self.expect)))?;
    match &self.diff {
      Some(diff) => write!(f, "\n  diff: {diff}"),
      None => Ok(()),
    }
  }
}

fn plural(n: usize, one: &str, many: &str) -> String {
  format!("{n} {}", if n == 1 { one } else { many })
}

/// Hears every case with `t` and holds it to its budget, writing a row each as it goes, then the mean
/// WER and the counts. They go to `out`; with `json`, they go to `table` instead and `out` holds the
/// whole eval as one document. Each case after the first is heard on a fresh state, so its words don't
/// depend on the order. Fails when a fixture is over budget, mismatched or errors, or when no fixture
/// with words was scored; a skipped one is neither a pass nor a failure, and a known issue never fails.
pub fn score_all(t: &mut dyn Transcriber, cases: &[Case], json: bool, out: &mut dyn Write, table: &mut dyn Write) -> Result<(), Failure> {
  let human: &mut dyn Write = if json { table } else { &mut *out };
  let written = |e: std::io::Error| Failure::Broken(format!("cannot write the eval: {e}"));
  let mut rows = Vec::new();
  let mut counts = Counts::default();
  let mut heard_one = false;
  for case in cases {
    let row = match &case.pcm {
      Some(pcm) => {
        if std::mem::replace(&mut heard_one, true) {
          t.fresh().map_err(|e| Failure::Broken(e.to_string()))?;
        }
        judge(case, run::trace(t, &format!("{}.wav", case.name), pcm, &case.hearing))
      }
      None => Row {
        name: case.name.clone(),
        verdict: Verdict::Skipped,
        why: Some(match &case.fixture.voice {
          Some(voice) => format!("no {0}.wav beside {0}.json; it needs the voice {voice}", case.name),
          None => format!("no {0}.wav beside {0}.json", case.name),
        }),
        wer: None,
        score: None,
        diff: None,
        max_wer: case.fixture.max_wer,
        expect: case.fixture.expected().to_string(),
        heard: None,
        ms: 0,
        trace: None,
      },
    };
    *match row.verdict {
      Verdict::Pass => &mut counts.pass,
      Verdict::OverBudget => &mut counts.over_budget,
      Verdict::Mismatch => &mut counts.mismatch,
      Verdict::Known => &mut counts.known,
      Verdict::Skipped => &mut counts.skipped,
      Verdict::Error => &mut counts.error,
    } += 1;
    writeln!(human, "{row}").map_err(written)?;
    rows.push(row);
  }
  // The fixtures with words, which an unheard one has none of; a failed stage's WER means nothing.
  let scored: Vec<f64> = rows.iter().filter(|row| !row.expect.is_empty()).filter_map(|row| row.wer).collect();
  let mean_wer = (!scored.is_empty()).then(|| scored.iter().sum::<f64>() / scored.len() as f64);
  let failed = counts.over_budget + counts.mismatch + counts.error;
  match mean_wer {
    Some(mean) => writeln!(human, "mean WER {mean:.3} over {}", plural(scored.len(), "fixture with words", "fixtures with words")),
    None => writeln!(human, "mean WER: no fixture with words was scored"),
  }
  .map_err(written)?;
  writeln!(
    human,
    "{}: {} passed, {} over budget, {} mismatched, {}, {} skipped, {}",
    plural(rows.len(), "fixture", "fixtures"),
    counts.pass,
    counts.over_budget,
    counts.mismatch,
    plural(counts.known, "known issue", "known issues"),
    counts.skipped,
    plural(counts.error, "error", "errors")
  )
  .map_err(written)?;
  let with_words = scored.len();
  if json {
    let report = Report { fixtures: rows, mean_wer, with_words, counts };
    let document = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    writeln!(out, "{document}").map_err(written)?;
  }
  if failed > 0 {
    return Err(Failure::Failed(format!("{failed} of {} fixtures failed", cases.len())));
  }
  // Silence and noise alone, as on a Mac without the voices, say nothing about recognition.
  if with_words == 0 {
    return Err(Failure::Failed("no fixture with words was scored, so nothing was measured. Render the spoken ones with: dictate-lab fixtures".into()));
  }
  Ok(())
}

/// The `eval` command: every fixture in `dir`, heard with the `kind` of Whisper in `models`.
pub fn run(dir: &Path, models: &Path, kind: ModelKind, json: bool) -> Result<(), Failure> {
  let mut cases = cases(dir)?;
  cases.iter_mut().for_each(|case| case.fixture.for_model(kind));
  let mut engine = Engine::load(models, kind)?;
  score_all(&mut engine, &cases, json, &mut std::io::stdout(), &mut std::io::stderr())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::tests::scratch;
  use dictate_engine::{
    audio::Levels,
    error::{Error, Result},
    pipeline::{choose_language, LanguageFrom},
    vad::{Gate, Verdict as GateVerdict},
    whisper::{lang_id, Ask, Transcript},
  };
  use std::collections::VecDeque;

  /// A pipeline with no model: silence is unheard at the gate, the rest is speech in English, and
  /// Whisper says each of `says` in turn.
  struct Says {
    says: VecDeque<Result<&'static str>>,
    /// How many times it was given a fresh state.
    fresh: usize,
  }

  impl Says {
    fn new(says: impl IntoIterator<Item = Result<&'static str>>) -> Self {
      Self { says: says.into_iter().collect(), fresh: 0 }
    }
  }

  impl Transcriber for Says {
    fn gate(&mut self, pcm: &[f32]) -> Result<Gate> {
      if pcm.iter().all(|&s| s == 0.0) {
        return Err(Error::Unheard);
      }
      Ok(Gate { levels: Levels { peak: 0.5, rms: 0.1 }, verdict: GateVerdict::Speech { end: pcm.len(), segments: 1, keen: 1, by_level: false } })
    }

    fn speech(&mut self, pcm: &[f32]) -> Result<Vec<(usize, usize)>> {
      Ok(vec![(0, pcm.len())])
    }

    fn language(&mut self, _: &[f32], ask: &Ask, held: Option<i32>) -> Result<(i32, LanguageFrom)> {
      choose_language(ask, held, &|| false, || Ok((lang_id("en").unwrap(), 0.99)))
    }

    fn words(&mut self, _: &[f32], _: i32, _: &Ask) -> Result<Transcript> {
      let text = self.says.pop_front().expect("Whisper asked once too often")?;
      Ok(Transcript { text: text.into(), retried_without_prompt: false })
    }

    fn fresh(&mut self) -> Result<()> {
      self.fresh += 1;
      Ok(())
    }
  }

  fn case(name: &str, json: &str, pcm: Option<Vec<f32>>) -> Case {
    let fixture: Fixture = serde_json::from_str(json).unwrap();
    Case { name: name.into(), hearing: fixture.hearing().unwrap(), fixture, pcm }
  }

  fn speech() -> Option<Vec<f32>> {
    Some(vec![0.1; 2 * 16_000])
  }

  fn silence() -> Option<Vec<f32>> {
    Some(vec![0.0; 2 * 16_000])
  }

  /// Each case heard by `says`, with what was printed and whether the eval passed. A row's
  /// milliseconds read N, since a test can't know them.
  fn eval(says: Says, cases: &[Case], json: bool) -> (String, std::result::Result<(), Failure>) {
    let (mut out, mut table) = (Vec::new(), Vec::new());
    let done = score_all(&mut { says }, cases, json, &mut out, &mut table);
    let printed = String::from_utf8(out).unwrap();
    if json {
      return (printed, done);
    }
    let timeless = printed
      .lines()
      .map(|line| {
        let parts = line.split(", ").map(|part| match part.strip_suffix(" ms") {
          Some(n) if n.parse::<u128>().is_ok() => "N ms",
          _ => part,
        });
        parts.collect::<Vec<_>>().join(", ") + "\n"
      })
      .collect();
    (timeless, done)
  }

  const MEETING: &str = r#"{ "expect": "The meeting moved to Thursday afternoon.", "language": "en", "max_wer": 0.2 }"#;

  #[test]
  fn a_fixture_under_budget_passes() {
    let says = Says::new([Ok("The meeting moved to Tuesday afternoon.")]);
    let (printed, done) = eval(says, &[case("plain", MEETING, speech())], false);
    assert_eq!(done, Ok(()));
    assert_eq!(
      printed,
      "plain: pass, WER 0.167 (budget 0.20), S/D/I 1/0/0, N ms, \
       heard \"The meeting moved to Tuesday afternoon.\", \
       expected \"The meeting moved to Thursday afternoon.\"\n\
       mean WER 0.167 over 1 fixture with words\n\
       1 fixture: 1 passed, 0 over budget, 0 mismatched, 0 known issues, 0 skipped, 0 errors\n"
    );
  }

  #[test]
  fn one_over_budget_fails_the_eval() {
    let says = Says::new([Ok("The meeting moved to Tuesday."), Ok("Fine.")]);
    let cases = [case("plain", MEETING, speech()), case("short", r#"{ "expect": "Fine.", "max_wer": 0.05 }"#, speech())];
    let (printed, done) = eval(says, &cases, false);
    // main exits 1 on an Err.
    assert_eq!(done, Err(Failure::Failed("1 of 2 fixtures failed".into())));
    let lines: Vec<&str> = printed.lines().collect();
    // A row that didn't pass counts its edits, and marks the words dropped and added on a line of its own.
    assert!(lines[0].starts_with("plain: over budget, WER 0.333 (budget 0.20), S/D/I 1/1/0, "), "{printed}");
    assert_eq!(lines[1], "  diff: the meeting moved to [-thursday-] [-afternoon-] {+tuesday+}");
    assert!(lines[2].starts_with("short: pass, WER 0.000 (budget 0.05), S/D/I 0/0/0, "));
    assert_eq!(lines[3], "mean WER 0.167 over 2 fixtures with words");
    assert_eq!(lines[4], "2 fixtures: 1 passed, 1 over budget, 0 mismatched, 0 known issues, 0 skipped, 0 errors");
  }

  const UNHEARD: &str = r#"{ "synth": "silence", "expect_unheard": true }"#;

  #[test]
  fn expect_unheard_passes_when_nothing_is_heard() {
    // Unheard at the gate, and unheard by Whisper after a gate that let it through.
    let says = Says::new([Err(Error::Unheard)]);
    let cases = [case("silence", UNHEARD, silence()), case("noise", UNHEARD, speech())];
    let (printed, _) = eval(says, &cases, false);
    assert!(
      printed.starts_with(
        "silence: pass, WER 0.000 (budget 0.00), S/D/I 0/0/0, N ms, heard nothing, expected nothing\n\
         noise: pass, WER 0.000 (budget 0.00), "
      ),
      "{printed}"
    );
    // Unheard fixtures have no words to average.
    assert!(printed.contains("\nmean WER: no fixture with words was scored\n"));
  }

  #[test]
  fn an_eval_with_no_words_scored_fails() {
    // Only the synthesized fixtures were rendered, as on a Mac without the voices: nothing was measured.
    let says = Says::new([Err(Error::Unheard)]);
    let cases = [case("silence", UNHEARD, silence()), case("noise", UNHEARD, speech()), case("plain", MEETING, None)];
    let (_, done) = eval(says, &cases, false);
    assert_eq!(
      done,
      Err(Failure::Failed("no fixture with words was scored, so nothing was measured. Render the spoken ones with: dictate-lab fixtures".into()))
    );
  }

  #[test]
  fn expect_unheard_fails_when_words_are_heard() {
    let says = Says::new([Ok("Thank you for watching.")]);
    let (printed, done) = eval(says, &[case("noise", UNHEARD, speech())], false);
    assert_eq!(done, Err(Failure::Failed("1 of 1 fixtures failed".into())));
    assert!(
      printed.starts_with(
        "noise: over budget, WER 1.000 (budget 0.00), S/D/I 0/0/4, N ms, \
         heard \"Thank you for watching.\", expected nothing\n\
         \x20 diff: {+thank+} {+you+} {+for+} {+watching+}\n"
      ),
      "{printed}"
    );
  }

  #[test]
  fn expect_unheard_fails_on_any_words_whatever_its_budget() {
    let loose = r#"{ "synth": "noise", "expect_unheard": true, "max_wer": 1.0 }"#;
    let says = Says::new([Ok("Thank you.")]);
    let (printed, done) = eval(says, &[case("noise", loose, speech())], false);
    assert_eq!(done, Err(Failure::Failed("1 of 1 fixtures failed".into())));
    assert!(printed.starts_with("noise: mismatch, words were heard, expected none, WER 1.000 (budget 1.00), "), "{printed}");
  }

  #[test]
  fn a_missing_wav_beside_its_json_is_skipped() {
    let dir = scratch("eval-missing");
    std::fs::write(dir.join("plain.json"), MEETING).unwrap();
    crate::wav::write(&dir.join("plain.wav"), &speech().unwrap()).unwrap();
    std::fs::write(dir.join("turkish.json"), r#"{ "say": "Merhaba.", "voice": "Yelda", "expect": "Merhaba.", "language": "auto" }"#).unwrap();
    // A WAV without its JSON is not a fixture.
    crate::wav::write(&dir.join("stray.wav"), &speech().unwrap()).unwrap();
    let found = cases(&dir).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(found.len(), 2);
    assert!(found[0].pcm.is_some() && found[1].pcm.is_none());

    let says = Says::new([Ok("The meeting moved to Thursday afternoon.")]);
    let (printed, done) = eval(says, &found, false);
    // A skip is neither a pass nor a failure.
    assert_eq!(done, Ok(()));
    let lines: Vec<&str> = printed.lines().collect();
    assert_eq!(lines[1], "turkish: skipped, no turkish.wav beside turkish.json; it needs the voice Yelda");
    assert_eq!(lines[3], "2 fixtures: 1 passed, 0 over budget, 0 mismatched, 0 known issues, 1 skipped, 0 errors");

    // An empty folder, or none, says how to fill it, and stops the lab.
    let dir = scratch("eval-empty");
    let Err(Failure::Broken(err)) = cases(&dir) else { panic!("an empty folder stops the lab") };
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(err.ends_with("holds no fixtures. Render them with: dictate-lab fixtures"), "{err}");
    assert!(matches!(cases(&dir), Err(Failure::Broken(_))));
  }

  #[test]
  fn a_stage_error_is_counted_as_an_error() {
    let says = Says::new([Err(Error::NotUnderstood)]);
    let (printed, done) = eval(says, &[case("plain", MEETING, speech())], false);
    assert_eq!(done, Err(Failure::Failed("1 of 1 fixtures failed".into())));
    assert!(printed.starts_with("plain: error, Couldn’t understand that, N ms, heard nothing, "), "{printed}");
    assert!(printed.ends_with("0 mismatched, 0 known issues, 0 skipped, 1 error\n"), "{printed}");
  }

  #[test]
  fn a_note_that_skips_a_piece_is_an_error() {
    let says = Says::new([Err(Error::NotUnderstood)]);
    let note = r#"{ "expect": "Here is the plan.", "note": true, "max_wer": 1.0 }"#;
    let (printed, done) = eval(says, &[case("note", note, speech())], false);
    assert_eq!(done, Err(Failure::Failed("1 of 1 fixtures failed".into())));
    assert!(printed.starts_with("note: error, skipped 1 piece, "), "{printed}");
  }

  #[test]
  fn a_sticky_and_a_send_are_checked() {
    let sticky = r#"{ "expect": "Sticky, call Thomas.", "expect_sticky": "Call Thomas", "max_wer": 0.5 }"#;
    let send = r#"{ "expect": "See you soon. Send.", "expect_send": true, "max_wer": 0.5 }"#;
    let says = Says::new([Ok("Sticky, call Thomas."), Ok("See you soon. Send.")]);
    let cases = [case("sticky", sticky, speech()), case("send", send, speech())];
    let (printed, done) = eval(says, &cases, false);
    assert_eq!(done, Ok(()), "{printed}");

    // Heard close enough to be in budget, but not as a sticky or a send.
    let says = Says::new([Ok("Sticky, call Tom."), Ok("See you soon, son.")]);
    let (printed, done) = eval(says, &cases, false);
    assert_eq!(done, Err(Failure::Failed("2 of 2 fixtures failed".into())));
    let lines: Vec<&str> = printed.lines().collect();
    assert!(lines[0].starts_with("sticky: mismatch, sticky \"Call Tom.\", expected \"Call Thomas\", "), "{printed}");
    assert_eq!(lines[1], "  diff: sticky call [-thomas-] {+tom+}");
    assert!(lines[2].starts_with("send: mismatch, no spoken send, expected one, "), "{printed}");
    assert!(lines[5].contains(" 2 mismatched, "), "{printed}");

    let says = Says::new([Ok("Call Thomas."), Ok("Thanks. Send.")]);
    let cases = [case("sticky", sticky, speech()), case("nosend", r#"{ "expect": "Thanks. Send.", "expect_send": false, "max_wer": 0.5 }"#, speech())];
    let (printed, _) = eval(says, &cases, false);
    let lines: Vec<&str> = printed.lines().collect();
    assert!(lines[0].starts_with("sticky: mismatch, no sticky, expected \"Call Thomas\", "), "{printed}");
    assert!(lines[2].starts_with("nosend: mismatch, a spoken send, expected none, "), "{printed}");
  }

  #[test]
  fn expect_typed_is_compared_exactly() {
    // The final typed text, after a spoken send is taken off; only the ends' whitespace is trimmed.
    let launch = r#"{ "expect": "So, I think we should move the launch.", "expect_typed": " So, I think we should move the launch. ", "max_wer": 0.05 }"#;
    let send = r#"{ "expect": "See you soon. Send.", "expect_typed": "See you soon.", "max_wer": 0.05 }"#;
    let cases = [case("fillers", launch, speech()), case("send", send, speech())];
    let says = Says::new([Ok("So, I think we should move the launch."), Ok("See you soon. Send.")]);
    let (printed, done) = eval(says, &cases, false);
    assert_eq!(done, Ok(()), "{printed}");

    // A difference in case alone scores WER 0, and still mismatches.
    let says = Says::new([Ok("so, i think we should move the launch."), Ok("See you soon, send.")]);
    let (printed, done) = eval(says, &cases, false);
    assert_eq!(done, Err(Failure::Failed("2 of 2 fixtures failed".into())));
    let lines: Vec<&str> = printed.lines().collect();
    assert!(
      lines[0].starts_with(
        "fillers: mismatch, typed \"so, i think we should move the launch.\", \
         expected exactly \" So, I think we should move the launch. \", WER 0.000 (budget 0.05), "
      ),
      "{printed}"
    );
    assert!(lines[1].starts_with("send: mismatch, typed \"See you soon\", expected exactly \"See you soon.\", WER 0.000 "), "{printed}");
  }

  #[test]
  fn a_known_issue_is_scored_and_never_fails_the_eval() {
    let bare = r#"{ "expect": "See you tomorrow. Send.", "expect_send": true, "max_wer": 0.05,
      "known_issue": "a bare \". Send.\" is heard as \"sand\"" }"#;
    let exact = r#"{ "expect": "Hello there.", "expect_typed": "Hello there!", "max_wer": 0.05,
      "known_issue": "an exclamation mark comes out as a full stop" }"#;
    let says = Says::new([Ok("See you tomorrow, sand."), Ok("Hello there."), Ok("See you tomorrow. Send."), Ok("The meeting moved to Thursday afternoon.")]);
    let cases = [case("send-bare", bare, speech()), case("exact", exact, speech()), case("send-fixed", bare, speech()), case("plain", MEETING, speech())];
    let (printed, done) = eval(says, &cases, false);
    assert_eq!(done, Ok(()), "{printed}");
    let lines: Vec<&str> = printed.lines().collect();
    assert_eq!(
      lines[..6],
      [
        "send-bare: known, a bare \". Send.\" is heard as \"sand\", still over budget, WER 0.250 (budget 0.05), \
         S/D/I 1/0/0, N ms, heard \"See you tomorrow, sand.\", expected \"See you tomorrow. Send.\"",
        "  diff: see you tomorrow [-send-] {+sand+}",
        "exact: known, an exclamation mark comes out as a full stop, still a mismatch: typed \"Hello there.\", \
         expected exactly \"Hello there!\", WER 0.000 (budget 0.05), S/D/I 0/0/0, N ms, \
         heard \"Hello there.\", expected \"Hello there.\"",
        // One that passes again says so, and still never counts as a pass.
        "send-fixed: known, a bare \". Send.\" is heard as \"sand\", passes now, so take known_issue out of \
         send-fixed.json, WER 0.000 (budget 0.05), S/D/I 0/0/0, N ms, \
         heard \"See you tomorrow. Send.\", expected \"See you tomorrow. Send.\"",
        "plain: pass, WER 0.000 (budget 0.20), S/D/I 0/0/0, N ms, \
         heard \"The meeting moved to Thursday afternoon.\", expected \"The meeting moved to Thursday afternoon.\"",
        "mean WER 0.062 over 4 fixtures with words",
      ]
    );
    assert_eq!(lines[6], "4 fixtures: 1 passed, 0 over budget, 0 mismatched, 3 known issues, 0 skipped, 0 errors");
    let (json, _) = eval(Says::new([Ok("See you tomorrow, sand.")]), &[case("send-bare", bare, speech())], true);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!((&v["fixtures"][0]["verdict"], &v["counts"]["known"]), (&"known".into(), &1.into()));

    // A stage that fails is not the issue it is known for: that is still an error.
    let says = Says::new([Err(Error::NotUnderstood)]);
    let (printed, done) = eval(says, &[case("send-bare", bare, speech())], false);
    assert_eq!(done, Err(Failure::Failed("1 of 1 fixtures failed".into())));
    assert!(printed.starts_with("send-bare: error, "), "{printed}");
  }

  #[test]
  fn a_known_issue_on_one_model_is_held_to_its_budget_on_another() {
    let json = r#"{ "expect": "Where are the keys?", "max_wer": 0.05,
      "known_issue": "Turbo makes up a \"The\"", "known_on": "turbo" }"#;
    let heard = |kind| {
      let mut question = case("question", json, speech());
      question.fixture.for_model(kind);
      eval(Says::new([Ok("Where are the keys? The")]), &[question], false)
    };
    let (printed, done) = heard(ModelKind::Turbo);
    assert_eq!(done, Ok(()), "{printed}");
    assert!(printed.starts_with("question: known, Turbo makes up a \"The\", still over budget"), "{printed}");
    let (printed, done) = heard(ModelKind::Small);
    assert_eq!(done, Err(Failure::Failed("1 of 1 fixtures failed".into())));
    assert!(printed.starts_with("question: over budget, "), "{printed}");
  }

  #[test]
  fn each_fixture_after_the_first_is_heard_on_a_fresh_state() {
    let cases =
      [case("one", MEETING, speech()), case("turkish", r#"{ "expect": "Merhaba." }"#, None), case("two", MEETING, speech()), case("three", MEETING, speech())];
    let mut says = Says::new((0..3).map(|_| Ok("The meeting moved to Thursday afternoon.")));
    score_all(&mut says, &cases, true, &mut Vec::new(), &mut Vec::new()).unwrap();
    assert_eq!((says.says.len(), says.fresh), (0, 2));
  }

  #[test]
  fn json_puts_the_table_on_its_own_writer() {
    let cases = [case("plain", MEETING, speech())];
    let (mut out, mut table) = (Vec::new(), Vec::new());
    let says = Says::new([Ok("The meeting moved to Tuesday.")]);
    let _ = score_all(&mut { says }, &cases, true, &mut out, &mut table);
    serde_json::from_slice::<serde_json::Value>(&out).unwrap();
    let table = String::from_utf8(table).unwrap();
    assert!(table.starts_with("plain: "), "{table}");
    assert!(table.contains("mean WER"), "{table}");
    assert!(table.lines().last().unwrap().starts_with("1 fixture: "), "{table}");
  }

  #[test]
  fn json_is_one_document() {
    let says = Says::new([Ok("The meeting moved to Tuesday."), Err(Error::Unheard)]);
    let cases = [case("plain", MEETING, speech()), case("noise", UNHEARD, speech()), case("turkish", r#"{ "expect": "Merhaba." }"#, None)];
    let (printed, done) = eval(says, &cases, true);
    assert_eq!(done, Err(Failure::Failed("1 of 3 fixtures failed".into())));
    let v: serde_json::Value = serde_json::from_str(&printed).unwrap();
    let rows = v["fixtures"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!((&rows[0]["name"], &rows[0]["verdict"]), (&"plain".into(), &"over_budget".into()));
    assert!((rows[0]["wer"].as_f64().unwrap() - 2.0 / 6.0).abs() < 1e-9);
    assert_eq!(rows[0]["score"], serde_json::json!({ "substitutions": 1, "deletions": 1, "insertions": 0, "reference": 6 }));
    assert_eq!(rows[0]["diff"], "the meeting moved to [-thursday-] [-afternoon-] {+tuesday+}");
    assert_eq!(rows[0]["heard"], "The meeting moved to Tuesday.");
    assert_eq!(rows[0]["trace"]["gate"]["verdict"], "speech");
    assert_eq!((&rows[1]["verdict"], &rows[1]["heard"], &rows[1]["diff"]), (&"pass".into(), &serde_json::Value::Null, &serde_json::Value::Null));
    assert_eq!(rows[2]["verdict"], "skipped");
    assert!(rows[2]["trace"].is_null() && rows[2]["wer"].is_null() && rows[2]["score"].is_null());
    assert!((v["mean_wer"].as_f64().unwrap() - 2.0 / 6.0).abs() < 1e-9);
    assert_eq!(v["with_words"], 1);
    assert_eq!(v["counts"], serde_json::json!({ "pass": 1, "over_budget": 1, "mismatch": 0, "known": 0, "skipped": 1, "error": 0 }));
  }
}
