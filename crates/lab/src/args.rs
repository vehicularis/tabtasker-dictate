//! The hand-written argument parser.

use crate::run::Hearing;
use dictate_engine::{
  models::ModelKind,
  text::{Replacement, Style},
  whisper,
};
use std::path::{Path, PathBuf};

/// The `text` command: the text rules alone on a raw string.
#[derive(Debug, PartialEq)]
pub struct Text {
  /// The raw transcript.
  pub raw: String,
  /// The style to finish with.
  pub style: Style,
  /// Whether to drop fillers.
  pub fillers: bool,
  /// The language code, if any.
  pub language: Option<String>,
  /// The custom replacements, in order.
  pub replacements: Vec<Replacement>,
  /// Whether to finish as live typing would.
  pub live: bool,
}

/// What the lab was asked to do.
#[derive(Debug, PartialEq)]
pub enum Command {
  /// Print usage.
  Help,
  /// Run only the text rules on a raw string.
  Text(Text),
  /// Download the speech models.
  Fetch {
    /// Which Whisper to download, with the speech detection beside it.
    model: ModelKind,
    /// Whether to download the speaker models too.
    speakers: bool,
  },
  /// Hear recordings stage by stage.
  Run {
    /// The 16 kHz mono WAV files, in order.
    files: Vec<PathBuf>,
    /// Which Whisper to hear them with.
    model: ModelKind,
    /// How each is heard.
    hearing: Hearing,
  },
  /// Render the fixtures' audio beside their JSON.
  Fixtures {
    /// The folder they go in.
    out: PathBuf,
  },
  /// Hear every fixture in a folder and score its words.
  Eval {
    /// The folder of `x.json` and `x.wav` pairs.
    dir: PathBuf,
    /// Which Whisper to hear them with.
    model: ModelKind,
  },
}

/// A parsed command line.
#[derive(Debug, PartialEq)]
pub struct Args {
  /// The command to run.
  pub command: Command,
  /// Whether to print one JSON document instead of plain lines.
  pub json: bool,
  /// The folder models live in.
  pub models: PathBuf,
}

/// The usage text.
pub const USAGE: &str = "\
dictate-lab runs the dictation pipeline without the app.

Usage:
  dictate-lab text \"<raw>\" [--style default|casual|formal|code|raw] [--fillers]
                           [--language CODE] [--replace FROM=TO]... [--live]
  dictate-lab fetch [--model small|turbo] [--speakers]
  dictate-lab run <file.wav>... [--model small|turbo] [--language auto|CODE] [--translate]
                  [--words \"A, B\"] [--style default|casual|formal|code|raw] [--fillers] [--note]
  dictate-lab fixtures [--out DIR]
  dictate-lab eval [DIR] [--model small|turbo]

Commands:
  text    Finish a raw transcript with the text rules alone, no model.
  fetch   Download Whisper and the speech detection (--speakers: the speaker models too).
  run     Hear 16 kHz mono WAV files stage by stage and print what each stage found.
          --note hears each file piece by piece, as a long note is. The model is small
          unless --model says turbo.
  fixtures  Render the fixtures in crates/lab/fixtures with macOS say into --out DIR
          (target/fixtures), each WAV beside its JSON. A missing voice skips its fixture.
  eval    Hear each x.wav beside an x.json in DIR (target/fixtures) and score its words
          against what the JSON expects. Exits 1 when one is over budget, mismatched or errors.

Options for every command:
  --json         Print one JSON document and nothing else on stdout.
  --models DIR   The folder models live in. Defaults to $DICTATE_MODELS,
                 then target/models in the repo.
  --help         Print this text.
  --             End the flags: what follows is positional, such as a raw \"--text\".";

/// Flags that take the next argument as their value.
const VALUED: &[&str] = &[
  "--models",
  "--style",
  "--language",
  "--replace",
  "--model",
  "--words",
  "--out",
];
/// Flags that stand alone.
const SWITCHES: &[&str] = &[
  "--json",
  "--help",
  "-h",
  "--fillers",
  "--live",
  "--speakers",
  "--translate",
  "--note",
];
/// Flags every command takes.
const GLOBAL: &[&str] = &["--json", "--models"];

/// The flags `command` takes beyond the global ones; None for a command the lab doesn't know.
fn takes(command: &str) -> Option<&'static [&'static str]> {
  Some(match command {
    "text" => &["--style", "--fillers", "--language", "--replace", "--live"],
    "fetch" => &["--model", "--speakers"],
    "run" => &[
      "--model",
      "--language",
      "--translate",
      "--words",
      "--style",
      "--fillers",
      "--note",
    ],
    "fixtures" => &["--out"],
    "eval" => &["--model"],
    _ => return None,
  })
}

/// `<repo root>/target/<dir>`, where the lab keeps its models and rendered fixtures.
/// The repo root is fixed at build time, which is fine for a dev tool.
fn target(dir: &str) -> PathBuf {
  let lab = Path::new(env!("CARGO_MANIFEST_DIR"));
  lab
    .ancestors()
    .nth(2)
    .unwrap_or(lab)
    .join("target")
    .join(dir)
}

/// Whether `path` is inside one of the app's own folders, which the lab never reads or writes.
// ponytail: a prefix check on the path as given; a relative path or a symlink into them gets past it.
fn app_data(path: &Path) -> bool {
  let Some(home) = std::env::var_os("HOME") else {
    return false;
  };
  let home = Path::new(&home);
  [
    "Library/Application Support/com.tabtasker.dictate",
    "Documents/TabTasker Dictate",
    "Library/Logs/TabTasker Dictate",
  ]
  .iter()
  .any(|dir| path.starts_with(home.join(dir)))
}

fn style_of(s: &str) -> Result<Style, String> {
  serde_json::from_value(serde_json::Value::String(s.to_string()))
    .map_err(|_| format!("--style: unknown style {s}; use default, casual, formal, code or raw"))
}

fn model_of(s: &str) -> Result<ModelKind, String> {
  match s {
    "small" => Ok(ModelKind::Small),
    "turbo" => Ok(ModelKind::Turbo),
    _ => Err(format!("--model: unknown model {s}; use small or turbo")),
  }
}

/// Parses the arguments after the program name. `env_models` is `$DICTATE_MODELS`.
pub fn parse(
  args: impl Iterator<Item = String>,
  env_models: Option<PathBuf>,
) -> Result<Args, String> {
  let args: Vec<String> = args.collect();
  // `--` ends the flags: everything after it is positional.
  let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
  let env_models = env_models.filter(|dir| !dir.as_os_str().is_empty());
  let help = || Args {
    command: Command::Help,
    json: false,
    models: env_models.clone().unwrap_or_else(|| target("models")),
  };
  // --help wins over everything else on the line, however wrong the rest is.
  if args[..end].iter().any(|a| a == "--help" || a == "-h") {
    return Ok(help());
  }
  let mut flags: Vec<(&str, &str)> = Vec::new();
  let mut free: Vec<&str> = Vec::new();
  let mut line = args[..end].iter();
  while let Some(a) = line.next() {
    if VALUED.contains(&a.as_str()) {
      let value = line
        .next()
        .filter(|v| !VALUED.contains(&v.as_str()) && !SWITCHES.contains(&v.as_str()))
        .ok_or_else(|| format!("{a} needs a value"))?;
      flags.push((a, value));
    } else if SWITCHES.contains(&a.as_str()) {
      flags.push((a, ""));
    } else if a.starts_with("--") {
      return Err(format!("unknown flag {a}"));
    } else {
      free.push(a);
    }
  }
  free.extend(args.iter().skip(end + 1).map(String::as_str));
  let Some((&command, free)) = free.split_first() else {
    return Ok(help());
  };
  if command == "help" {
    return Ok(help());
  }
  let takes = takes(command).ok_or_else(|| format!("unknown command {command}; try --help"))?;

  let (mut json, mut models) = (false, None);
  let (mut style, mut fillers, mut language, mut replacements, mut live) =
    (Style::Default, false, None, Vec::new(), false);
  let (mut model, mut speakers, mut translate, mut words, mut note, mut out) =
    (ModelKind::Small, false, false, Vec::new(), false, None);
  for (flag, value) in flags {
    if !GLOBAL.contains(&flag) && !takes.contains(&flag) {
      return Err(format!("{command} does not take {flag}"));
    }
    match flag {
      "--json" => json = true,
      "--models" => models = Some(PathBuf::from(value)),
      "--style" => style = style_of(value)?,
      "--fillers" => fillers = true,
      "--live" => live = true,
      "--language" => language = Some(value.to_string()),
      "--replace" => {
        let (from, to) = value
          .split_once('=')
          .ok_or_else(|| format!("--replace needs FROM=TO, got {value}"))?;
        replacements.push(Replacement {
          from: from.to_string(),
          to: to.to_string(),
        });
      }
      "--model" => model = model_of(value)?,
      "--speakers" => speakers = true,
      "--translate" => translate = true,
      "--words" => {
        words = value
          .split(',')
          .map(str::trim)
          .filter(|w| !w.is_empty())
          .map(String::from)
          .collect()
      }
      "--note" => note = true,
      "--out" => out = Some(PathBuf::from(value)),
      _ => unreachable!("{flag} is in VALUED or SWITCHES but not handled"),
    }
  }
  let models = models.or(env_models).unwrap_or_else(|| target("models"));
  let elsewhere = |path: PathBuf, what: &str| match app_data(&path) {
    true => Err(format!(
      "{} is the app's own data; the lab keeps its {what} elsewhere",
      path.display()
    )),
    false => Ok(path),
  };
  let models = elsewhere(models, "models")?;
  let unexpected = |extra: &[&str]| match extra.first() {
    Some(a) => Err(format!("unexpected argument {a}")),
    None => Ok(()),
  };
  let command = match command {
    "text" => {
      let (raw, extra) = free
        .split_first()
        .ok_or("text needs the raw string to finish")?;
      unexpected(extra)?;
      Command::Text(Text {
        raw: raw.to_string(),
        style,
        fillers,
        language,
        replacements,
        live,
      })
    }
    "fetch" => {
      unexpected(free)?;
      Command::Fetch { model, speakers }
    }
    "fixtures" => {
      unexpected(free)?;
      let out = out.unwrap_or_else(|| target("fixtures"));
      Command::Fixtures {
        out: elsewhere(out, "fixtures")?,
      }
    }
    "eval" => {
      let (dir, extra) = match free.split_first() {
        Some((dir, extra)) => (PathBuf::from(dir), extra),
        None => (target("fixtures"), free),
      };
      unexpected(extra)?;
      Command::Eval {
        dir: elsewhere(dir, "fixtures")?,
        model,
      }
    }
    _ => {
      if free.is_empty() {
        return Err("run needs at least one .wav file".into());
      }
      let language = match language.as_deref() {
        None | Some("auto") => None,
        Some(code) => Some(whisper::lang_id(code).ok_or_else(|| {
          format!("--language: unknown language {code}; use auto or a code such as en")
        })?),
      };
      Command::Run {
        files: free.iter().map(PathBuf::from).collect(),
        model,
        hearing: Hearing {
          language,
          translate,
          words,
          style,
          fillers,
          note,
        },
      }
    }
  };
  Ok(Args {
    command,
    json,
    models,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(s: &[&str], env: Option<&str>) -> Result<Args, String> {
    parse(s.iter().map(|s| s.to_string()), env.map(PathBuf::from))
  }

  fn command(s: &[&str]) -> Command {
    p(s, None).unwrap().command
  }

  fn text(raw: &str) -> Text {
    Text {
      raw: raw.into(),
      style: Style::Default,
      fillers: false,
      language: None,
      replacements: Vec::new(),
      live: false,
    }
  }

  #[test]
  fn text_takes_all_its_flags_and_repeats_replace() {
    let a = p(
      &[
        "text",
        "hi there",
        "--style",
        "formal",
        "--fillers",
        "--language",
        "en",
        "--replace",
        "a=b",
        "--replace",
        "c=d=e",
        "--live",
        "--json",
      ],
      None,
    )
    .unwrap();
    assert!(a.json);
    assert_eq!(
      a.command,
      Command::Text(Text {
        raw: "hi there".into(),
        style: Style::Formal,
        fillers: true,
        language: Some("en".into()),
        replacements: vec![
          Replacement {
            from: "a".into(),
            to: "b".into()
          },
          Replacement {
            from: "c".into(),
            to: "d=e".into()
          }
        ],
        live: true,
      })
    );
  }

  #[test]
  fn fetch_and_run_take_their_flags() {
    assert_eq!(
      command(&["fetch"]),
      Command::Fetch {
        model: ModelKind::Small,
        speakers: false
      }
    );
    assert_eq!(
      command(&["fetch", "--model", "turbo", "--speakers"]),
      Command::Fetch {
        model: ModelKind::Turbo,
        speakers: true
      }
    );
    assert_eq!(
      command(&["run", "a.wav"]),
      Command::Run {
        files: vec!["a.wav".into()],
        model: ModelKind::Small,
        hearing: Hearing::default(),
      }
    );
    assert_eq!(
      command(&[
        "run",
        "a.wav",
        "--model",
        "turbo",
        "b.wav",
        "--language",
        "de",
        "--translate",
        "--words",
        "TabTasker, , Vehicularis ",
        "--style",
        "code",
        "--fillers",
        "--note",
      ]),
      Command::Run {
        files: vec!["a.wav".into(), "b.wav".into()],
        model: ModelKind::Turbo,
        hearing: Hearing {
          language: whisper::lang_id("de"),
          translate: true,
          words: vec!["TabTasker".into(), "Vehicularis".into()],
          style: Style::Code,
          fillers: true,
          note: true,
        },
      }
    );
    assert_eq!(
      command(&["run", "a.wav", "--language", "auto"]),
      command(&["run", "a.wav"])
    );
  }

  #[test]
  fn global_flags_go_anywhere_on_the_line() {
    for line in [
      &["--json", "--models", "/a", "text", "x"][..],
      &["text", "--models", "/a", "x", "--json"],
      &["--models", "/a", "text", "--json", "x"],
    ] {
      let a = p(line, None).unwrap();
      assert!(a.json, "{line:?}");
      assert_eq!(a.models, PathBuf::from("/a"), "{line:?}");
      assert_eq!(a.command, Command::Text(text("x")), "{line:?}");
    }
  }

  #[test]
  fn a_double_dash_ends_the_flags() {
    assert_eq!(
      command(&["text", "--", "--text"]),
      Command::Text(text("--text"))
    );
    assert_eq!(
      command(&["text", "--json", "--", "--help"]),
      Command::Text(text("--help"))
    );
    assert_eq!(
      command(&["run", "--", "--note.wav"]),
      Command::Run {
        files: vec!["--note.wav".into()],
        model: ModelKind::Small,
        hearing: Hearing::default(),
      }
    );
  }

  #[test]
  fn help_when_empty_or_asked_however_wrong_the_rest_is() {
    for line in [
      &[][..],
      &["help"],
      &["--help"],
      &["-h"],
      &["--json"],
      &["text", "--help"],
      &["text", "--nope", "--help"],
      &["dance", "-h"],
      &["run", "--model", "--help"],
      &["fetch", "--model", "huge", "--help"],
    ] {
      assert_eq!(p(line, None).unwrap().command, Command::Help, "{line:?}");
    }
  }

  #[test]
  fn bad_arguments_name_the_flag() {
    let err = |s: &[&str]| p(s, None).unwrap_err();
    assert_eq!(err(&["text", "x", "--nope"]), "unknown flag --nope");
    assert_eq!(err(&["text", "x", "--style"]), "--style needs a value");
    // A flag that needs a value never takes another flag as it.
    assert_eq!(
      err(&["text", "x", "--style", "--fillers"]),
      "--style needs a value"
    );
    assert_eq!(
      err(&["--models", "--json", "text", "x"]),
      "--models needs a value"
    );
    assert_eq!(
      err(&["text", "x", "--style", "--"]),
      "--style needs a value"
    );
    assert!(err(&["text", "x", "--style", "loud"]).starts_with("--style: unknown style loud"));
    assert!(err(&["text", "x", "--replace", "ab"]).starts_with("--replace needs FROM=TO"));
    assert_eq!(err(&["text"]), "text needs the raw string to finish");
    assert_eq!(err(&["text", "x", "y"]), "unexpected argument y");
    assert!(err(&["dance"]).starts_with("unknown command dance"));
    assert_eq!(err(&["fetch", "x"]), "unexpected argument x");
    assert_eq!(
      err(&["fetch", "--model", "huge"]),
      "--model: unknown model huge; use small or turbo"
    );
    assert_eq!(err(&["run"]), "run needs at least one .wav file");
    assert_eq!(err(&["run", "a.wav", "--live"]), "run does not take --live");
    assert_eq!(err(&["text", "x", "--note"]), "text does not take --note");
    assert_eq!(
      err(&["run", "a.wav", "--language", "xx"]),
      "--language: unknown language xx; use auto or a code such as en"
    );
  }

  #[test]
  fn models_flag_beats_env_beats_default() {
    assert_eq!(
      p(&["text", "x", "--models", "/a"], Some("/b"))
        .unwrap()
        .models,
      PathBuf::from("/a")
    );
    assert_eq!(
      p(&["text", "x"], Some("/b")).unwrap().models,
      PathBuf::from("/b")
    );
    let default = p(&["text", "x"], None).unwrap().models;
    assert!(default.ends_with("target/models"), "{default:?}");
    assert!(default.is_absolute(), "{default:?}");
    assert!(
      !default
        .components()
        .any(|c| c == std::path::Component::ParentDir),
      "{default:?}"
    );
    // An empty $DICTATE_MODELS is unset.
    assert_eq!(p(&["text", "x"], Some("")).unwrap().models, default);
  }

  #[test]
  fn fixtures_and_eval_take_their_folders() {
    assert_eq!(
      command(&["fixtures"]),
      Command::Fixtures {
        out: target("fixtures")
      }
    );
    assert!(target("fixtures").is_absolute());
    assert_eq!(
      command(&["fixtures", "--out", "/tmp/f"]),
      Command::Fixtures {
        out: "/tmp/f".into()
      }
    );
    assert_eq!(
      command(&["eval"]),
      Command::Eval {
        dir: target("fixtures"),
        model: ModelKind::Small
      }
    );
    assert_eq!(
      command(&["eval", "mine", "--model", "turbo", "--json"]),
      Command::Eval {
        dir: "mine".into(),
        model: ModelKind::Turbo
      }
    );
    let err = |s: &[&str]| p(s, None).unwrap_err();
    assert_eq!(err(&["eval", "a", "b"]), "unexpected argument b");
    assert_eq!(err(&["fixtures", "a"]), "unexpected argument a");
    assert_eq!(err(&["eval", "--note"]), "eval does not take --note");
    assert_eq!(
      err(&["run", "a.wav", "--out", "x"]),
      "run does not take --out"
    );
  }

  #[test]
  fn the_app_s_own_folders_are_refused() {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let app = home.join("Library/Application Support/com.tabtasker.dictate/models");
    let app = app.to_str().unwrap();
    assert_eq!(
      p(&["fetch", "--models", app], None).unwrap_err(),
      format!("{app} is the app's own data; the lab keeps its models elsewhere")
    );
    assert!(p(&["fetch"], Some(app)).is_err());
    // Nor are fixtures written there, or read from there.
    let docs = home.join("Documents/TabTasker Dictate");
    let docs = docs.to_str().unwrap();
    assert_eq!(
      p(&["fixtures", "--out", docs], None).unwrap_err(),
      format!("{docs} is the app's own data; the lab keeps its fixtures elsewhere")
    );
    assert!(p(&["eval", docs], None).is_err());
  }
}
