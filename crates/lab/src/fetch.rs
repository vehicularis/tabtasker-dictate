//! The `fetch` command: the speech models, downloaded into the lab's models folder.

use dictate_engine::models::{self, ModelKind};
use std::{path::Path, sync::atomic::AtomicBool};

/// Downloads whichever of `kind`'s files `dir` is missing, a line for each progress report, then names
/// the folder. Under `--json` the progress goes to stderr and stdout holds one document.
pub fn run(dir: &Path, kind: ModelKind, json: bool) -> Result<(), String> {
  let files = kind.files();
  let report = |line: &str, _: Option<u8>| {
    if json {
      eprintln!("{line}");
    } else {
      println!("{line}");
    }
  };
  let cancel = AtomicBool::new(false);
  // ponytail: no free-space check; a full disk fails the write instead.
  let free_space = |_: &Path| None;
  let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| format!("cannot start the download: {e}"))?;
  runtime.block_on(models::fetch(dir, files, &cancel, &free_space, &report)).map_err(String::from)?;
  let names: Vec<&str> = files.iter().map(|model| model.name).collect();
  if json {
    println!("{}", serde_json::json!({ "folder": dir, "files": names }));
  } else {
    println!("models are in {}: {}", dir.display(), names.join(", "));
  }
  Ok(())
}
