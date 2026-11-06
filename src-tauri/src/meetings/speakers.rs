//! Who said what in a meeting: speaker diarization on this Mac, with sherpa-onnx (pyannote's
//! segmentation model finds where voices start and stop, a speaker-embedding model gives each stretch a
//! voiceprint, and clustering groups the voiceprints into speakers). Two small models are downloaded the
//! first time a meeting needs them, next to the voice models.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::dictation::speech;
use dictate_engine::meeting::speakers::{ready, SEGMENTATION_ONNX};
use dictate_engine::models::{self, ModelFile, SPEAKER_EMBEDDING as EMBEDDING, SPEAKER_SEGMENTATION as SEGMENTATION};
const MODELS: &[ModelFile] = &[SEGMENTATION, EMBEDDING];
/// The member of the archive that is the model.
const ARCHIVE_MEMBER: &str = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx";
static PREPARING: AtomicBool = AtomicBool::new(false);

/// Downloads what is missing and unpacks the segmentation model. Errors are the downloader's words.
pub async fn prepare(root: PathBuf) -> Result<(), String> {
  let never = AtomicBool::new(false);
  models::fetch(&root, MODELS, &never, &speech::free_space, &|line, _| log::info!("speakers: {line}")).await?;
  if root.join(SEGMENTATION_ONNX).is_file() { return Ok(()); }
  let dir = root.join("speakers");
  let (archive, into) = (root.join(SEGMENTATION.name).display().to_string(), dir.display().to_string());
  let unpacked = tauri::async_runtime::spawn_blocking(move || {
    std::process::Command::new("/usr/bin/tar").args(["-xjf", &archive, "-C", &into, "--strip-components=1", ARCHIVE_MEMBER]).output()
  }).await.map_err(|e| e.to_string())?.map_err(|e| format!("Couldn’t unpack the speaker model: {e}"))?;
  if !unpacked.status.success() { return Err(format!("Couldn’t unpack the speaker model: {}", String::from_utf8_lossy(&unpacked.stderr).trim())); }
  std::fs::rename(dir.join("model.onnx"), root.join(SEGMENTATION_ONNX)).map_err(|e| format!("Couldn’t install the speaker model: {e}"))
}

/// Starts the download in the background when Meetings wants speakers told apart and the models aren't
/// here yet: called as a meeting begins, so they are usually ready by the time it ends.
pub fn prepare_in_background() {
  if !crate::settings::get().meetings.speakers { return; }
  let Some(root) = speech::models_root() else { return };
  if ready(&root) || PREPARING.swap(true, Ordering::SeqCst) { return; }
  tauri::async_runtime::spawn(async move {
    match prepare(root).await {
      Ok(()) => log::info!("speakers: models ready"),
      Err(e) => log::warn!("speakers: {e}"),
    }
    PREPARING.store(false, Ordering::SeqCst);
  });
}
