//! The hand-written argument parser.

use dictate_engine::text::{Replacement, Style};
use std::path::PathBuf;

/// What the lab was asked to do.
#[derive(Debug, PartialEq)]
pub enum Command {
  /// Print usage.
  Help,
  /// Run only the text rules on a raw string.
  Text {
    /// The raw transcript.
    raw: String,
    /// The style to finish with.
    style: Style,
    /// Whether to drop fillers.
    fillers: bool,
    /// The language code, if any.
    language: Option<String>,
    /// The custom replacements, in order.
    replacements: Vec<Replacement>,
    /// Whether to finish as live typing would.
    live: bool,
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

Options for every command:
  --json         Print one JSON document and nothing else on stdout.
  --models DIR   The folder models live in. Defaults to $DICTATE_MODELS,
                 then target/models in the repo.
  --help         Print this text.";

/// The default models folder: `<repo root>/target/models`.
/// The repo root is fixed at build time, which is fine for a dev tool.
fn default_models() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/models")
}

fn style_of(s: &str) -> Result<Style, String> {
  serde_json::from_value(serde_json::Value::String(s.to_string()))
    .map_err(|_| format!("--style: unknown style {s}; use default, casual, formal, code or raw"))
}

/// Parses the arguments after the program name. `env_models` is `$DICTATE_MODELS`.
pub fn parse(
  args: impl Iterator<Item = String>,
  env_models: Option<PathBuf>,
) -> Result<Args, String> {
  let mut args = args.peekable();
  let mut json = false;
  let mut models = None;
  let mut help = false;
  let command = match args.next().as_deref() {
    None | Some("--help" | "-h" | "help") => {
      return Ok(Args {
        command: Command::Help,
        json,
        models: env_models.unwrap_or_else(default_models),
      })
    }
    Some("text") => "text",
    Some(other) => return Err(format!("unknown command {other}; try --help")),
  };
  let mut raw = None;
  let (mut style, mut fillers, mut language, mut replacements, mut live) =
    (Style::Default, false, None, Vec::new(), false);
  while let Some(a) = args.next() {
    let mut value = |flag: &str| args.next().ok_or_else(|| format!("{flag} needs a value"));
    match a.as_str() {
      "--json" => json = true,
      "--help" | "-h" => help = true,
      "--models" => models = Some(PathBuf::from(value("--models")?)),
      "--style" => style = style_of(&value("--style")?)?,
      "--fillers" => fillers = true,
      "--live" => live = true,
      "--language" => language = Some(value("--language")?),
      "--replace" => {
        let v = value("--replace")?;
        let (from, to) = v
          .split_once('=')
          .ok_or_else(|| format!("--replace needs FROM=TO, got {v}"))?;
        replacements.push(Replacement {
          from: from.to_string(),
          to: to.to_string(),
        });
      }
      f if f.starts_with("--") => return Err(format!("unknown flag {f}")),
      _ if raw.is_none() => raw = Some(a),
      _ => return Err(format!("unexpected argument {a}")),
    }
  }
  let models = models.or(env_models).unwrap_or_else(default_models);
  if help {
    return Ok(Args {
      command: Command::Help,
      json,
      models,
    });
  }
  debug_assert_eq!(command, "text");
  let raw = raw.ok_or("text needs the raw string to finish")?;
  Ok(Args {
    command: Command::Text {
      raw,
      style,
      fillers,
      language,
      replacements,
      live,
    },
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
      Command::Text {
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
      }
    );
  }

  #[test]
  fn help_when_empty_or_asked() {
    assert_eq!(p(&[], None).unwrap().command, Command::Help);
    assert_eq!(p(&["--help"], None).unwrap().command, Command::Help);
    assert_eq!(p(&["text", "--help"], None).unwrap().command, Command::Help);
  }

  #[test]
  fn bad_arguments_name_the_flag() {
    assert_eq!(
      p(&["text", "x", "--nope"], None).unwrap_err(),
      "unknown flag --nope"
    );
    assert_eq!(
      p(&["text", "x", "--style"], None).unwrap_err(),
      "--style needs a value"
    );
    assert!(p(&["text", "x", "--style", "loud"], None)
      .unwrap_err()
      .starts_with("--style: unknown style loud"));
    assert!(p(&["text", "x", "--replace", "ab"], None)
      .unwrap_err()
      .starts_with("--replace needs FROM=TO"));
    assert!(p(&["text"], None).is_err());
    assert!(p(&["dance"], None)
      .unwrap_err()
      .starts_with("unknown command dance"));
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
    assert!(p(&["text", "x"], None)
      .unwrap()
      .models
      .ends_with("target/models"));
  }
}
