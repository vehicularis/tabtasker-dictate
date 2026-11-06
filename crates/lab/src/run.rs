//! The `run` command: one recording through the pipeline's stages, with what each stage found.
//!
//! The stages go as the app's pass does (`src-tauri/src/dictation/speech.rs`): the gate, the language,
//! Whisper, the text rules a typing mode finishes with, then what it does with a spoken sticky or
//! "send". A note is heard piece by piece through `pieces::hear_long`, as the app hears a long one.

use crate::wav;
use dictate_engine::{
  audio::{self, Levels},
  error::{Error, Result},
  models::{self, ModelKind},
  pieces,
  pipeline::{self, LanguageFrom, SURE},
  text::{finish, sticky_words, without_send, Rules, Style},
  vad::{Gate, SpeechDetector, Verdict},
  whisper::{lang_code, Ask, Transcript, Whisper},
  SAMPLE_RATE,
};
use serde::Serialize;
use std::{
  cell::RefCell,
  fmt,
  io::Write,
  path::{Path, PathBuf},
  sync::atomic::AtomicBool,
  time::Instant,
};

/// The pipeline's stages as the lab drives them. [`Engine`] is the real one; tests and eval can stand a
/// fake in for the models.
pub trait Transcriber {
  /// The gates: the audio's levels, whether it is speech, and where that ends.
  fn gate(&mut self, pcm: &[f32]) -> Result<Gate>;
  /// The speech in `pcm` as sample ranges, which is where a long note is cut into pieces.
  fn speech(&mut self, pcm: &[f32]) -> Result<Vec<(usize, usize)>>;
  /// The pass's language, by Whisper's id, and where it came from.
  fn language(&mut self, pcm: &[f32], ask: &Ask) -> Result<(i32, LanguageFrom)>;
  /// Whisper's words in `language`.
  fn words(&mut self, pcm: &[f32], language: i32, ask: &Ask) -> Result<Transcript>;
}

/// Whisper and the speech detection beside it, loaded from the models folder.
pub struct Engine {
  whisper: Whisper,
  vad: SpeechDetector,
}

impl Engine {
  /// The `kind` of Whisper and the speech detection from `dir`, each checked first. A file that is
  /// missing or fails its check is named, with the command that downloads it.
  pub fn load(dir: &Path, kind: ModelKind) -> std::result::Result<Self, String> {
    let name = match kind {
      ModelKind::Small => "small",
      ModelKind::Turbo => "turbo",
    };
    let fetch = format!("Download it with: dictate-lab fetch --model {name}");
    let [whisper, silero] = kind.files() else {
      unreachable!("a model kind is its Whisper and the speech detection");
    };
    let path = |model: &models::ModelFile| dir.join(model.name);
    for model in [whisper, silero] {
      let path = path(model);
      if !path.exists() {
        return Err(format!("{} is missing. {fetch}", path.display()));
      }
      models::verified(&path, model).map_err(|e| format!("{}: {e} {fetch}", path.display()))?;
    }
    let loaded = |model: &models::ModelFile, e: Error| format!("{}: {e}", path(model).display());
    Ok(Self {
      whisper: Whisper::load(&path(whisper), kind).map_err(|e| loaded(whisper, e))?,
      vad: SpeechDetector::load(&path(silero)).map_err(|e| loaded(silero, e))?,
    })
  }
}

/// The app's final pass: never stopped, five beams.
impl Transcriber for Engine {
  fn gate(&mut self, pcm: &[f32]) -> Result<Gate> {
    self.vad.gate(pcm)
  }

  fn speech(&mut self, pcm: &[f32]) -> Result<Vec<(usize, usize)>> {
    self.vad.speech_ranges(pcm)
  }

  fn language(&mut self, pcm: &[f32], ask: &Ask) -> Result<(i32, LanguageFrom)> {
    pipeline::language(&mut self.whisper, pcm, ask, None, &|| false)
  }

  fn words(&mut self, pcm: &[f32], language: i32, ask: &Ask) -> Result<Transcript> {
    self
      .whisper
      .transcribe(pcm, language, ask, &|| false, false)
  }
}

/// How a recording is heard: what Settings would ask of the pass, and how its words are finished.
#[derive(Debug, Default, PartialEq)]
pub struct Hearing {
  /// The language pinned, by Whisper's id; None detects it.
  pub language: Option<i32>,
  /// Whether to translate to English.
  pub translate: bool,
  /// The vocabulary, newest first.
  pub words: Vec<String>,
  /// The style the words are finished in.
  pub style: Style,
  /// Whether fillers are dropped.
  pub fillers: bool,
  /// Whether it is heard piece by piece, as a long note is.
  pub note: bool,
}

/// What each stage made of one recording, in the order they ran. A stage the app would not reach is
/// left out.
#[derive(Debug, Serialize)]
pub struct Trace {
  /// The file, as it was named.
  pub file: String,
  /// How long it is.
  pub seconds: f32,
  /// Whether it was heard as a long note.
  pub note: bool,
  /// What the gates found; None when they failed.
  pub gate: Option<GateTrace>,
  /// Each pass: one for a hold, one for each piece of a note.
  pub passes: Vec<Pass>,
  /// Whisper's words, every piece's joined.
  pub heard: Option<String>,
  /// The words after `text::finish`.
  pub typed: Option<String>,
  /// What a typing mode does with them next: a sticky instead, or the words without a spoken "send".
  pub spoken: Option<Spoken>,
  /// Whether the app would end here quietly, with nothing to type.
  pub unheard: bool,
  /// The error a stage failed with.
  pub error: Option<String>,
  /// The pieces of a note Whisper failed on, which the app skips: their words are missing.
  pub skipped: usize,
  /// Milliseconds in each stage.
  pub ms: Times,
}

/// What a typing mode does with the finished words, as the app's `dictate_audio` does.
#[derive(Debug, Serialize)]
pub struct Spoken {
  /// The sticky's words, when "Sticky: ..." puts one on screen instead of typing.
  pub sticky: Option<String>,
  /// Whether a spoken "send" ended the words, so Return follows them.
  pub send: bool,
  /// What is typed: nothing for a sticky, the words without their "send" otherwise.
  pub text: String,
}

impl Spoken {
  fn of(typed: &str) -> Self {
    match sticky_words(typed) {
      Some(words) => Self {
        sticky: Some(words),
        send: false,
        text: String::new(),
      },
      None => {
        let (text, send) = without_send(typed);
        Self {
          sticky: None,
          send,
          text,
        }
      }
    }
  }
}

/// The gates' verdict.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GateVerdict {
  /// Speech: the pass goes on.
  Speech,
  /// Nothing to hear: a hold ends quietly here.
  Unheard,
}

/// Where a pass's language came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguageSource {
  /// Pinned, here by --language.
  Settings,
  /// Kept from an earlier piece of the note.
  Hold,
  /// Detected from this pass's audio.
  Detected,
}

/// What the gates made of the audio.
#[derive(Debug, Serialize)]
pub struct GateTrace {
  /// Speech, or unheard where a hold ends quietly.
  pub verdict: GateVerdict,
  /// Why it is unheard.
  pub why: Option<&'static str>,
  /// The loudest sample.
  pub peak: f32,
  /// The RMS of the loudest tenth of a second.
  pub rms: f32,
  /// Where the speech ends, in seconds.
  pub end: Option<f32>,
  /// The speech segments the detection found.
  pub segments: usize,
  /// The segments its keener pass found, which set the end.
  pub keen: usize,
  /// No segment was found, but the level is plainly a voice.
  pub by_level: bool,
}

/// One pass: the language, then Whisper's words.
#[derive(Debug, Serialize)]
pub struct Pass {
  /// Where its audio starts, in seconds.
  pub start: f32,
  /// Where its audio ends, in seconds.
  pub end: f32,
  /// The language's code; None when it couldn't be told.
  pub language: Option<String>,
  /// Where the language came from.
  pub from: Option<LanguageSource>,
  /// How sure detection was.
  pub sure: Option<f32>,
  /// Whisper's words; empty when it heard nothing it was sure of.
  pub words: String,
  /// Whether Whisper recited the vocabulary, so the audio was heard again without it.
  pub retried: bool,
  /// The error the pass failed with.
  pub error: Option<String>,
}

/// Milliseconds in each stage.
#[derive(Debug, Default, Serialize)]
pub struct Times {
  /// The gates.
  pub gate: u128,
  /// Finding the speech a note is cut by.
  pub speech: u128,
  /// Choosing the language, in every pass.
  pub language: u128,
  /// Whisper, in every pass.
  pub whisper: u128,
}

fn seconds(samples: usize) -> f32 {
  samples as f32 / SAMPLE_RATE as f32
}

impl GateTrace {
  fn unheard(Levels { peak, rms }: Levels, why: &'static str) -> Self {
    Self {
      verdict: GateVerdict::Unheard,
      why: Some(why),
      peak,
      rms,
      end: None,
      segments: 0,
      keen: 0,
      by_level: false,
    }
  }

  fn of(gate: &Gate, samples: usize) -> Self {
    match gate.verdict {
      Verdict::TooQuiet => Self::unheard(gate.levels, "too quiet to hold a word"),
      Verdict::NoVoice => Self::unheard(
        gate.levels,
        "no speech detected and not loud enough to count as a voice",
      ),
      Verdict::Speech {
        end,
        segments,
        keen,
        by_level,
      } => Self {
        verdict: GateVerdict::Speech,
        why: None,
        peak: gate.levels.peak,
        rms: gate.levels.rms,
        end: Some(seconds(end.min(samples))),
        segments,
        keen,
        by_level,
      },
    }
  }
}

/// `pcm` through every stage the app's pass would reach, as `how` asks.
pub fn trace(t: &mut dyn Transcriber, file: &str, pcm: &[f32], how: &Hearing) -> Trace {
  let ask = Ask {
    language: how.language,
    translate: how.translate,
    words: how.words.clone(),
  };
  let mut trace = Trace {
    file: file.to_string(),
    seconds: seconds(pcm.len()),
    note: how.note,
    gate: None,
    passes: Vec::new(),
    heard: None,
    typed: None,
    spoken: None,
    unheard: false,
    error: None,
    skipped: 0,
    ms: Times::default(),
  };
  let started = Instant::now();
  let gate = t.gate(pcm);
  trace.ms.gate = started.elapsed().as_millis();
  let gate = match gate {
    Ok(gate) => GateTrace::of(&gate, pcm.len()),
    // Not worth a pass at all (audio::worth_a_pass): unheard before speech detection looks.
    Err(Error::Unheard) => GateTrace::unheard(
      audio::levels(pcm),
      "under a quarter second, silent, not finite or over ten minutes",
    ),
    Err(e) => {
      trace.error = Some(e.to_string());
      return trace;
    }
  };
  let unheard = gate.verdict == GateVerdict::Unheard;
  trace.gate = Some(gate);
  // A hold ends quietly at the gate; the app hears a long note piece by piece without it.
  if unheard && !how.note {
    trace.unheard = true;
    return trace;
  }
  let heard = if how.note {
    note(t, pcm, &ask, &mut trace)
  } else {
    let (pass, heard) = hear(t, pcm, 0, &ask, &mut None, &mut trace.ms);
    trace.passes.push(pass);
    heard
  };
  match heard {
    Ok(text) => {
      // The text rules' language, as the app's: English when translating, else the newest pass's.
      let language = if ask.translate {
        Some("en")
      } else {
        trace
          .passes
          .iter()
          .rev()
          .find_map(|p| p.language.as_deref())
      };
      let rules = Rules {
        style: how.style,
        fillers: how.fillers,
        replacements: &[],
        language,
        live: false,
      };
      let typed = finish(&text, &rules);
      trace.spoken = Some(Spoken::of(&typed));
      trace.typed = Some(typed);
      trace.heard = Some(text);
    }
    Err(Error::Unheard) => trace.unheard = true,
    Err(e) => trace.error = Some(e.to_string()),
  }
  trace
}

/// One pass over `pcm`, which starts `start` samples into the recording: the language (a note's
/// earlier sure one, `held`, when nothing is pinned), then Whisper's words.
fn hear(
  t: &mut dyn Transcriber,
  pcm: &[f32],
  start: usize,
  ask: &Ask,
  held: &mut Option<i32>,
  ms: &mut Times,
) -> (Pass, Result<String>) {
  let mut pass = Pass {
    start: seconds(start),
    end: seconds(start + pcm.len()),
    language: None,
    from: None,
    sure: None,
    words: String::new(),
    retried: false,
    error: None,
  };
  let started = Instant::now();
  let language = match *held {
    Some(id) if ask.language.is_none() => Ok((id, LanguageFrom::Hold)),
    _ => t.language(pcm, ask),
  };
  ms.language += started.elapsed().as_millis();
  let (language, from) = match language {
    Ok(language) => language,
    Err(e) => {
      pass.error = Some(e.to_string());
      return (pass, Err(e));
    }
  };
  // Kept for the note's later pieces only when detection was sure of it, as the app keeps a hold's.
  if let LanguageFrom::Detected { sure } = from {
    if sure >= SURE {
      *held = Some(language);
    }
  }
  pass.language = lang_code(language).map(String::from);
  (pass.from, pass.sure) = match from {
    LanguageFrom::Settings => (Some(LanguageSource::Settings), None),
    LanguageFrom::Hold => (Some(LanguageSource::Hold), None),
    LanguageFrom::Detected { sure } => (Some(LanguageSource::Detected), Some(sure)),
  };
  let started = Instant::now();
  let words = t.words(pcm, language, ask);
  ms.whisper += started.elapsed().as_millis();
  match words {
    Ok(heard) => {
      pass.retried = heard.retried_without_prompt;
      pass.words.clone_from(&heard.text);
      (pass, Ok(heard.text))
    }
    Err(Error::Unheard) => (pass, Err(Error::Unheard)),
    Err(e) => {
      pass.error = Some(e.to_string());
      (pass, Err(e))
    }
  }
}

/// `pcm` heard piece by piece through `pieces::hear_long`, as the app hears a long note, with each
/// piece's pass in `trace`.
fn note(t: &mut dyn Transcriber, pcm: &[f32], ask: &Ask, trace: &mut Trace) -> Result<String> {
  // hear_long asks its two closures for the stages one after the other, never at once.
  let t = RefCell::new(t);
  let Trace {
    passes,
    ms,
    skipped,
    ..
  } = trace;
  let (mut speech_ms, mut start, mut held) = (0, 0, None);
  let heard = pieces::hear_long(
    String::new(),
    pcm,
    |rest| {
      let started = Instant::now();
      let found = t.borrow_mut().speech(rest);
      speech_ms += started.elapsed().as_millis();
      found
    },
    |piece| {
      let (pass, words) = hear(&mut **t.borrow_mut(), piece, start, ask, &mut held, ms);
      // The pieces run on from the start, each where the last ended.
      start += piece.len();
      passes.push(pass);
      // A piece Whisper heard nothing in adds no words, as the app's piece does.
      match words {
        Err(Error::Unheard) => Ok(String::new()),
        other => other,
      }
    },
    &AtomicBool::new(false),
  );
  ms.speech += speech_ms;
  *skipped = passes.iter().filter(|pass| pass.error.is_some()).count();
  heard
}

impl fmt::Display for GateTrace {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let levels = format!("peak {:.4}, loudest rms {:.4}", self.peak, self.rms);
    match self.end {
      Some(end) => write!(
        f,
        "speech ends at {end:.2} s ({} segment{}{}, {levels})",
        self.segments,
        if self.segments == 1 { "" } else { "s" },
        if self.by_level {
          ", let through by its level"
        } else {
          ""
        }
      ),
      None => write!(f, "unheard, {} ({levels})", self.why.unwrap_or_default()),
    }
  }
}

impl fmt::Display for Pass {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let error = self.error.as_deref().unwrap_or_default();
    let Some(code) = &self.language else {
      return writeln!(f, "language: failed, {error}");
    };
    match (self.from, self.sure) {
      (_, Some(sure)) => writeln!(f, "language: {code}, detected, {sure:.2} sure")?,
      (Some(LanguageSource::Hold), _) => {
        writeln!(f, "language: {code}, kept from an earlier piece")?
      }
      _ => writeln!(f, "language: {code}, set by --language")?,
    }
    match (&self.error, self.words.as_str()) {
      (Some(_), _) => writeln!(f, "whisper: failed, {error}"),
      (None, "") => writeln!(f, "whisper: unheard, nothing it was sure of"),
      (None, words) => writeln!(
        f,
        "whisper: \"{words}\" (vocabulary retry: {})",
        if self.retried { "yes" } else { "no" }
      ),
    }
  }
}

/// One stage a line, ending with the time each took.
impl fmt::Display for Trace {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let error = self.error.as_deref().unwrap_or_default();
    writeln!(f, "file: {}, {:.2} s", self.file, self.seconds)?;
    let Some(gate) = &self.gate else {
      writeln!(f, "gate: failed, {error}")?;
      return writeln!(f, "times: gate {} ms", self.ms.gate);
    };
    let goes_on = if self.note && gate.verdict == GateVerdict::Unheard {
      "; a note goes on to its pieces"
    } else {
      ""
    };
    writeln!(f, "gate: {gate}{goes_on}")?;
    for (i, pass) in self.passes.iter().enumerate() {
      if self.note {
        writeln!(f, "piece {}: {:.2} to {:.2} s", i + 1, pass.start, pass.end)?;
      }
      write!(f, "{pass}")?;
    }
    if self.note {
      match &self.heard {
        Some(heard) => writeln!(f, "heard: \"{heard}\"")?,
        None if self.unheard => writeln!(f, "heard: unheard, no words came of it")?,
        None => writeln!(f, "heard: failed, {error}")?,
      }
      let s = if self.skipped == 1 { "" } else { "s" };
      writeln!(f, "skipped: {} piece{s}", self.skipped)?;
    }
    if let Some(typed) = &self.typed {
      writeln!(f, "typed: \"{typed}\"")?;
    }
    match &self.spoken {
      Some(Spoken {
        sticky: Some(sticky),
        ..
      }) => writeln!(f, "spoken: sticky \"{sticky}\", types nothing")?,
      Some(Spoken { send, text, .. }) => writeln!(
        f,
        "spoken: types \"{text}\", {}",
        if *send { "then sends" } else { "no send" }
      )?,
      None => {}
    }
    write!(f, "times: gate {} ms", self.ms.gate)?;
    if self.note {
      write!(f, ", speech {} ms", self.ms.speech)?;
    }
    if !self.passes.is_empty() {
      write!(
        f,
        ", language {} ms, whisper {} ms",
        self.ms.language, self.ms.whisper
      )?;
    }
    writeln!(f)
  }
}

/// Hears each of `files` with the `kind` of Whisper in `dir` (see [`hear_all`]). Fails when a file
/// can't be read or the models can't load, too.
pub fn run(
  dir: &Path,
  files: &[PathBuf],
  kind: ModelKind,
  how: &Hearing,
  json: bool,
) -> std::result::Result<(), String> {
  // Every file is read before the model loads, so a wrong one fails at once.
  let recordings = files
    .iter()
    .map(|path| Ok((path.display().to_string(), wav::read(path)?)))
    .collect::<std::result::Result<Vec<_>, String>>()?;
  let mut engine = Engine::load(dir, kind)?;
  hear_all(&mut engine, &recordings, how, json, &mut std::io::stdout())
}

/// Hears each named recording with `t`, writing each trace to `out` as plain lines, or all of them as
/// one JSON array. Fails when a stage failed on any recording, or a note skipped a piece.
pub fn hear_all(
  t: &mut dyn Transcriber,
  recordings: &[(String, Vec<f32>)],
  how: &Hearing,
  json: bool,
  out: &mut dyn Write,
) -> std::result::Result<(), String> {
  let written = |e: std::io::Error| format!("cannot write the trace: {e}");
  let mut traces = Vec::new();
  for (name, pcm) in recordings {
    let one = trace(t, name, pcm, how);
    if !json {
      if !traces.is_empty() {
        writeln!(out).map_err(written)?;
      }
      write!(out, "{one}").map_err(written)?;
    }
    traces.push(one);
  }
  if json {
    let document = serde_json::to_string_pretty(&traces).map_err(|e| e.to_string())?;
    writeln!(out, "{document}").map_err(written)?;
  }
  let failed = traces
    .iter()
    .filter(|t| t.error.is_some() || t.skipped > 0)
    .count();
  match failed {
    0 => Ok(()),
    failed => Err(format!(
      "{failed} of {} recordings failed or skipped a piece",
      traces.len()
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use dictate_engine::whisper::lang_id;

  /// A pipeline with no model: speech or silence at the gate, English detected 0.98 sure, and words
  /// that name how many ms of audio each pass heard.
  struct Fake {
    speech: bool,
    /// Where speech is, in samples of the whole audio; each sample of a note's audio is its own position.
    said: Vec<(usize, usize)>,
    detected: usize,
    heard: Vec<usize>,
    /// Whisper fails on the first pass, as it can on one piece of a long note.
    fail_first: bool,
    /// What Whisper says instead of how much it heard.
    says: Option<&'static str>,
  }

  impl Fake {
    fn new(speech: bool) -> Self {
      Self {
        speech,
        said: Vec::new(),
        detected: 0,
        heard: Vec::new(),
        fail_first: false,
        says: None,
      }
    }
  }

  impl Transcriber for Fake {
    fn gate(&mut self, _: &[f32]) -> Result<Gate> {
      let verdict = if self.speech {
        Verdict::Speech {
          end: 2 * 16_000,
          segments: 3,
          keen: 4,
          by_level: false,
        }
      } else {
        Verdict::TooQuiet
      };
      Ok(Gate {
        levels: Levels {
          peak: 0.31,
          rms: 0.08,
        },
        verdict,
      })
    }

    fn speech(&mut self, rest: &[f32]) -> Result<Vec<(usize, usize)>> {
      let from = rest[0] as usize;
      Ok(
        self
          .said
          .iter()
          .filter(|&&(_, end)| end > from)
          .map(|&(start, end)| (start.saturating_sub(from), end - from))
          .collect(),
      )
    }

    fn language(&mut self, _: &[f32], ask: &Ask) -> Result<(i32, LanguageFrom)> {
      self.detected += 1;
      Ok(match ask.language {
        Some(id) => (id, LanguageFrom::Settings),
        None => (
          lang_id("en").unwrap(),
          LanguageFrom::Detected { sure: 0.98 },
        ),
      })
    }

    fn words(&mut self, pcm: &[f32], _: i32, ask: &Ask) -> Result<Transcript> {
      self.heard.push(pcm.len());
      if self.fail_first && self.heard.len() == 1 {
        return Err(Error::NotUnderstood);
      }
      Ok(Transcript {
        text: self
          .says
          .map_or_else(|| format!("um so {} ms", pcm.len() / 16), String::from),
        retried_without_prompt: !ask.words.is_empty(),
      })
    }
  }

  fn formal() -> Hearing {
    Hearing {
      style: Style::Formal,
      fillers: true,
      words: vec!["TabTasker".into()],
      ..Hearing::default()
    }
  }

  fn typed(raw: &str) -> String {
    finish(
      raw,
      &Rules {
        style: Style::Formal,
        fillers: true,
        replacements: &[],
        language: Some("en"),
        live: false,
      },
    )
  }

  #[test]
  fn a_trace_lists_every_stage() {
    let mut fake = Fake::new(true);
    let t = trace(&mut fake, "said.wav", &vec![0.1; 3 * 16_000], &formal());
    let gate = t.gate.as_ref().unwrap();
    assert_eq!(
      (gate.verdict, gate.end, gate.segments),
      (GateVerdict::Speech, Some(2.0), 3)
    );
    let [pass] = &t.passes[..] else {
      panic!("one pass: {:?}", t.passes)
    };
    assert_eq!(pass.language.as_deref(), Some("en"));
    assert_eq!(
      (pass.from, pass.sure),
      (Some(LanguageSource::Detected), Some(0.98))
    );
    assert_eq!((pass.words.as_str(), pass.retried), ("um so 3000 ms", true));
    assert_eq!(t.typed.as_deref(), Some(typed("um so 3000 ms").as_str()));
    let spoken = t.spoken.as_ref().unwrap();
    assert_eq!(
      (spoken.sticky.as_deref(), spoken.send, spoken.text.as_str()),
      (None, false, typed("um so 3000 ms").as_str())
    );
    assert!(!t.unheard && t.error.is_none());
    let printed = t.to_string();
    let lines: Vec<&str> = printed.lines().collect();
    assert_eq!(
      lines[..5],
      [
        "file: said.wav, 3.00 s",
        "gate: speech ends at 2.00 s (3 segments, peak 0.3100, loudest rms 0.0800)",
        "language: en, detected, 0.98 sure",
        "whisper: \"um so 3000 ms\" (vocabulary retry: yes)",
        &format!("typed: \"{}\"", typed("um so 3000 ms")),
      ]
    );
    assert_eq!(
      lines[5],
      format!("spoken: types \"{}\", no send", typed("um so 3000 ms"))
    );
    assert!(lines[6].starts_with("times: gate "), "{printed}");
    assert!(
      lines[6].contains(" ms, language ") && lines[6].ends_with(" ms"),
      "{printed}"
    );
    assert_eq!(lines.len(), 7, "{printed}");
    // The JSON keeps the stages in the struct's order.
    let json = serde_json::to_string(&t).unwrap();
    let at = |key: &str| json.find(&format!("\"{key}\":")).unwrap();
    assert!(
      at("file") < at("gate")
        && at("gate") < at("passes")
        && at("passes") < at("typed")
        && at("typed") < at("spoken")
        && at("spoken") < at("unheard")
        && at("unheard") < at("ms"),
      "{json}"
    );
    // The enums keep the spellings the JSON has always had.
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
      (&value["gate"]["verdict"], &value["passes"][0]["from"]),
      (&"speech".into(), &"detected".into())
    );

    // A language set with --language is the pass's, never detected.
    let mut fake = Fake::new(true);
    let pinned = Hearing {
      language: lang_id("de"),
      ..Hearing::default()
    };
    let t = trace(&mut fake, "said.wav", &vec![0.1; 16_000], &pinned);
    assert_eq!(t.passes[0].language.as_deref(), Some("de"));
    assert_eq!(
      serde_json::to_value(&t).unwrap()["passes"][0]["from"],
      "settings"
    );
    assert!(t
      .to_string()
      .contains("\nlanguage: de, set by --language\n"));
  }

  #[test]
  fn an_unheard_gate_stops_the_trace_there() {
    let mut fake = Fake::new(false);
    let t = trace(&mut fake, "quiet.wav", &vec![0.0005; 16_000], &formal());
    assert!(t.unheard);
    assert_eq!(t.gate.as_ref().unwrap().verdict, GateVerdict::Unheard);
    assert_eq!(
      serde_json::to_value(&t).unwrap()["gate"]["verdict"],
      "unheard"
    );
    assert!(t.passes.is_empty() && t.typed.is_none() && t.spoken.is_none());
    assert_eq!((fake.detected, fake.heard.len()), (0, 0));
    let printed = t.to_string();
    assert!(
      printed
        .contains("\ngate: unheard, too quiet to hold a word (peak 0.3100, loudest rms 0.0800)\n"),
      "{printed}"
    );
    assert!(
      !printed.contains("language:") && !printed.contains("typed:"),
      "{printed}"
    );

    // Audio not worth a pass at all is unheard before the gate looks at its speech.
    struct Short;
    impl Transcriber for Short {
      fn gate(&mut self, _: &[f32]) -> Result<Gate> {
        Err(Error::Unheard)
      }
      fn speech(&mut self, _: &[f32]) -> Result<Vec<(usize, usize)>> {
        unreachable!()
      }
      fn language(&mut self, _: &[f32], _: &Ask) -> Result<(i32, LanguageFrom)> {
        unreachable!()
      }
      fn words(&mut self, _: &[f32], _: i32, _: &Ask) -> Result<Transcript> {
        unreachable!()
      }
    }
    let t = trace(&mut Short, "short.wav", &[0.5; 100], &Hearing::default());
    assert!(t.unheard);
    let gate = t.gate.unwrap();
    assert_eq!(
      (gate.verdict, gate.why, gate.peak),
      (
        GateVerdict::Unheard,
        Some("under a quarter second, silent, not finite or over ten minutes"),
        0.5
      )
    );
  }

  #[test]
  fn a_missing_model_is_named_with_the_command_that_fetches_it() {
    let dir = Path::new("/nonexistent/dictate-lab-models");
    assert_eq!(
      Engine::load(dir, ModelKind::Small).err().unwrap(),
      "/nonexistent/dictate-lab-models/ggml-small-q8_0.bin is missing. Download it with: dictate-lab fetch --model small"
    );
    assert_eq!(
      Engine::load(dir, ModelKind::Turbo).err().unwrap(),
      "/nonexistent/dictate-lab-models/ggml-acft-large-v3-turbo-q8_0.bin is missing. Download it with: dictate-lab fetch --model turbo"
    );
  }

  #[test]
  fn a_note_is_heard_piece_by_piece() {
    let ms = |m: usize| m * 16;
    let audio: Vec<f32> = (0..ms(30_000)).map(|at| at as f32).collect();
    let mut fake = Fake::new(false);
    fake.said = vec![(0, ms(10_000)), (ms(10_600), ms(30_000))];
    let note = Hearing {
      note: true,
      ..formal()
    };
    let t = trace(&mut fake, "note.wav", &audio, &note);
    // Cut in the middle of the pause, as pieces::hear_long cuts a long note; a gate that finds no
    // speech does not stop a note, which the app hears without it.
    assert_eq!(fake.heard, [ms(10_300), ms(19_700)]);
    assert_eq!(t.passes.len(), 2);
    assert_eq!((t.passes[1].start, t.passes[1].end), (10.3, 30.0));
    // The first piece's sure language is kept for the next, as a hold keeps it.
    assert_eq!(fake.detected, 1);
    assert_eq!(t.passes[1].from, Some(LanguageSource::Hold));
    assert_eq!(
      serde_json::to_value(&t).unwrap()["passes"][1]["from"],
      "hold"
    );
    let heard = "um so 10300 ms um so 19700 ms";
    assert_eq!(t.heard.as_deref(), Some(heard));
    assert_eq!(t.typed.as_deref(), Some(typed(heard).as_str()));
    let printed = t.to_string();
    for line in [
      "gate: unheard, too quiet to hold a word (peak 0.3100, loudest rms 0.0800); a note goes on to its pieces",
      "piece 1: 0.00 to 10.30 s",
      "piece 2: 10.30 to 30.00 s",
      "language: en, kept from an earlier piece",
      &format!("heard: \"{heard}\""),
      "skipped: 0 pieces",
    ] {
      assert!(printed.lines().any(|l| l == line), "{line}\n{printed}");
    }
    assert!(
      printed.contains("times: gate ") && printed.contains(" ms, speech "),
      "{printed}"
    );

    assert_eq!(t.skipped, 0);

    // A note with no speech in it is unheard.
    let mut fake = Fake::new(false);
    let t = trace(&mut fake, "note.wav", &audio, &note);
    assert!(t.unheard && t.passes.is_empty() && t.typed.is_none());
  }

  #[test]
  fn a_skipped_piece_is_counted_and_fails_the_run() {
    let ms = |m: usize| m * 16;
    let audio: Vec<f32> = (0..ms(30_000)).map(|at| at as f32).collect();
    let fake = || {
      let mut fake = Fake::new(true);
      fake.said = vec![(0, ms(10_000)), (ms(10_600), ms(30_000))];
      fake.fail_first = true;
      fake
    };
    let note = Hearing {
      note: true,
      ..Hearing::default()
    };
    // The app skips the piece Whisper failed on and keeps the rest; the trace says so.
    let t = trace(&mut fake(), "note.wav", &audio, &note);
    assert_eq!(t.skipped, 1);
    assert_eq!(t.heard.as_deref(), Some("um so 19700 ms"));
    assert!(t.error.is_none() && !t.unheard);

    let recordings = [("note.wav".to_string(), audio)];
    let failed = Err("1 of 1 recordings failed or skipped a piece".to_string());
    let mut out = Vec::new();
    assert_eq!(
      hear_all(&mut fake(), &recordings, &note, false, &mut out),
      failed
    );
    let printed = String::from_utf8(out).unwrap();
    assert!(
      printed.lines().any(|l| l == "skipped: 1 piece"),
      "{printed}"
    );
    assert!(
      printed
        .lines()
        .any(|l| l == "whisper: failed, Couldn’t understand that"),
      "{printed}"
    );

    let mut out = Vec::new();
    assert_eq!(
      hear_all(&mut fake(), &recordings, &note, true, &mut out),
      failed
    );
    let json: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(json[0]["skipped"], 1);

    // Nothing skipped, nothing failed: the run passes.
    let mut whole = fake();
    whole.fail_first = false;
    assert_eq!(
      hear_all(&mut whole, &recordings, &note, true, &mut Vec::new()),
      Ok(())
    );
  }

  #[test]
  fn the_spoken_stage_makes_a_sticky_or_ends_on_send() {
    let heard = |says: &'static str| {
      let mut fake = Fake::new(true);
      fake.says = Some(says);
      let t = trace(
        &mut fake,
        "said.wav",
        &vec![0.1; 16_000],
        &Hearing::default(),
      );
      let printed = t.to_string();
      let line = printed
        .lines()
        .find(|l| l.starts_with("spoken: "))
        .unwrap()
        .to_string();
      (t.spoken.unwrap(), line)
    };
    // "Sticky: call Thomas" puts a sticky on screen, and nothing is typed.
    let (spoken, line) = heard("Sticky: call Thomas.");
    assert_eq!(
      (spoken.sticky.as_deref(), spoken.send, spoken.text.as_str()),
      (Some("Call Thomas."), false, "")
    );
    assert_eq!(line, "spoken: sticky \"Call Thomas.\", types nothing");
    // A spoken "send" at the end is taken off, and Return follows the words.
    let (spoken, line) = heard("Thanks, Maria. Send.");
    assert_eq!(
      (spoken.sticky.as_deref(), spoken.send, spoken.text.as_str()),
      (None, true, "Thanks, Maria.")
    );
    assert_eq!(line, "spoken: types \"Thanks, Maria.\", then sends");
  }
}
