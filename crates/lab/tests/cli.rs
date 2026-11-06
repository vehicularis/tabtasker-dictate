//! Runs the built binary.

use dictate_engine::text::{finish, Rules, Style};
use std::process::Command;

fn run(extra: &[&str]) -> std::process::Output {
  Command::new(env!("CARGO_BIN_EXE_dictate-lab"))
    .args(["text", "um so this works", "--style", "formal", "--fillers"])
    .args(extra)
    .output()
    .unwrap()
}

fn expected() -> String {
  finish(
    "um so this works",
    &Rules {
      style: Style::Formal,
      fillers: true,
      replacements: &[],
      language: None,
      live: false,
    },
  )
}

#[test]
fn text_prints_what_finish_returns() {
  let out = run(&[]);
  assert_eq!(out.status.code(), Some(0));
  assert_eq!(
    String::from_utf8(out.stdout).unwrap(),
    format!("{}\n", expected())
  );
}

#[test]
fn text_json_is_one_document() {
  let out = run(&["--json"]);
  assert_eq!(out.status.code(), Some(0));
  let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
  assert_eq!(v["raw"], "um so this works");
  assert_eq!(v["finished"], expected());
}

#[test]
fn bad_flag_exits_2_on_stderr() {
  let out = Command::new(env!("CARGO_BIN_EXE_dictate-lab"))
    .args(["text", "x", "--nope"])
    .output()
    .unwrap();
  assert_eq!(out.status.code(), Some(2));
  assert!(out.stdout.is_empty());
  assert_eq!(
    String::from_utf8(out.stderr).unwrap(),
    "unknown flag --nope\n"
  );
}
