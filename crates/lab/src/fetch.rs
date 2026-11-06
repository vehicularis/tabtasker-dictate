//! The `fetch` command: the speech models, downloaded into the lab's models folder.

use dictate_engine::models::{self, ModelFile, ModelKind, SPEAKER_EMBEDDING, SPEAKER_SEGMENTATION};
use std::{path::Path, sync::atomic::AtomicBool};

/// The meeting's speaker models, which only `--speakers` downloads.
const SPEAKERS: &[ModelFile] = &[SPEAKER_SEGMENTATION, SPEAKER_EMBEDDING];

/// Downloads whichever of `kind`'s files (and the speaker models, with `speakers`) `dir` is missing,
/// a line for each progress report, then names the folder. Under `--json` the progress goes to stderr
/// and stdout holds one document.
pub fn run(dir: &Path, kind: ModelKind, speakers: bool, json: bool) -> Result<(), String> {
  let mut sets = vec![kind.files()];
  if speakers {
    sets.push(SPEAKERS);
  }
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
  let runtime = tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .map_err(|e| format!("cannot start the download: {e}"))?;
  for files in &sets {
    runtime
      .block_on(models::fetch(dir, files, &cancel, &free_space, &report))
      .map_err(String::from)?;
  }
  let names: Vec<&str> = sets
    .iter()
    .copied()
    .flatten()
    .map(|model| model.name)
    .collect();
  if json {
    println!("{}", serde_json::json!({ "folder": dir, "files": names }));
  } else {
    println!("models are in {}: {}", dir.display(), names.join(", "));
  }
  Ok(())
}
