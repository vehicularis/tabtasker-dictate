//! The spoken fixtures: what is said, how it is heard, and what should come of it. Only their JSON
//! is committed; their audio is rendered where they run, with macOS `say`, because the licence of
//! Apple's voices limits what their output may be used for.

use crate::{run::Hearing, wav};
use dictate_engine::{text::Style, whisper, SAMPLE_RATE};
use serde::Deserialize;
use std::{
  io::Write,
  path::{Path, PathBuf},
  process::Command,
};

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
  /// Whether it is heard piece by piece, as a long note is.
  pub note: bool,
  /// The word error rate it may reach and still pass; 0 when absent.
  pub max_wer: f64,
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
  /// How the fixture is heard.
  pub fn hearing(&self) -> Result<Hearing, String> {
    let language = match self.language.as_deref() {
      None | Some("auto") => None,
      Some(code) => Some(
        whisper::lang_id(code)
          .ok_or_else(|| format!("unknown language {code}; use auto or a code such as en"))?,
      ),
    };
    Ok(Hearing {
      language,
      translate: false,
      words: self.words.clone(),
      style: self.style,
      fillers: self.fillers,
      note: self.note,
    })
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
  let entries =
    std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
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
      let (name, _locale) = line
        .split_once('#')?
        .0
        .trim()
        .rsplit_once(char::is_whitespace)?;
      let name = name.trim();
      Some(
        name
          .split_once(" (")
          .map_or(name, |(name, _)| name)
          .to_string(),
      )
    })
    .collect()
}

fn installed(voices: &[String], voice: &str) -> bool {
  voices.iter().any(|v| v == voice)
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

/// Renders every fixture in `source` into `out`, its JSON beside its audio, with one line each to `log`.
/// A fixture whose voice isn't one of `voices` is skipped; its JSON still goes, so eval can say so.
pub fn render(
  source: &Path,
  out: &Path,
  voices: &[String],
  log: &mut dyn Write,
) -> Result<Rendered, String> {
  std::fs::create_dir_all(out).map_err(|e| format!("cannot make {}: {e}", out.display()))?;
  // A JSON copied onto itself is cut short, and audio beside the committed JSON could be committed.
  if matches!((source.canonicalize(), out.canonicalize()), (Ok(a), Ok(b)) if a == b) {
    return Err(format!(
      "{} holds the fixtures themselves; render them into another folder",
      out.display()
    ));
  }
  let wrote = |e: std::io::Error| format!("cannot write the log: {e}");
  let mut done = Rendered::default();
  for (name, path) in listed(source)? {
    let fixture = load(&path)?;
    let copy = out.join(format!("{name}.json"));
    std::fs::copy(&path, &copy).map_err(|e| format!("cannot write {}: {e}", copy.display()))?;
    let wav = out.join(format!("{name}.wav"));
    match (&fixture.say, &fixture.voice, fixture.synth) {
      (Some(_), Some(voice), None) if !installed(voices, voice) => {
        writeln!(log, "{name}: skipped, the voice {voice} is not installed").map_err(wrote)?;
        done.skipped.push(name);
        continue;
      }
      (Some(text), Some(voice), None) => {
        let said = Command::new("say")
          .args(["-v", voice, "-o"])
          .arg(&wav)
          .args(["--file-format=WAVE", "--data-format=LEI16@16000", text])
          .output()
          .map_err(|e| format!("cannot run say: {e}"))?;
        if !said.status.success() {
          return Err(format!(
            "say failed on {name}: {}",
            String::from_utf8_lossy(&said.stderr).trim()
          ));
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
      _ => return Err(format!("{name}.json needs say with a voice, or synth")),
    }
    done.rendered.push(name);
  }
  Ok(done)
}

/// The `fixtures` command: renders the committed fixtures into `out` with this Mac's voices.
pub fn run(out: &Path, json: bool) -> Result<(), String> {
  let list = Command::new("say")
    .args(["-v", "?"])
    .output()
    .map_err(|e| format!("cannot run say, which renders the fixtures on macOS: {e}"))?;
  let voices = voices_in(&String::from_utf8_lossy(&list.stdout));
  // With --json the lines go to stderr, so stdout holds the one document.
  let mut log: Box<dyn Write> = if json {
    Box::new(std::io::stderr())
  } else {
    Box::new(std::io::stdout())
  };
  let done = render(&source(), out, &voices, &mut log)?;
  if json {
    let document =
      serde_json::json!({ "folder": out, "rendered": done.rendered, "skipped": done.skipped });
    println!("{document}");
  } else {
    let total = done.rendered.len() + done.skipped.len();
    println!(
      "{total} fixtures in {}: {} rendered, {} skipped",
      out.display(),
      done.rendered.len(),
      done.skipped.len()
    );
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
        "fillers",
        "german",
        "noise",
        "note",
        "numbers",
        "plain",
        "question",
        "send",
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
          assert!(
            f.max_wer >= 0.05 && (steps - steps.round()).abs() < 1e-9,
            "{name}: {}",
            f.max_wer
          );
        }
        (None, None, Some(_)) => assert!(f.expect_unheard && f.expect.is_empty(), "{name}"),
        _ => panic!("{name}: say with a voice, or synth"),
      }
    }
    // A misspelt field is refused, not ignored.
    let dir = scratch("typo");
    std::fs::write(
      dir.join("typo.json"),
      r#"{ "expect": "hi", "max_wr": 0.1 }"#,
    )
    .unwrap();
    let err = load(&dir.join("typo.json")).unwrap_err();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
      err.starts_with("typo.json: unknown field `max_wr`"),
      "{err}"
    );
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
      (
        "said",
        r#"{ "say": "Hello.", "voice": "Nobody", "expect": "Hello." }"#,
      ),
      (
        "silence",
        r#"{ "synth": "silence", "expect_unheard": true }"#,
      ),
    ] {
      std::fs::write(source.join(format!("{name}.json")), json).unwrap();
    }
    std::fs::write(source.join("notes.txt"), "not a fixture").unwrap();
    let mut log = Vec::new();
    let done = render(&source, &out, &["Samantha".into()], &mut log).unwrap();
    assert_eq!(
      (done.rendered, done.skipped),
      (vec!["noise".into(), "silence".into()], vec!["said".into()])
    );
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
    assert_eq!(
      crate::wav::read(&out.join("noise.wav")).unwrap().len(),
      3 * 16_000
    );
    assert!(crate::wav::read(&out.join("silence.wav")).is_ok());
    assert!(!out.join("said.wav").exists());

    // Never into the fixtures themselves: a JSON copied onto itself is cut short, and audio there
    // could be committed.
    assert_eq!(
      render(&source, &source.join("."), &[], &mut Vec::new()).unwrap_err(),
      format!(
        "{} holds the fixtures themselves; render them into another folder",
        source.join(".").display()
      )
    );
    assert!(load(&source.join("noise.json")).is_ok());

    // A fixture that is neither said nor synthesized can't be rendered.
    std::fs::write(source.join("bare.json"), r#"{ "expect": "Hi." }"#).unwrap();
    assert_eq!(
      render(&source, &out, &[], &mut Vec::new()).unwrap_err(),
      "bare.json needs say with a voice, or synth"
    );
    std::fs::remove_dir_all(dir).unwrap();
  }

  /// A folder of its own for each test, which the test removes.
  pub(crate) fn scratch(test: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "dictate-lab-fixtures-{test}-{}",
      std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }
}
