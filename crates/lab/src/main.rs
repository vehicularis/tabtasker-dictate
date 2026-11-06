//! dictate-lab: runs the dictation pipeline without the app.
#![deny(missing_docs)]

mod args;
mod eval;
mod fetch;
mod fixtures;
mod run;
mod score;
mod text;
mod wav;

use args::Command;

/// Why a command ended without doing what it was asked, which sets the exit code.
#[derive(Debug, PartialEq)]
pub enum Failure {
  /// A fixture or a recording failed: exit 1.
  Failed(String),
  /// The lab couldn't run: a model missing or unloadable, a folder unreadable or empty, or `say`
  /// failing. Exit 3.
  Broken(String),
}

/// An error that names no fixture or recording is one the lab couldn't run past.
impl From<String> for Failure {
  fn from(e: String) -> Self {
    Failure::Broken(e)
  }
}

fn main() {
  let env = std::env::var_os("DICTATE_MODELS").map(Into::into);
  let args = match args::parse(std::env::args().skip(1), env) {
    Ok(a) => a,
    Err(e) => {
      eprintln!("{e}");
      std::process::exit(2);
    }
  };
  let done = match args.command {
    Command::Help => {
      println!("{}", args::USAGE);
      Ok(())
    }
    Command::Text(ref t) => {
      println!("{}", text::run(t, args.json));
      Ok(())
    }
    Command::Fetch { model } => fetch::run(&args.models, model, args.json).map_err(Failure::Broken),
    Command::Run {
      ref files,
      model,
      ref hearing,
    } => run::run(&args.models, files, model, hearing, args.json),
    Command::Fixtures { ref out } => fixtures::run(out, args.json),
    Command::Eval { ref dir, model } => eval::run(dir, &args.models, model, args.json),
  };
  if let Err(e) = done {
    let (code, e) = match e {
      Failure::Failed(e) => (1, e),
      Failure::Broken(e) => (3, e),
    };
    eprintln!("{e}");
    std::process::exit(code);
  }
}
