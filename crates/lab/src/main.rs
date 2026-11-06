//! dictate-lab: runs the dictation pipeline without the app.
#![deny(missing_docs)]

mod args;
mod text;
// ponytail: read and write are first used by the commands that come after text.
#[allow(dead_code)]
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
  match args.command {
    Command::Help => println!("{}", args::USAGE),
    ref c @ Command::Text { .. } => println!("{}", text::run(c, args.json)),
  }
}
