//! The speech models: which files each needs, how they are checked, and how they are downloaded.
use crate::error::Result;
use ring::digest::{Context as Digest, SHA256};
use serde::{Deserialize, Serialize};
use std::{fs::{self, File}, io::{Read, Write}, path::Path, sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};

/// A file the voice features download once and keep, checked against its size and SHA-256 every time.
#[derive(Debug)]
pub struct ModelFile {
  /// Path under the models folder.
  pub name: &'static str,
  /// What the person sees while it downloads.
  pub label: &'static str,
  /// Where it is downloaded from.
  pub url: &'static str,
  /// Its exact size.
  pub bytes: u64,
  /// Its SHA-256, in lowercase hex.
  pub sha256: &'static str,
}
// Whisper large-v3 Turbo fine-tuned to keep its accuracy when the encoder sees only the speech rather
// than a 30 s window (FUTO's audio context fine-tuning), in whisper.cpp's 8-bit format.
/// Whisper large-v3 Turbo, the default speech model.
pub const TURBO: ModelFile = ModelFile {
  name: "ggml-acft-large-v3-turbo-q8_0.bin", label: "Whisper large-v3 Turbo", bytes: 874188075,
  url: "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v2/ggml-acft-large-v3-turbo-q8_0.bin",
  sha256: "e8d17bf90d61da165773e8a4bb7de3462982eceb9a1ed696c0d6fe7c9136624a",
};
// whisper.cpp's own small model in its 8-bit format, as published in ggerganov/whisper.cpp on Hugging Face.
/// Whisper small, the lighter choice.
pub const SMALL: ModelFile = ModelFile {
  name: "ggml-small-q8_0.bin", label: "Whisper small", bytes: 264464607,
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin",
  sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
};
/// Speech detection, which every Whisper choice needs beside it.
pub const SILERO: ModelFile = ModelFile {
  name: "ggml-silero-v6.2.0.bin", label: "speech detection", bytes: 885098,
  url: "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v1/ggml-silero-v6.2.0.bin",
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
};
/// pyannote/segmentation-3.0 as sherpa-onnx ships it (MIT), in its archive; the model inside is kept beside it.
pub const SPEAKER_SEGMENTATION: ModelFile = ModelFile {
  name: "speakers/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", label: "speaker segmentation", bytes: 6_958_444,
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
  sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
};
/// NVIDIA NeMo's TitaNet small (CC BY 4.0), the English-trained speaker embedding sherpa-onnx recommends.
pub const SPEAKER_EMBEDDING: ModelFile = ModelFile {
  name: "speakers/nemo_en_titanet_small.onnx", label: "speaker voices", bytes: 40_257_283,
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx",
  sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
};
const WITH_TURBO: &[ModelFile] = &[TURBO, SILERO];
const WITH_SMALL: &[ModelFile] = &[SMALL, SILERO];
/// Models an earlier version downloaded, removed once their replacement is in place.
pub const RETIRED: &[&str] = &["ggml-large-v3-turbo-q8_0.bin"];

/// The speech model chosen in Settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelKind {
  /// Whisper large-v3 Turbo.
  Turbo,
  /// Whisper small.
  Small,
}
impl ModelKind {
  /// What this speech model needs on disk: its Whisper first, then the speech detection beside it.
  pub fn files(self) -> &'static [ModelFile] {
    match self { Self::Turbo => WITH_TURBO, Self::Small => WITH_SMALL }
  }
  /// The other choice.
  pub fn other(self) -> Self {
    match self { Self::Turbo => Self::Small, Self::Small => Self::Turbo }
  }
}

/// Whether the file at `path` is `model`: the right size and the right SHA-256.
pub fn verify(path: &Path, model: &ModelFile) -> Result<()> {
  let mut file = File::open(path).map_err(|_| "The speech model isn’t downloaded yet.")?;
  if file.metadata().map_err(|e| e.to_string())?.len() != model.bytes { return Err("The speech model is incomplete. Download it again.".into()); }
  let mut digest = Digest::new(&SHA256);
  let mut buffer = [0; 64 * 1024];
  loop { let count = file.read(&mut buffer).map_err(|e| e.to_string())?; if count == 0 { break; } digest.update(&buffer[..count]); }
  let hash: String = digest.finish().as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
  if hash != model.sha256 { return Err("The speech model didn’t pass its check. Download it again.".into()); }
  Ok(())
}

/// The file at `path` as its check saw it: size, modification time and inode, which a rewrite or a new
/// download changes, and the hash it was checked against.
fn stamp(path: &Path, model: &ModelFile) -> Option<String> {
  use std::os::unix::fs::MetadataExt;
  let meta = fs::metadata(path).ok()?;
  Some(format!("{} {}.{:09} {} {}", meta.len(), meta.mtime(), meta.mtime_nsec(), meta.ino(), model.sha256))
}

/// Remembers, beside it, that the file at `path` passed its check.
fn passed(path: &Path, model: &ModelFile) {
  if let Some(stamp) = stamp(path, model) { let _ = fs::write(path.with_extension("verified"), stamp); }
}

/// `verify`, hashing only a file that changed since it last passed: the 874 MB model would otherwise
/// cost seconds of hashing at every launch.
pub fn verified(path: &Path, model: &ModelFile) -> Result<()> {
  if stamp(path, model).is_some_and(|stamp| fs::read_to_string(path.with_extension("verified")).is_ok_and(|kept| kept == stamp)) { return Ok(()); }
  verify(path, model)?;
  passed(path, model);
  Ok(())
}

fn download_client() -> std::result::Result<reqwest::Client, String> {
  if rustls::crypto::CryptoProvider::get_default().is_none() { let _ = rustls::crypto::ring::default_provider().install_default(); }
  // No deadline on the whole download, which a slow connection can't meet: each read gets 30 s instead.
  reqwest::Client::builder().https_only(true).referer(false)
    .connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(30))
    .redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|e| e.to_string())
}

/// How many bytes short `free` is of downloading `bytes` with a fifth again to spare, so the Mac isn't
/// left full. Space that can't be told doesn't stop a download.
pub fn short_of_space(free: Option<u64>, bytes: u64) -> Option<u64> {
  let need = bytes + bytes / 5;
  free.filter(|free| *free < need).map(|free| need - free)
}

/// What a response says to do with a `.part` holding `have` of `total` bytes.
#[derive(Debug, PartialEq)]
enum Resume { Append, Overwrite, Restart, Retry, WrongSize, Refused }

/// 206 with the rest from where the part ends adds to it; 200 is the whole file, written over it. Any other
/// range, or none the server can give, starts the part again. A server error is worth another try, any
/// other answer isn't.
fn resume(status: u16, range: Option<&str>, length: Option<u64>, have: u64, total: u64) -> Resume {
  let rest = |from: u64| length.is_none_or(|length| length == total - from);
  let start = range.and_then(|range| range.strip_prefix("bytes ")?.split('-').next()?.parse::<u64>().ok());
  match status {
    200 if rest(0) => Resume::Overwrite,
    200 => Resume::WrongSize,
    206 if start == Some(have) && rest(have) => Resume::Append,
    206 | 416 => Resume::Restart,
    500..=599 => Resume::Retry,
    _ => Resume::Refused,
  }
}

/// The wait before trying a download again: 1, 2 and 4 s, then it gives up.
fn backoff(tries: u32) -> Option<Duration> { (tries < 3).then(|| Duration::from_secs(1 << tries)) }

/// Why a download attempt stopped short: a dropped connection or a server's passing trouble is worth
/// another try, anything else isn't.
enum Stop { Retry(String), Fail(String) }

/// One attempt at `model` into `partial`, carrying on from what it holds already.
async fn download(client: &reqwest::Client, model: &ModelFile, partial: &Path, cancel: &AtomicBool, report: &(impl Fn(&str, Option<u8>) + Sync)) -> std::result::Result<(), Stop> {
  let have = match fs::metadata(partial).map_or(0, |meta| meta.len()) {
    have if have == model.bytes => return Ok(()), // all here: its check says whether it's right
    have if have < model.bytes => have,
    _ => 0,
  };
  let interrupted = || Stop::Retry("The speech model download was interrupted. Try again.".into());
  let mut request = client.get(model.url);
  if have > 0 { request = request.header(reqwest::header::RANGE, format!("bytes={have}-")); }
  let mut response = request.send().await.map_err(|_| Stop::Retry("Couldn’t download the speech model. Check your connection and try again.".into()))?;
  let range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()).map(str::to_owned);
  let save = |e: std::io::Error| Stop::Fail(format!("Couldn’t save the speech model: {e}"));
  let mut file = match resume(response.status().as_u16(), range.as_deref(), response.content_length(), have, model.bytes) {
    Resume::Append => fs::OpenOptions::new().append(true).open(partial).map_err(save)?,
    Resume::Overwrite => File::create(partial).map_err(save)?,
    Resume::Restart => { File::create(partial).map_err(save)?; return Err(interrupted()); }
    Resume::Retry => return Err(Stop::Retry("The speech model can’t be downloaded right now. Try again later.".into())),
    Resume::WrongSize => return Err(Stop::Fail("The download isn’t the size it should be. Try again.".into())),
    Resume::Refused => return Err(Stop::Fail("The speech model can’t be downloaded right now. Try again later.".into())),
  };
  let mut bytes = file.metadata().map_err(save)?.len();
  let mut last = Instant::now() - Duration::from_secs(1);
  loop {
    if cancel.load(Ordering::Relaxed) { return Err(Stop::Fail(CANCELLED.into())); }
    let Some(chunk) = response.chunk().await.map_err(|_| interrupted())? else { break };
    bytes += chunk.len() as u64;
    if bytes > model.bytes { return Err(Stop::Fail("The download is bigger than it should be. Try again.".into())); }
    file.write_all(&chunk).map_err(save)?;
    if last.elapsed() >= Duration::from_millis(500) {
      let percent = (bytes * 100 / model.bytes) as u8;
      report(&format!("Downloading {} · {percent}%", model.label), Some(percent));
      last = Instant::now();
    }
  }
  if bytes < model.bytes { return Err(interrupted()); } // the connection closed early: the rest comes next try
  file.sync_all().map_err(save)
}

/// Downloads whichever of `models` is missing or fails its check, reporting progress through `report`:
/// a line for the person, and how much of the download is done while it is downloading. A download that
/// stops carries on where it stopped, here or at the next try; its `.part` goes only when it fails its
/// check or setup is cancelled. `free_space` says how many bytes are free where the file goes.
pub async fn fetch(root: &Path, models: &'static [ModelFile], cancel: &AtomicBool, free_space: &(dyn Fn(&Path) -> Option<u64> + Sync), report: &(impl Fn(&str, Option<u8>) + Sync)) -> Result<()> {
  for model in models {
    if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
    let path = root.join(model.name);
    let dir = path.parent().unwrap_or(root);
    fs::create_dir_all(dir).map_err(|e| format!("Couldn’t make a folder for the speech model: {e}"))?;
    let check = path.clone();
    if tokio::task::spawn_blocking(move || verified(&check, model)).await.map_err(|e| e.to_string())?.is_ok() { continue; }
    let partial = path.with_extension("part");
    let left = fs::metadata(&partial).ok().and_then(|meta| model.bytes.checked_sub(meta.len())).unwrap_or(model.bytes);
    if let Some(short) = short_of_space(free_space(dir), left) {
      return Err(format!("There isn’t enough space to download {}. Free up {:.1} GB and try again.", model.label, (short as f64 / 1e8).ceil() / 10.0).into());
    }
    let client = download_client()?;
    let mut tries = 0;
    loop {
      let before = fs::metadata(&partial).map_or(0, |meta| meta.len());
      match download(&client, model, &partial, cancel, report).await {
        Ok(()) => break,
        Err(Stop::Fail(error)) => return Err(error.into()),
        Err(Stop::Retry(error)) => {
          // Three tries in a row that get nowhere; one that got further starts the count again.
          if fs::metadata(&partial).is_ok_and(|meta| meta.len() > before) { tries = 0; }
          let Some(wait) = backoff(tries) else { return Err(error.into()) };
          tries += 1;
          tokio::time::sleep(wait).await;
        }
      }
    }
    report("Checking the download…", None);
    let check = partial.clone();
    if let Err(error) = tokio::task::spawn_blocking(move || verify(&check, model)).await.map_err(|e| e.to_string())? {
      let _ = fs::remove_file(&partial); // what it holds is wrong somewhere, so it starts again
      return Err(error);
    }
    if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
    fs::rename(&partial, &path).map_err(|e| format!("Couldn’t install the speech model: {e}"))?;
    passed(&path, model);
  }
  Ok(())
}

/// The text `fetch` and `cancellable` fail with, as `Error::Other`, when `cancel` is set. It is not
/// `Error::Cancelled`, whose text is a voice command's.
pub const CANCELLED: &str = "Speech model setup was cancelled.";

async fn wait_cancelled(cancel: &AtomicBool) {
  while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(100)).await; }
}

/// `work`, or `CANCELLED` as soon as `cancel` is set.
pub async fn cancellable<T>(cancel: &AtomicBool, work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
  tokio::select! {
    result = work => result,
    _ = wait_cancelled(cancel) => Err(CANCELLED.into()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{path::PathBuf, sync::Arc};

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-engine-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn download_client_initializes_tls_in_a_fresh_process() {
    const PROBE: &str = "TABTASKER_VOICE_CLIENT_TEST";
    if std::env::var_os(PROBE).is_some() {
      assert!(rustls::crypto::CryptoProvider::get_default().is_none());
      assert!(download_client().is_ok());
      assert!(rustls::crypto::CryptoProvider::get_default().is_some());
      return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
      .args(["--exact", "models::tests::download_client_initializes_tls_in_a_fresh_process", "--nocapture"])
      .env(PROBE, "1").output().unwrap();
    assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"), "the probe ran: {}", String::from_utf8_lossy(&output.stdout));
  }

  #[test]
  fn model_bytes_must_match_both_pinned_size_and_hash() {
    let dir = std::env::temp_dir().join(format!("dictate-engine-integrity-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("model.bin");
    let model = ModelFile { name: "model.bin", label: "test", url: "", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    std::fs::write(&path, b"abc").unwrap(); assert!(verify(&path, &model).is_ok());
    std::fs::write(&path, b"abd").unwrap(); assert!(verify(&path, &model).is_err());
    std::fs::write(&path, b"ab").unwrap(); assert!(verify(&path, &model).is_err());
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[tokio::test]
  async fn cancellation_interrupts_a_stalled_download() {
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let waiting = tokio::spawn(async move {
      cancellable(&signal, std::future::pending::<Result<()>>()).await
    });
    tokio::task::yield_now().await;
    cancel.store(true, Ordering::Relaxed);
    assert!(tokio::time::timeout(Duration::from_millis(500), waiting).await.unwrap().unwrap().is_err());
  }

  #[test]
  fn each_model_choice_downloads_its_whisper_and_the_speech_detection() {
    for (choice, name) in [(ModelKind::Turbo, "ggml-acft-large-v3-turbo-q8_0.bin"), (ModelKind::Small, "ggml-small-q8_0.bin")] {
      let names: Vec<&str> = choice.files().iter().map(|model| model.name).collect();
      assert_eq!(names, [name, SILERO.name]);
      for model in choice.files() {
        assert!(model.url.starts_with("https://") && model.url.ends_with(model.name), "{}", model.url);
        assert_eq!(model.sha256.len(), 64);
        assert!(model.sha256.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
      }
    }
    // whisper.cpp's own small model, as published.
    assert_eq!((SMALL.bytes, SMALL.sha256), (264464607, "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f"));
    assert!(SMALL.url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"));
  }

  #[test]
  fn a_dropped_download_carries_on_where_it_stopped() {
    const TOTAL: u64 = 1000;
    // The rest, from where the part ends: added to it.
    assert_eq!(resume(206, Some("bytes 400-999/1000"), Some(600), 400, TOTAL), Resume::Append);
    assert_eq!(resume(206, Some("bytes 400-999/1000"), None, 400, TOTAL), Resume::Append);
    // The whole file, from a server that ignores ranges or a part that was empty: written over it.
    assert_eq!(resume(200, None, Some(1000), 400, TOTAL), Resume::Overwrite);
    assert_eq!(resume(200, None, Some(1000), 0, TOTAL), Resume::Overwrite);
    assert_eq!(resume(200, None, Some(999), 0, TOTAL), Resume::WrongSize);
    // Another range, the wrong length, or none the server can give: the part starts again.
    assert_eq!(resume(206, Some("bytes 0-999/1000"), Some(1000), 400, TOTAL), Resume::Restart);
    assert_eq!(resume(206, Some("bytes 400-999/1000"), Some(500), 400, TOTAL), Resume::Restart);
    assert_eq!(resume(206, None, Some(600), 400, TOTAL), Resume::Restart);
    assert_eq!(resume(416, None, None, 400, TOTAL), Resume::Restart);
    // A server's trouble is worth another try; a refusal isn't.
    assert_eq!(resume(503, None, None, 400, TOTAL), Resume::Retry);
    assert_eq!(resume(500, None, None, 0, TOTAL), Resume::Retry);
    assert_eq!(resume(404, None, None, 0, TOTAL), Resume::Refused);
    assert_eq!(resume(403, None, None, 400, TOTAL), Resume::Refused);
  }

  #[test]
  fn a_download_tries_again_after_one_two_and_four_seconds_then_gives_up() {
    assert_eq!((0..5).map(backoff).collect::<Vec<_>>(), [Some(Duration::from_secs(1)), Some(Duration::from_secs(2)), Some(Duration::from_secs(4)), None, None]);
  }

  #[test]
  fn a_download_needs_a_fifth_more_space_than_it_takes() {
    let gb = 1_000_000_000;
    assert_eq!(short_of_space(Some(2 * gb), TURBO.bytes), None);
    assert_eq!(short_of_space(Some(TURBO.bytes + TURBO.bytes / 5), TURBO.bytes), None);
    assert_eq!(short_of_space(Some(TURBO.bytes), TURBO.bytes), Some(TURBO.bytes / 5));
    assert_eq!(short_of_space(Some(0), 100), Some(120));
    assert_eq!(short_of_space(None, TURBO.bytes), None, "space that can't be told doesn't stop it");
    // What is left of a resumed download is what counts.
    assert_eq!(short_of_space(Some(gb / 5), TURBO.bytes / 10), None);
  }

  #[test]
  fn a_model_is_hashed_again_only_once_it_changes() {
    let dir = temp_dir("stamp");
    let path = dir.join("model.bin");
    let model = ModelFile { name: "model.bin", label: "test", url: "", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    std::fs::write(&path, b"abd").unwrap();
    assert!(verified(&path, &model).is_err());
    assert!(!path.with_extension("verified").exists(), "a model that fails is never remembered as passing");
    std::fs::write(&path, b"abc").unwrap();
    assert!(verified(&path, &model).is_ok());
    assert_eq!(std::fs::read_to_string(path.with_extension("verified")).ok(), stamp(&path, &model));
    // Same size, time and inode: taken as passed without hashing, which these bytes wouldn't.
    let when = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"abd").unwrap();
    File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
    assert!(verified(&path, &model).is_ok());
    // Written since: hashed again.
    File::options().write(true).open(&path).unwrap().set_modified(when + Duration::from_secs(1)).unwrap();
    assert!(verified(&path, &model).is_err());
    // A stamp for another hash of the same file is no use either.
    std::fs::write(&path, b"abc").unwrap();
    assert!(verified(&path, &model).is_ok());
    let other = ModelFile { sha256: "0000000000000000000000000000000000000000000000000000000000000000", ..model };
    assert!(verified(&path, &other).is_err());
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn catalog_is_unchanged() {
    let all = [
      (TURBO, "ggml-acft-large-v3-turbo-q8_0.bin", "Whisper large-v3 Turbo", 874188075, "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v2/ggml-acft-large-v3-turbo-q8_0.bin", "e8d17bf90d61da165773e8a4bb7de3462982eceb9a1ed696c0d6fe7c9136624a"),
      (SMALL, "ggml-small-q8_0.bin", "Whisper small", 264464607, "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin", "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f"),
      (SILERO, "ggml-silero-v6.2.0.bin", "speech detection", 885098, "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v1/ggml-silero-v6.2.0.bin", "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"),
      (SPEAKER_SEGMENTATION, "speakers/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", "speaker segmentation", 6_958_444, "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"),
      (SPEAKER_EMBEDDING, "speakers/nemo_en_titanet_small.onnx", "speaker voices", 40_257_283, "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx", "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e"),
    ];
    for (file, name, label, bytes, url, sha256) in all {
      assert_eq!((file.name, file.label, file.bytes, file.url, file.sha256), (name, label, bytes, url, sha256));
    }
    assert_eq!(RETIRED, ["ggml-large-v3-turbo-q8_0.bin"]);
  }

  #[test]
  fn stamp_format_is_unchanged() {
    use std::os::unix::fs::MetadataExt;
    let dir = temp_dir("stamp-format");
    let path = dir.join("model.bin");
    let model = ModelFile { name: "model.bin", label: "test", url: "", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    std::fs::write(&path, b"abc").unwrap();
    passed(&path, &model);
    let meta = std::fs::metadata(&path).unwrap();
    let want = format!("{} {}.{:09} {} {}", meta.len(), meta.mtime(), meta.mtime_nsec(), meta.ino(), model.sha256);
    assert_eq!(std::fs::read_to_string(path.with_extension("verified")).unwrap(), want);
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn model_kinds_serialize_as_before() {
    assert_eq!(serde_json::to_string(&ModelKind::Turbo).unwrap(), "\"turbo\"");
    assert_eq!(serde_json::to_string(&ModelKind::Small).unwrap(), "\"small\"");
    assert_eq!(serde_json::from_str::<ModelKind>("\"turbo\"").unwrap(), ModelKind::Turbo);
    assert_eq!(serde_json::from_str::<ModelKind>("\"small\"").unwrap(), ModelKind::Small);
    assert_eq!(ModelKind::Turbo.other(), ModelKind::Small);
    assert_eq!(ModelKind::Small.other(), ModelKind::Turbo);
  }
}
