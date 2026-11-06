//! The spoken fixtures: what is said, how it is heard, and what should come of it. Only their JSON
//! is committed; their audio is rendered where they run, with macOS `say`, because the licence of
//! Apple's voices limits what their output may be used for.

use crate::{run::Hearing, wav, Failure};
use dictate_engine::{models::ModelKind, text::Style, whisper, SAMPLE_RATE};
use serde::Deserialize;
use std::{
  io::Write,
  path::{Path, PathBuf},
  process::{Command, Output},
};

/// The program that renders the spoken fixtures: macOS `say`.
const SAY: &str = "say";

/// The committed fixtures: `crates/lab/fixtures`.
pub fn source() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// One fixture's settings and what should come of them, as its JSON holds them. A fixture is said
/// (`say` in a `voice`), synthesized (`synth`), or neither, for a recording of your own.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Fixture {
  /// What `say` reads aloud.
  pub say: Option<String>,
  /// The voice that reads it.
  pub voice: Option<String>,
  /// Audio made without a voice.
  pub synth: Option<Synth>,
  /// The words that should be typed.
  pub expect: String,
  /// Nothing should be typed at all.
  pub expect_unheard: bool,
  /// The exact text that should be typed, after a spoken sticky or send: case and punctuation
  /// count, only the ends' whitespace doesn't; unchecked when absent.
  pub expect_typed: Option<String>,
  /// The words a spoken "Sticky: ..." should put on a sticky; unchecked when absent.
  pub expect_sticky: Option<String>,
  /// Whether a spoken "send" should end the words; unchecked when absent.
  pub expect_send: Option<bool>,
  /// `auto`, or the code of the language pinned; absent is `auto`.
  pub language: Option<String>,
  /// The vocabulary.
  pub words: Vec<String>,
  /// The style the words are finished in.
  pub style: Style,
  /// Whether fillers are dropped.
  pub fillers: bool,
  /// Whether it is heard piece by piece, as a note, however short; audio over one piece always is.
  pub note: bool,
  /// The word error rate it may reach and still pass; 0 when absent.
  pub max_wer: f64,
  /// A misrecognition it is known to show, in one line. It is scored like any fixture but never fails
  /// the eval, and the eval says when it passes again.
  pub known_issue: Option<String>,
  /// The model the known issue shows on; every model when absent. Another model holds the fixture to
  /// its budget.
  pub known_on: Option<ModelKind>,
}

/// Audio made without a voice.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Synth {
  /// Three seconds of nothing.
  Silence,
  /// Three seconds of low noise, the same every run.
  Noise,
}

impl Fixture {
  /// The fixture as `kind` is held to it: without a known issue `known_on` another model.
  pub fn for_model(&mut self, kind: ModelKind) {
    if self.known_on.is_some_and(|on| on != kind) {
      self.known_issue = None;
    }
  }

  /// How the fixture is heard.
  pub fn hearing(&self) -> Result<Hearing, String> {
    let language = match self.language.as_deref() {
      None | Some("auto") => None,
      Some(code) => Some(whisper::lang_id(code).ok_or_else(|| format!("unknown language {code}; use auto or a code such as en"))?),
    };
    Ok(Hearing { language, translate: false, words: self.words.clone(), style: self.style, fillers: self.fillers, note: self.note })
  }

  /// The words that should be typed: none when it should be unheard.
  pub fn expected(&self) -> &str {
    if self.expect_unheard {
      ""
    } else {
      &self.expect
    }
  }
}

/// Every `x.json` in `dir`, as (`x`, its path), by name.
pub fn listed(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
  let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
  let mut listed: Vec<(String, PathBuf)> = entries
    .filter_map(|entry| {
      let path = entry.ok()?.path();
      if path.extension()? != "json" {
        return None;
      }
      Some((path.file_stem()?.to_string_lossy().into_owned(), path))
    })
    .collect();
  listed.sort();
  Ok(listed)
}

/// The fixture at `path`; a field it doesn't know is refused, so a misspelt one can't pass unseen.
pub fn load(path: &Path) -> Result<Fixture, String> {
  let name = path.file_name().unwrap_or_default().to_string_lossy();
  let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {name}: {e}"))?;
  serde_json::from_str(&text).map_err(|e| format!("{name}: {e}"))
}

/// The voices `say -v '?'` lists, by name: `Samantha (English (US))` is Samantha's.
fn voices_in(list: &str) -> Vec<String> {
  list
    .lines()
    .filter_map(|line| {
      // NAME, then the locale, then `#` and a sample.
      let (name, _locale) = line.split_once('#')?.0.trim().rsplit_once(char::is_whitespace)?;
      let name = name.trim();
      Some(name.split_once(" (").map_or(name, |(name, _)| name).to_string())
    })
    .collect()
}

fn installed(voices: &[String], voice: &str) -> bool {
  voices.iter().any(|v| v == voice)
}

/// Why `say` failed: its exit status, and what it said on stderr.
fn failed(said: &Output) -> String {
  match String::from_utf8_lossy(&said.stderr).trim() {
    "" => said.status.to_string(),
    stderr => format!("{}, {stderr}", said.status),
  }
}

/// The voices `say -v '?'` lists, run as `say`. A `say` that can't run or fails stops the lab: no voice
/// would be found, and every fixture would be skipped as if its voice were missing.
fn voices(say: &str) -> Result<Vec<String>, Failure> {
  let list =
    Command::new(say).args(["-v", "?"]).output().map_err(|e| Failure::Broken(format!("cannot run {say}, which renders the fixtures on macOS: {e}")))?;
  if !list.status.success() {
    return Err(Failure::Broken(format!("{say} -v '?' failed, so the voices can't be listed: {}", failed(&list))));
  }
  Ok(voices_in(&String::from_utf8_lossy(&list.stdout)))
}

/// The audio a synthesized fixture is.
fn synth(synth: Synth) -> Vec<f32> {
  let samples = 3 * SAMPLE_RATE;
  match synth {
    Synth::Silence => vec![0.0; samples],
    Synth::Noise => {
      // ponytail: xorshift32 with a fixed seed, so every machine renders the same noise.
      let mut x: u32 = 0x9E37_79B9;
      (0..samples)
        .map(|_| {
          x ^= x << 13;
          x ^= x >> 17;
          x ^= x << 5;
          // Uniform within ±0.005: RMS about 0.003, between a breath and a word.
          (x as f32 / u32::MAX as f32 * 2.0 - 1.0) * 0.005
        })
        .collect()
    }
  }
}

/// The fixtures that were rendered and the ones skipped for a voice that isn't installed.
#[derive(Debug, Default)]
pub struct Rendered {
  /// Rendered, by name.
  pub rendered: Vec<String>,
  /// Skipped, by name.
  pub skipped: Vec<String>,
}

/// Renders every fixture in `source` into `out` with `say`, its JSON beside its audio, with one line
/// each to `log`. A fixture whose voice isn't one of `voices` is skipped: its JSON still goes, so eval
/// can say so, and an old WAV of it goes, so eval can't score stale audio. A fixture that can't be read
/// fails as a fixture; `say` failing, or a file that can't be written, stops the lab.
pub fn render(source: &Path, out: &Path, say: &str, voices: &[String], log: &mut dyn Write) -> Result<Rendered, Failure> {
  std::fs::create_dir_all(out).map_err(|e| format!("cannot make {}: {e}", out.display()))?;
  // A JSON copied onto itself is cut short, and audio beside the committed JSON could be committed.
  if matches!((source.canonicalize(), out.canonicalize()), (Ok(a), Ok(b)) if a == b) {
    return Err(Failure::Broken(format!("{} holds the fixtures themselves; render them into another folder", out.display())));
  }
  let wrote = |e: std::io::Error| format!("cannot write the log: {e}");
  let mut done = Rendered::default();
  for (name, path) in listed(source)? {
    let fixture = load(&path).map_err(Failure::Failed)?;
    let copy = out.join(format!("{name}.json"));
    std::fs::copy(&path, &copy).map_err(|e| format!("cannot write {}: {e}", copy.display()))?;
    let wav = out.join(format!("{name}.wav"));
    match (&fixture.say, &fixture.voice, fixture.synth) {
      (Some(_), Some(voice), None) if !installed(voices, voice) => {
        if wav.exists() {
          std::fs::remove_file(&wav).map_err(|e| format!("cannot remove the old {}: {e}", wav.display()))?;
        }
        writeln!(log, "{name}: skipped, the voice {voice} is not installed").map_err(wrote)?;
        done.skipped.push(name);
        continue;
      }
      (Some(text), Some(voice), None) => {
        let said = Command::new(say)
          .args(["-v", voice, "-o"])
          .arg(&wav)
          // `--` ends say's flags, so a text starting with "-" is read aloud.
          .args(["--file-format=WAVE", "--data-format=LEI16@16000", "--", text])
          .output()
          .map_err(|e| format!("cannot run {say}: {e}"))?;
        if !said.status.success() {
          return Err(Failure::Broken(format!("{say} failed on {name}: {}", failed(&said))));
        }
        let seconds = wav::read(&wav)?.len() as f32 / SAMPLE_RATE as f32;
        writeln!(log, "{name}: said by {voice}, {seconds:.2} s").map_err(wrote)?;
      }
      (None, None, Some(kind)) => {
        let pcm = synth(kind);
        wav::write(&wav, &pcm).map_err(|e| format!("cannot write {}: {e}", wav.display()))?;
        let kind = format!("{kind:?}").to_lowercase();
        let seconds = pcm.len() as f32 / SAMPLE_RATE as f32;
        writeln!(log, "{name}: synthesized {kind}, {seconds:.2} s").map_err(wrote)?;
      }
      _ => return Err(Failure::Failed(format!("{name}.json needs say with a voice, or synth"))),
    }
    done.rendered.push(name);
  }
  Ok(done)
}

/// The `fixtures` command: renders the committed fixtures into `out` with this Mac's voices.
pub fn run(out: &Path, json: bool) -> Result<(), Failure> {
  let voices = voices(SAY)?;
  // With --json the lines go to stderr, so stdout holds the one document.
  let mut log: Box<dyn Write> = if json { Box::new(std::io::stderr()) } else { Box::new(std::io::stdout()) };
  let done = render(&source(), out, SAY, &voices, &mut log)?;
  if json {
    let document = serde_json::json!({ "folder": out, "rendered": done.rendered, "skipped": done.skipped });
    println!("{document}");
  } else {
    let total = done.rendered.len() + done.skipped.len();
    println!("{total} fixtures in {}: {} rendered, {} skipped", out.display(), done.rendered.len(), done.skipped.len());
  }
  Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use dictate_engine::audio;

  #[test]
  fn every_committed_fixture_reads_and_can_be_rendered() {
    let listed = listed(&source()).unwrap();
    let names: Vec<&str> = listed.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
      names,
      [
        "code",
        "code-username",
        "fillers",
        "german",
        "noise",
        "note",
        "numbers",
        "plain",
        "question",
        "send",
        "send-bare",
        "silence",
        "sticky",
        "turkish",
        "vocabulary"
      ]
    );
    for (name, path) in &listed {
      let f = load(path).unwrap();
      f.hearing().unwrap_or_else(|e| panic!("{name}: {e}"));
      match (&f.say, &f.voice, f.synth) {
        (Some(_), Some(_), None) => {
          assert!(!f.expect.is_empty() && !f.expect_unheard, "{name}");
          // A budget from a real run: a multiple of 0.05, at least 0.05.
          let steps = f.max_wer / 0.05;
          assert!(f.max_wer >= 0.05 && (steps - steps.round()).abs() < 1e-9, "{name}: {}", f.max_wer);
        }
        (None, None, Some(_)) => assert!(f.expect_unheard && f.expect.is_empty(), "{name}"),
        _ => panic!("{name}: say with a voice, or synth"),
      }
      // Code and formal styles are checked letter for letter, not just word for word.
      if matches!(f.style, Style::Code | Style::Formal) {
        assert!(f.expect_typed.is_some(), "{name} needs expect_typed");
      }
    }
    // A misspelt field is refused, not ignored.
    let dir = scratch("typo");
    std::fs::write(dir.join("typo.json"), r#"{ "expect": "hi", "max_wr": 0.1 }"#).unwrap();
    let err = load(&dir.join("typo.json")).unwrap_err();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(err.starts_with("typo.json: unknown field `max_wr`"), "{err}");
  }

  #[test]
  fn the_committed_fixtures_are_json_only() {
    // Their audio is rendered where they run: none is committed beside them. A hidden file such as
    // Finder's .DS_Store is no fixture, and git ignores it.
    for entry in std::fs::read_dir(source()).unwrap() {
      let path = entry.unwrap().path();
      if path.file_name().unwrap().to_string_lossy().starts_with('.') {
        continue;
      }
      assert_eq!(path.extension().and_then(|e| e.to_str()), Some("json"), "{}", path.display());
    }
  }

  #[test]
  fn say_s_voice_list_is_read_by_name() {
    let list = "\
Anna                de_DE    # Hallo! Ich heiße Anna.
Bad News            en_US    # Hello! My name is Bad News.
Eddy (English (US)) en_US    # Hello! My name is Eddy.
Majed               ar_001   # مرحبًا! اسمي ماجد.
Samantha (English (US)) en_US    # Hello! My name is Samantha.
";
    let voices = voices_in(list);
    for voice in ["Anna", "Bad News", "Eddy", "Majed", "Samantha"] {
      assert!(installed(&voices, voice), "{voice} in {voices:?}");
    }
    for voice in ["Sam", "Bad", "Yelda", "English"] {
      assert!(!installed(&voices, voice), "{voice} in {voices:?}");
    }
  }

  #[test]
  fn synthesized_audio_is_the_same_every_run() {
    assert_eq!(synth(Synth::Noise), synth(Synth::Noise));
    let noise = synth(Synth::Noise);
    assert_eq!(noise.len(), 3 * 16_000);
    // Low noise: above the level of a breath, so speech detection hears it, and under a word's.
    assert!(!audio::is_silent(&noise) && !audio::is_voiced(&noise));
    // Silence is not worth a pass at all.
    assert!(!audio::worth_a_pass(&synth(Synth::Silence)));
  }

  #[test]
  fn render_writes_synthesized_audio_and_skips_a_missing_voice() {
    let dir = scratch("render");
    let (source, out) = (dir.join("source"), dir.join("out"));
    std::fs::create_dir_all(&source).unwrap();
    for (name, json) in [
      ("noise", r#"{ "synth": "noise", "expect_unheard": true }"#),
      ("said", r#"{ "say": "Hello.", "voice": "Nobody", "expect": "Hello." }"#),
      ("silence", r#"{ "synth": "silence", "expect_unheard": true }"#),
    ] {
      std::fs::write(source.join(format!("{name}.json")), json).unwrap();
    }
    std::fs::write(source.join("notes.txt"), "not a fixture").unwrap();
    // An old render of a fixture whose voice is gone now.
    std::fs::create_dir_all(&out).unwrap();
    crate::wav::write(&out.join("said.wav"), &[0.5; 16_000]).unwrap();
    let mut log = Vec::new();
    let done = render(&source, &out, SAY, &["Samantha".into()], &mut log).unwrap();
    assert_eq!((done.rendered, done.skipped), (vec!["noise".into(), "silence".into()], vec!["said".into()]));
    assert_eq!(
      String::from_utf8(log).unwrap(),
      "noise: synthesized noise, 3.00 s\n\
       said: skipped, the voice Nobody is not installed\n\
       silence: synthesized silence, 3.00 s\n"
    );
    // Every JSON goes beside the audio, so eval can say a fixture it has no audio for was skipped.
    for name in ["noise", "said", "silence"] {
      assert!(out.join(format!("{name}.json")).exists(), "{name}");
    }
    assert_eq!(crate::wav::read(&out.join("noise.wav")).unwrap().len(), 3 * 16_000);
    assert!(crate::wav::read(&out.join("silence.wav")).is_ok());
    // A skipped fixture leaves no audio, so eval can't score the old one.
    assert!(!out.join("said.wav").exists());

    // Never into the fixtures themselves: a JSON copied onto itself is cut short, and audio there
    // could be committed.
    assert_eq!(
      render(&source, &source.join("."), SAY, &[], &mut Vec::new()).unwrap_err(),
      Failure::Broken(format!("{} holds the fixtures themselves; render them into another folder", source.join(".").display()))
    );
    assert!(load(&source.join("noise.json")).is_ok());

    // A fixture that is neither said nor synthesized can't be rendered.
    std::fs::write(source.join("bare.json"), r#"{ "expect": "Hi." }"#).unwrap();
    assert_eq!(render(&source, &out, SAY, &[], &mut Vec::new()).unwrap_err(), Failure::Failed("bare.json needs say with a voice, or synth".into()));
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_failing_say_stops_the_lab_and_is_never_a_skip() {
    // `false` stands in for say: it runs, and fails.
    let dir = scratch("say-fails");
    let (source, out) = (dir.join("source"), dir.join("out"));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("said.json"), r#"{ "say": "Hello.", "voice": "Samantha", "expect": "Hello." }"#).unwrap();
    let rendered = render(&source, &out, "false", &["Samantha".into()], &mut Vec::new());
    std::fs::remove_dir_all(dir).unwrap();
    assert_eq!(rendered.unwrap_err(), Failure::Broken("false failed on said: exit status: 1".into()));
    // Nor can the voices be listed, which would skip every fixture as if its voice were missing.
    assert_eq!(voices("false").unwrap_err(), Failure::Broken("false -v '?' failed, so the voices can't be listed: exit status: 1".into()));
    let Err(Failure::Broken(missing)) = voices("/nonexistent/say") else { panic!("a say that isn't there stops the lab") };
    assert!(missing.starts_with("cannot run /nonexistent/say, which renders the fixtures on macOS: "), "{missing}");
  }

  /// A folder of its own for each test, which the test removes.
  pub(crate) fn scratch(test: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-lab-fixtures-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }
}
