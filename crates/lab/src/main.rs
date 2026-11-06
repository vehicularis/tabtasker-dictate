//! dictate-lab: runs the dictation pipeline without the app.
#![deny(missing_docs)]

mod args;
mod fetch;
mod run;
// ponytail: eval (the next task) is its first caller.
#[allow(dead_code)]
mod score;
mod text;
mod wav;

use args::Command;

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
    Command::Fetch { model, speakers } => fetch::run(&args.models, model, speakers, args.json),
    Command::Run {
      ref files,
      model,
      ref hearing,
    } => run::run(&args.models, files, model, hearing, args.json),
  };
  if let Err(e) = done {
    eprintln!("{e}");
    std::process::exit(1);
  }
}
