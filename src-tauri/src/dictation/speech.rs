use std::{ffi::{c_char, c_void, CStr, CString}, fs::{self, File}, io::{Read, Write}, panic::{catch_unwind, AssertUnwindSafe}, path::{Path, PathBuf}, sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use ring::digest::{Context as Digest, SHA256};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};
use crate::dictation::{context, history, text};
use crate::{ai, settings};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperSysContext, WhisperSysState, WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

/// A hold listens for up to five minutes.
const MAX_SAMPLES: usize = 5 * 60 * 16000;
/// A hands-free session listens for up to ten minutes.
const HANDS_FREE_SAMPLES: usize = 10 * 60 * 16000;
/// A file the voice features download once and keep, checked against its size and SHA-256 every time.
pub(crate) struct Model { pub name: &'static str, pub label: &'static str, pub url: &'static str, pub bytes: u64, pub sha256: &'static str }
// Whisper large-v3 Turbo fine-tuned to keep its accuracy when the encoder sees only the speech rather
// than a 30 s window (FUTO's audio context fine-tuning), in whisper.cpp's 8-bit format.
const TURBO: Model = Model {
  name: "ggml-acft-large-v3-turbo-q8_0.bin", label: "Whisper large-v3 Turbo", bytes: 874188075,
  url: "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v2/ggml-acft-large-v3-turbo-q8_0.bin",
  sha256: "e8d17bf90d61da165773e8a4bb7de3462982eceb9a1ed696c0d6fe7c9136624a",
};
// whisper.cpp's own small model in its 8-bit format, as published in ggerganov/whisper.cpp on Hugging Face.
const SMALL: Model = Model {
  name: "ggml-small-q8_0.bin", label: "Whisper small", bytes: 264464607,
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin",
  sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
};
const SILERO: Model = Model {
  name: "ggml-silero-v6.2.0.bin", label: "speech detection", bytes: 885098,
  url: "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v1/ggml-silero-v6.2.0.bin",
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
};
const WITH_TURBO: &[Model] = &[TURBO, SILERO];
const WITH_SMALL: &[Model] = &[SMALL, SILERO];
/// What a speech model in Settings needs on disk: its Whisper first, then the speech detection beside it.
fn files(model: settings::Model) -> &'static [Model] {
  match model { settings::Model::Turbo => WITH_TURBO, settings::Model::Small => WITH_SMALL }
}
/// Models an earlier version downloaded, removed once their replacement is in place.
const RETIRED: &[&str] = &["ggml-large-v3-turbo-q8_0.bin"];

struct LocalSpeech {
  root: PathBuf,
  enabled: AtomicBool,
  /// The model being downloaded or loaded, and the flag that stops it.
  preparing: Mutex<Option<(settings::Model, Arc<AtomicBool>)>>,
  /// The model the engine holds.
  loaded: Mutex<Option<settings::Model>>,
  /// Held while a model loads, so quitting waits for it instead of exiting while it holds GPU buffers.
  loading: Mutex<()>,
  /// What Settings shows of the newest download or load: under way, or the error that stopped it.
  step: Mutex<Option<Step>>,
  /// The model, language and translation Settings last asked for, so only a change of them acts.
  seen: Mutex<Option<(settings::Model, String, bool)>>,
  job: Mutex<Option<(String, Arc<AtomicBool>)>>,
  engine: Mutex<Option<Engine>>,
  /// Speech detection, apart from the engine so a release can see what was said while a live pass runs.
  vad: Mutex<Option<WhisperVadContext>>,
  /// The live pass in flight while the key is held.
  draft: Mutex<Option<Draft>>,
  hold: Mutex<Hold>,
  note: Mutex<note::Note>,
  /// Releases waiting for the engine. A meeting piece running meanwhile gives it up for them.
  releases: AtomicUsize,
  /// Where a hold's audio waits until its words are out, beside the models' folder.
  unsent: PathBuf,
}
struct Draft { id: String, samples: usize, cancelled: Arc<AtomicBool> }
/// What the passes of the newest hold found out, for the passes after them. `spoken` is the language
/// of its newest pass, sure or not, for the text pipeline.
#[derive(Default)]
struct Hold { id: String, language: Option<i32>, spoken: Option<i32>, heard: Option<(usize, String)>, live: Live }
/// What the live passes of a hold cost, for the log: how many ran, how long they took, the slowest.
#[derive(Default, Clone, Copy)]
struct Live { passes: usize, total_ms: u128, slowest_ms: u128 }
/// Speech that ends this long before a live pass's audio does is all in that pass's words.
const SETTLED: usize = 16000 * 3 / 10;
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Where the speech models live, once the app is up: for other models that belong beside them.
pub(crate) fn models_root() -> Option<PathBuf> { APP.get().map(|app| app.state::<LocalSpeech>().root.clone()) }
/// A hold with nothing to send (silence, too short, unclear): the overlay ends it quietly.
const UNHEARD: &str = "unheard";
/// Whisper reads at most 224 tokens of prompt; the vocabulary stays under this.
const PROMPT_TOKENS: usize = 200;
const CANCELLED: &str = "Speech model setup was cancelled.";
/// A pass that panicked: dictation carries on, and this hold says so.
const PANICKED: &str = "Couldn’t transcribe that. Try again.";
/// Recovery runs once a launch, as the first model is ready.
static RECOVERED: AtomicBool = AtomicBool::new(false);

/// The mutexes here outlive a pass that panicked holding one: what they guard is still the best there is.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> { mutex.lock().unwrap_or_else(|e| e.into_inner()) }

/// The mutex when it is free, poisoned or not; None while something holds it.
fn try_lock<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
  match mutex.try_lock() { Ok(guard) => Some(guard), Err(TryLockError::Poisoned(e)) => Some(e.into_inner()), Err(TryLockError::WouldBlock) => None }
}

extern "C" {
  fn dictate_model_status(message: *const c_char, status: i32);
  fn dictate_result(request: *const c_char, text: *const c_char, error: *const c_char);
  fn dictate_result_sends(request: *const c_char, send: bool);
  fn dictate_draft_result(request: *const c_char, text: *const c_char);
  fn dictate_learn_watch(text: *const c_char);
  fn dictate_learn_stop();
  /// Bytes free on the volume that holds `path`, counting what macOS would clear to make room; -1 when it can't tell.
  fn dictate_meeting_free_space(path: *const c_char) -> i64;
}

impl LocalSpeech {
  fn new(root: PathBuf) -> Self {
    Self {
      unsent: root.with_file_name("unsent"),
      root, enabled: AtomicBool::new(false), preparing: Mutex::default(), loaded: Mutex::default(), loading: Mutex::default(), step: Mutex::default(), seen: Mutex::default(),
      job: Mutex::default(), engine: Mutex::default(), vad: Mutex::default(), draft: Mutex::default(), hold: Mutex::default(), note: Mutex::default(),
      releases: AtomicUsize::new(0),
    }
  }
}

/// What a pass has claimed, given back when it ends however it ends, a panic included: a claim never given
/// back would turn every hold after it away until the app was quit. `job` is the flag of the job it runs,
/// `draft` the live pass slot, `step` the note whose step it is, `unsent` its audio kept on disk.
struct Claim<'a> { state: &'a LocalSpeech, job: Option<Arc<AtomicBool>>, draft: bool, step: Option<String>, unsent: Option<PathBuf> }
impl<'a> Claim<'a> {
  fn new(state: &'a LocalSpeech) -> Self { Self { state, job: None, draft: false, step: None, unsent: None } }

  /// Gives the job back now, so the next hold can start while this one's words are polished. A newer
  /// job in its place is left alone.
  fn end_job(&mut self) {
    let Some(flag) = self.job.take() else { return };
    let mut job = lock(&self.state.job);
    if job.as_ref().is_some_and(|(_, held)| Arc::ptr_eq(held, &flag)) { job.take(); }
  }
}
impl Drop for Claim<'_> {
  fn drop(&mut self) {
    self.end_job();
    if self.draft { lock(&self.state.draft).take(); }
    if let Some(id) = &self.step { let _ = self.state.same_note(id, |note| note.busy = false); }
    if let Some(path) = &self.unsent { let _ = fs::remove_file(path); }
  }
}

pub fn init(app: &AppHandle) -> Result<(), String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("voice-models");
  app.manage(LocalSpeech::new(root));
  APP.get_or_init(|| app.clone());
  // A new model is fetched and swapped in as soon as it is chosen; a new language changes what the
  // overlay says. Anything else in Settings is read by each pass as it runs.
  app.listen_any("dictate-settings", |event| {
    let (Some(app), Ok(settings)) = (APP.get(), serde_json::from_str::<settings::Settings>(event.payload())) else { return };
    let dictation = settings.dictation;
    let choice = (dictation.model, dictation.language, dictation.translate_to_english);
    let state = app.state::<LocalSpeech>();
    if lock(&state.seen).replace(choice.clone()).as_ref() == Some(&choice) { return; }
    if state.enabled.load(Ordering::Relaxed) { prepare(app); }
  });
  Ok(())
}

pub(crate) fn app() -> Option<&'static AppHandle> { APP.get() }

fn status(app: &AppHandle, message: &str, code: i32) {
  let text = CString::new(message.replace('\0', "")).unwrap_or_default();
  let _ = app.run_on_main_thread(move || unsafe { dictate_model_status(text.as_ptr(), code); });
}

fn verify_model(path: &Path, model: &Model) -> Result<(), String> {
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
fn stamp(path: &Path, model: &Model) -> Option<String> {
  use std::os::unix::fs::MetadataExt;
  let meta = fs::metadata(path).ok()?;
  Some(format!("{} {}.{:09} {} {}", meta.len(), meta.mtime(), meta.mtime_nsec(), meta.ino(), model.sha256))
}

/// Remembers, beside it, that the file at `path` passed its check.
fn passed(path: &Path, model: &Model) {
  if let Some(stamp) = stamp(path, model) { let _ = fs::write(path.with_extension("verified"), stamp); }
}

/// verify_model, hashing only a file that changed since it last passed: the 874 MB model would otherwise
/// cost seconds of hashing at every launch.
fn verified(path: &Path, model: &Model) -> Result<(), String> {
  if stamp(path, model).is_some_and(|stamp| fs::read_to_string(path.with_extension("verified")).is_ok_and(|kept| kept == stamp)) { return Ok(()); }
  verify_model(path, model)?;
  passed(path, model);
  Ok(())
}

fn download_client() -> Result<reqwest::Client, String> {
  if rustls::crypto::CryptoProvider::get_default().is_none() { let _ = rustls::crypto::ring::default_provider().install_default(); }
  // No deadline on the whole download, which a slow connection can't meet: each read gets 30 s instead.
  reqwest::Client::builder().https_only(true).referer(false)
    .connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(30))
    .redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|e| e.to_string())
}

fn free_space(dir: &Path) -> Option<u64> {
  let path = CString::new(dir.as_os_str().as_encoded_bytes()).ok()?;
  u64::try_from(unsafe { dictate_meeting_free_space(path.as_ptr()) }).ok()
}

/// How many bytes short `free` is of downloading `bytes` with a fifth again to spare, so the Mac isn't
/// left full. Space that can't be told doesn't stop a download.
fn short_of_space(free: Option<u64>, bytes: u64) -> Option<u64> {
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
async fn download(client: &reqwest::Client, model: &Model, partial: &Path, cancel: &AtomicBool, report: &(impl Fn(&str, Option<u8>) + Sync)) -> Result<(), Stop> {
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
/// check or setup is cancelled (prepare).
pub(crate) async fn fetch(root: &Path, models: &'static [Model], cancel: &AtomicBool, report: &(impl Fn(&str, Option<u8>) + Sync)) -> Result<(), String> {
  for model in models {
    if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
    let path = root.join(model.name);
    let dir = path.parent().unwrap_or(root);
    fs::create_dir_all(dir).map_err(|e| format!("Couldn’t make a folder for the speech model: {e}"))?;
    let check = path.clone();
    if tauri::async_runtime::spawn_blocking(move || verified(&check, model)).await.map_err(|e| e.to_string())?.is_ok() { continue; }
    let partial = path.with_extension("part");
    let left = fs::metadata(&partial).ok().and_then(|meta| model.bytes.checked_sub(meta.len())).unwrap_or(model.bytes);
    if let Some(short) = short_of_space(free_space(dir), left) {
      return Err(format!("There isn’t enough space to download {}. Free up {:.1} GB and try again.", model.label, (short as f64 / 1e8).ceil() / 10.0));
    }
    let client = download_client()?;
    let mut tries = 0;
    loop {
      let before = fs::metadata(&partial).map_or(0, |meta| meta.len());
      match download(&client, model, &partial, cancel, report).await {
        Ok(()) => break,
        Err(Stop::Fail(error)) => return Err(error),
        Err(Stop::Retry(error)) => {
          // Three tries in a row that get nowhere; one that got further starts the count again.
          if fs::metadata(&partial).is_ok_and(|meta| meta.len() > before) { tries = 0; }
          let Some(wait) = backoff(tries) else { return Err(error) };
          tries += 1;
          tokio::time::sleep(wait).await;
        }
      }
    }
    report("Checking the download…", None);
    let check = partial.clone();
    if let Err(error) = tauri::async_runtime::spawn_blocking(move || verify_model(&check, model)).await.map_err(|e| e.to_string())? {
      let _ = fs::remove_file(&partial); // what it holds is wrong somewhere, so it starts again
      return Err(error);
    }
    if cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
    fs::rename(&partial, &path).map_err(|e| format!("Couldn’t install the speech model: {e}"))?;
    passed(&path, model);
  }
  Ok(())
}

pub(crate) async fn wait_cancelled(cancel: &AtomicBool) {
  while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(100)).await; }
}

pub(crate) async fn cancellable<T>(cancel: &AtomicBool, work: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
  tokio::select! {
    result = work => result,
    _ = wait_cancelled(cancel) => Err(CANCELLED.into()),
  }
}

#[no_mangle]
extern "C" fn dictate_prepare_models() {
  let Some(app) = APP.get() else {
    unsafe { dictate_model_status(c"Couldn’t set up the speech model. Quit Dictate and open it again.".as_ptr(), -1); }
    return;
  };
  app.state::<LocalSpeech>().enabled.store(true, Ordering::Relaxed);
  prepare(app);
}

/// Brings the engine to the model chosen in Settings: downloads what is missing, loads it and swaps it
/// in. A model in use keeps answering until the new one is ready, so its progress goes only to
/// Settings; with none in use, the overlay hears it too, since dictation is waiting for it.
fn prepare(app: &AppHandle) {
  let state = app.state::<LocalSpeech>();
  let chosen = settings::get().dictation.model;
  let want = first_load(&state.root, chosen, lock(&state.loaded).is_some());
  let cancel = {
    let mut preparing = lock(&state.preparing);
    if let Some((model, cancel)) = preparing.as_ref() {
      if *model != want { cancel.store(true, Ordering::Relaxed); } // it prepares again as it stops, for the new choice
      return;
    }
    if *lock(&state.loaded) == Some(want) {
      drop(preparing);
      step(app, None);
      status(app, &ready(&state), 1);
      return;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *preparing = Some((want, cancel.clone()));
    cancel
  };
  let app = app.clone();
  let root = state.root.clone();
  tauri::async_runtime::spawn(async move {
    let state = app.state::<LocalSpeech>();
    let swapping = lock(&state.loaded).is_some();
    let label = files(want)[0].label;
    let report = |message: &str, percent: Option<u8>| {
      step(&app, Some(Step { model: want, message: message.into(), percent, failed: false }));
      if !swapping { status(&app, message, 0); }
    };
    report(&format!("Getting {label} ready…"), None);
    let result = cancellable(&cancel, fetch(&root, files(want), &cancel, &report)).await;
    let cancelled = || cancel.load(Ordering::Relaxed);
    if cancelled() {
      for model in files(want) { let _ = std::fs::remove_file(root.join(model.name).with_extension("part")); }
    }
    let result = match result {
      Ok(()) if !cancelled() => {
        for name in RETIRED { let _ = std::fs::remove_file(root.join(name)); }
        report(&format!("Loading {label}…"), None);
        let (loading, stop) = (app.clone(), cancel.clone());
        tauri::async_runtime::spawn_blocking(move || load(&loading, &root, want, &stop)).await
          .unwrap_or_else(|_| Err("Couldn’t load the speech model.".into()))
      }
      Ok(()) => Err(CANCELLED.into()),
      error => error,
    };
    lock(&state.preparing).take();
    if !state.enabled.load(Ordering::Relaxed) { step(&app, None); return; }
    if cancelled() { prepare(&app); return; } // the choice changed, or voice went off and on again
    match result {
      Ok(()) => {
        step(&app, None);
        status(&app, &ready(&state), 1);
        if !RECOVERED.swap(true, Ordering::SeqCst) {
          let app = app.clone();
          tauri::async_runtime::spawn_blocking(move || app.state::<LocalSpeech>().recover());
        }
        if want != chosen { prepare(&app); } // dictation works now; the chosen model comes as a swap
      }
      Err(error) => {
        step(&app, Some(Step { model: want, message: error.clone(), percent: None, failed: true }));
        if !swapping { status(&app, &error, -1); }
      }
    }
  });
}

/// What to load for `chosen`. With no model loaded yet, a chosen one still missing from this Mac (its
/// download failed, or the app quit during it) waits behind the other one when that is here, so
/// dictation works meanwhile.
fn first_load(root: &Path, chosen: settings::Model, loaded: bool) -> settings::Model {
  let here = |model| files(model).iter().all(|file| std::fs::metadata(root.join(file.name)).is_ok_and(|meta| meta.len() == file.bytes));
  let other = match chosen { settings::Model::Turbo => settings::Model::Small, settings::Model::Small => settings::Model::Turbo };
  if !loaded && !here(chosen) && here(other) { other } else { chosen }
}

/// Loads `model` beside the engine in use, then swaps it in.
fn load(app: &AppHandle, root: &Path, model: settings::Model, cancel: &AtomicBool) -> Result<(), String> {
  let state = app.state::<LocalSpeech>();
  // Declared first, so the new model is dropped before it is let go.
  let _loading = state.loading.lock().unwrap_or_else(|e| e.into_inner());
  if !state.enabled.load(Ordering::Relaxed) { return Err("Dictation is paused.".into()); }
  let whisper = Engine::load(root, model)?;
  let vad = if lock(&state.vad).is_none() { Some(load_vad(root)?) } else { None };
  // Waits for a pass in flight: the old model goes only once nothing is using it.
  let mut engine = lock(&state.engine);
  if !state.enabled.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) { return Err(CANCELLED.into()); }
  if let Some(vad) = vad { *lock(&state.vad) = Some(vad); }
  *engine = Some(whisper);
  *lock(&state.loaded) = Some(model);
  Ok(())
}

/// What the overlay says once the model is ready.
fn ready(state: &LocalSpeech) -> String {
  let dictation = settings::get().dictation;
  let model = lock(&state.loaded).map_or("Whisper", |model| files(model)[0].label);
  let language = if dictation.translate_to_english { "translating to English".to_owned() } else {
    pinned(&dictation.language).and_then(whisper_rs::get_lang_str_full).map_or_else(|| "any language".to_owned(), |name| {
      let mut chars = name.chars();
      chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
    })
  };
  format!("{model} · {language}")
}

/// A download or load under way, or the one that failed, as Settings shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Step { model: settings::Model, message: String, percent: Option<u8>, failed: bool }

/// The speech models as Settings shows them: the one in use, each one's size and whether it is on
/// this Mac, and the newest download or load.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Models { active: Option<settings::Model>, enabled: bool, step: Option<Step>, models: Vec<Stored> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored { model: settings::Model, bytes: u64, downloaded: bool }

fn models(state: &LocalSpeech) -> Models {
  let stored = |model| {
    let file = &files(model)[0];
    Stored { model, bytes: file.bytes, downloaded: std::fs::metadata(state.root.join(file.name)).is_ok_and(|meta| meta.len() == file.bytes) }
  };
  Models {
    active: *lock(&state.loaded), enabled: state.enabled.load(Ordering::Relaxed), step: lock(&state.step).clone(),
    models: vec![stored(settings::Model::Turbo), stored(settings::Model::Small)],
  }
}

fn step(app: &AppHandle, step: Option<Step>) {
  let state = app.state::<LocalSpeech>();
  *lock(&state.step) = step;
  let _ = app.emit("dictate-model", models(&state));
}

#[tauri::command]
pub fn speech_models(app: AppHandle) -> Models { models(&app.state()) }

/// The chosen model again, after a download or load that failed.
#[tauri::command]
pub fn prepare_model(app: AppHandle) -> Result<(), String> {
  if !app.state::<LocalSpeech>().enabled.load(Ordering::Relaxed) { return Err("Turn dictation on first.".into()); }
  prepare(&app);
  Ok(())
}

#[no_mangle]
extern "C" fn dictate_disable_models() {
  let Some(app) = APP.get() else { return };
  let state = app.state::<LocalSpeech>();
  state.enabled.store(false, Ordering::Relaxed);
  if let Some((_, cancel)) = lock(&state.preparing).as_ref() { cancel.store(true, Ordering::Relaxed); }
  if let Some((_, cancel)) = lock(&state.job).as_ref() { cancel.store(true, Ordering::Relaxed); }
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let mut engine = lock(&state.engine);
    if !state.enabled.load(Ordering::Relaxed) { engine.take(); lock(&state.vad).take(); lock(&state.loaded).take(); }
    drop(engine);
    let _ = app.emit("dictate-model", models(&state));
  });
}

/// Frees the model before the process exits: the speech library's Metal device is a C++ static whose
/// destructor aborts while a loaded model still holds GPU buffers, and managed state is never dropped.
pub fn shutdown(app: &AppHandle) {
  let Some(state) = app.try_state::<LocalSpeech>() else { return };
  state.enabled.store(false, Ordering::Relaxed); // a load that hasn't started yet gives up
  if let Some((_, cancel)) = state.preparing.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { cancel.store(true, Ordering::Relaxed); }
  if let Some((_, cancel)) = state.job.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { cancel.store(true, Ordering::Relaxed); }
  if let Some(draft) = state.draft.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { draft.cancelled.store(true, Ordering::Relaxed); }
  // A load under way finishes and frees its model first; one after this sees voice is off.
  drop(state.loading.lock().unwrap_or_else(|e| e.into_inner()));
  state.engine.lock().unwrap_or_else(|e| e.into_inner()).take();
  state.vad.lock().unwrap_or_else(|e| e.into_inner()).take();
  state.loaded.lock().unwrap_or_else(|e| e.into_inner()).take();
}

pub fn cancel(app: &AppHandle, id: &str) {
  let Some(state) = app.try_state::<LocalSpeech>() else { return };
  if let Some((known, cancel)) = lock(&state.job).as_ref() {
    if known == id { cancel.store(true, Ordering::Relaxed); }
  };
  // A release may be waiting on this hold's live pass rather than running its own.
  if let Some(draft) = lock(&state.draft).as_ref() {
    if draft.id == id { draft.cancelled.store(true, Ordering::Relaxed); }
  };
  state.forget_note(id);
}

/// Audio worth a pass: long enough, finite, not silent, and no longer than the longest hold.
fn validate_audio(pcm: &[f32]) -> Result<(), String> {
  if pcm.len() < 4000 || pcm.len() > HANDS_FREE_SAMPLES || pcm.iter().any(|sample| !sample.is_finite()) {
    return Err(UNHEARD.into());
  }
  let energy = pcm.iter().map(|sample| (*sample as f64).powi(2)).sum::<f64>() / pcm.len() as f64;
  if energy < 1e-7 { return Err(UNHEARD.into()); }
  Ok(())
}

fn hands_free(id: &str) -> bool { context::get(id).mode == context::Mode::HandsFree }

/// Whether a hold of `samples` is heard piece by piece, like a note: a hands-free session, or any hold
/// that has run past one piece, whose pieces then go into its words while the key is still held.
fn pieced(id: &str, samples: usize) -> bool { samples > note::PIECE || hands_free(id) }

/// The most audio a hold may send: five minutes, or ten for a hands-free session.
fn max_samples(id: &str) -> usize { if hands_free(id) { HANDS_FREE_SAMPLES } else { MAX_SAMPLES } }

/// `piece` is set for a meeting piece, which also stops for Pause, Quit and a waiting release.
struct Abort { cancelled: Arc<AtomicBool>, started: Instant, piece: Option<&'static LocalSpeech> }
unsafe extern "C" fn should_abort(data: *mut c_void) -> bool {
  let abort = &*(data as *const Abort);
  abort.cancelled.load(Ordering::Relaxed) || abort.started.elapsed() >= Duration::from_secs(120) || abort.piece.is_some_and(LocalSpeech::piece_yields)
}

unsafe extern "C" fn stop_before_encoding(_: *mut WhisperSysContext, _: *mut WhisperSysState, _: *mut c_void) -> bool { false }

fn threads() -> usize { std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) }

/// How much of Whisper's 30 s window the encoder looks at: the audio (20 ms a position) plus the 128
/// positions of room the fine-tuned model was evaluated with. A short command encodes several times faster.
fn audio_ctx(samples: usize) -> i32 { (samples.div_ceil(320) + 128).min(1500) as i32 }

/// The encoder's audio context for `samples` on `model`. Only the fine-tuned Turbo keeps its accuracy on
/// less than the whole window; Small, cheap to encode anyway, always sees all of it (0).
fn encoder_ctx(model: settings::Model, samples: usize) -> i32 { if model == settings::Model::Turbo { audio_ctx(samples) } else { 0 } }

/// A language Settings pins, by Whisper's id; None for `auto`.
fn pinned(code: &str) -> Option<i32> { if code == "auto" { None } else { whisper_rs::get_lang_id(code) } }

/// What Settings asks of every pass: a pinned language (None detects it), translation to English, and
/// the words Whisper should spell right, newest first.
#[derive(Clone, Debug, Default)]
struct Ask { language: Option<i32>, translate: bool, words: Vec<String> }
impl Ask {
  fn now() -> Self {
    let settings = settings::get();
    Self { language: pinned(&settings.dictation.language), translate: settings.dictation.translate_to_english, words: settings.vocabulary.words }
  }
}

/// Whether `text` is Whisper reciting the vocabulary it was prompted with rather than what was said, as it can
/// over near-silence (OpenWhispr dictionaryEchoFilter.js): nine in ten of its words or more are vocabulary,
/// and it is shaped like the list: one word over and over, a short run ending in a comma, or three or more
/// entries in the list's own order. A sentence that merely uses a few vocabulary words is none of these.
fn echoes_prompt(text: &str, words: &[String]) -> bool {
  let bare = |word: &str| word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
  let entries: Vec<String> = words.iter().map(|word| word.trim().to_lowercase()).filter(|word| !word.is_empty()).collect();
  let known: std::collections::HashSet<String> = entries.iter().flat_map(|entry| entry.split_whitespace().map(bare).collect::<Vec<_>>()).filter(|word| !word.is_empty()).collect();
  let said: Vec<String> = text.split_whitespace().map(bare).filter(|word| !word.is_empty()).collect();
  let unique: std::collections::HashSet<&String> = said.iter().collect();
  if unique.is_empty() || (unique.iter().filter(|word| known.contains(**word)).count() * 10) < unique.len() * 9 { return false; }
  let repeated = unique.iter().any(|word| said.iter().filter(|other| other == word).count() >= 3);
  let fragment = text.trim().ends_with(',') && text.trim().chars().count() <= 30;
  let lower = text.to_lowercase();
  let (mut from, mut in_order) = (0, 0);
  for entry in &entries { if let Some(at) = lower[from..].find(entry.as_str()) { in_order += 1; from += at + entry.len(); } }
  repeated || fragment || in_order >= 3
}

/// Lowercase words with their punctuation gone, one space apart, as OpenWhispr compares them.
fn normalize(text: &str) -> String {
  let kept: String = text.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect();
  kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether `text` is the vocabulary Whisper was given recited back, whole or nearly (OpenWhispr
/// matchesDictionaryPrompt): nine in ten of its words are vocabulary, and it uses seven in ten of the vocabulary.
fn recites_prompt(text: &str, words: &[String]) -> bool {
  let (said, prompt) = (normalize(text), normalize(&words.join(" ")));
  if said.is_empty() || prompt.is_empty() { return false; }
  if said == prompt { return true; }
  let known: std::collections::HashSet<&str> = prompt.split(' ').collect();
  let unique: std::collections::HashSet<&str> = said.split(' ').collect();
  let matched = unique.iter().filter(|word| known.contains(*word)).count();
  matched * 10 >= unique.len() * 9 && matched * 10 >= known.len() * 7
}

/// Audio past which a fragment of the prompt may be what Whisper made of more than it heard.
const SPARSE: usize = 3 * 16_000;

/// A decode that may be Whisper reciting its prompt, with what its retry without the prompt is judged
/// against (OpenWhispr audioManager.js): `strict` when it recites the whole vocabulary, otherwise it is a
/// fragment shaped like it; `repeated` when a word comes twice, `unique` the different words in it.
#[derive(Debug, PartialEq)]
struct Echo { strict: bool, repeated: bool, unique: usize }
impl Echo {
  /// `text` heard over `samples`, when it is worth a retry: a strict echo always, a fragment only when a
  /// retry could replace it, so with a word said twice or over 3 s of audio or more.
  fn of(text: &str, words: &[String], samples: usize) -> Option<Self> {
    let said = normalize(text);
    let all: Vec<&str> = said.split_whitespace().collect();
    let unique = all.iter().collect::<std::collections::HashSet<_>>().len();
    let echo = Self { strict: recites_prompt(text, words), repeated: all.len() > unique, unique };
    (echo.strict || (echoes_prompt(text, words) && (echo.repeated || samples >= SPARSE))).then_some(echo)
  }

  /// Whether the retry is what was said: it doesn't recite the vocabulary, and in place of a fragment it
  /// isn't one either and hears more: a word more than a fragment that repeated one, or two more over 3 s.
  fn keeps(&self, retry: &str, words: &[String], samples: usize) -> bool {
    let unique = normalize(retry).split_whitespace().collect::<std::collections::HashSet<_>>().len();
    if unique == 0 || recites_prompt(retry, words) { return false; }
    self.strict || (!echoes_prompt(retry, words) && ((self.repeated && unique > self.unique) || (samples >= SPARSE && unique >= self.unique + 2)))
  }
}

/// A period that doesn't end a sentence: after an abbreviation, an initial, a list number or another period.
fn no_full_stop(before: &str) -> bool {
  const SHORT: &[&str] = &["etc", "vs", "mr", "mrs", "ms", "dr", "st", "jr", "sr", "sra", "prof", "incl", "esp", "approx", "ca", "cf", "al", "no", "nr", "ex", "ej", "vgl", "bzw", "usw"];
  let word = before.rsplit(|c: char| c.is_whitespace() || c == '(').next().unwrap_or_default().to_lowercase();
  let mut last = before.chars().rev();
  let dotted = matches!((last.next(), last.next(), last.next()), (Some(a), Some('.'), Some(b)) if a.is_alphabetic() && b.is_alphabetic());
  before.ends_with('.') || dotted || SHORT.contains(&word.as_str())
    || (word.chars().count() == 1 && word.chars().all(char::is_alphabetic)) || ((1..=2).contains(&word.len()) && word.bytes().all(|b| b.is_ascii_digit()))
}

/// `text` without the vocabulary Whisper recited after what was said (OpenWhispr stripTrailingDictionaryEcho):
/// its last sentence, when that is two or more entries in the prompt's own order from its first. A
/// sentence of real speech hardly ever is. Ours is the newest words and always fits whole, so a recital
/// opens it; OpenWhispr also strips one that closes a prompt Whisper had cut, which ours never is.
fn without_recital<'a>(text: &'a str, words: &[String]) -> &'a str {
  let entries: Vec<String> = words.iter().map(|word| normalize(word)).filter(|word| !word.is_empty()).collect();
  if entries.len() < 2 { return text; }
  let body = text.trim_end();
  let mut tail = None;
  let mut chars = body.char_indices().peekable();
  while let Some((at, c)) = chars.next() {
    let wide = matches!(c, '。' | '！' | '？');
    if !wide && !matches!(c, '.' | '!' | '?') { continue; }
    let mut end = at + c.len_utf8();
    while let Some(&(next, space)) = chars.peek().filter(|(_, space)| space.is_whitespace()) { end = next + space.len_utf8(); chars.next(); }
    // "Node.js" stays a word, and the break must have a sentence after it.
    if (!wide && end == at + 1) || end >= body.len() || (c == '.' && no_full_stop(&body[..at])) { continue; }
    tail = Some(end);
  }
  let Some(start) = tail else { return text };
  let said: Option<Vec<usize>> = body[start..].split([',', '、', '，']).map(normalize).filter(|term| !term.is_empty())
    .map(|term| entries.iter().position(|entry| *entry == term)).collect();
  match said {
    Some(run) if run.len() >= 2 && run[0] == 0 && run.windows(2).all(|pair| pair[1] == pair[0] + 1) => body[..start].trim_end(),
    _ => text,
  }
}

/// Too quiet to hold a word: even its loudest tenth of a second is below the level of a breath (OpenWhispr
/// localSpeechGate.js, its first rule). Whisper is never asked there, where it would make words up.
fn silent_audio(pcm: &[f32]) -> bool {
  pcm.chunks(1_600).map(|window| (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt()).fold(0.0, f32::max) < 0.002
}

/// The loudest sample and the loudest tenth of a second (RMS) of `pcm`: what the gates below judge, for the log.
fn levels(pcm: &[f32]) -> (f32, f32) {
  let peak = pcm.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
  let rms = pcm.chunks(1_600).map(|window| (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt()).fold(0.0, f32::max);
  (peak, rms)
}

/// Loud enough somewhere to be a voice (OpenWhispr localSpeechGate.js, its speech rule): a tenth of a second
/// at the level of a word, RMS 0.003 with a peak of 0.02, or plainly above it at RMS 0.006.
fn voiced(pcm: &[f32]) -> bool {
  pcm.chunks(1_600).any(|window| {
    let rms = (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt();
    let peak = window.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
    rms >= 0.006 || (rms >= 0.003 && peak >= 0.02)
  })
}

/// The vocabulary words Whisper can be given, newest first.
fn entries(words: &[String]) -> impl Iterator<Item = &str> {
  words.iter().map(|word| word.trim()).filter(|word| !word.is_empty() && !word.contains('\0'))
}

/// The vocabulary as Whisper's prompt, and how many words it holds: a comma list, newest first, with as
/// many words as `fits`. It starts with a space, as the words would inside heard text.
fn prompt_text(words: &[String], fits: impl Fn(&str) -> bool) -> (String, usize) {
  let (mut text, mut count) = (String::new(), 0);
  for word in entries(words) {
    let next = if text.is_empty() { format!(" {word}") } else { format!("{text}, {word}") };
    if !fits(&next) { break; }
    (text, count) = (next, count + 1);
  }
  (text, count)
}

/// How many of `words`, newest first, Whisper is given. Counted with Whisper's own tokens when the
/// model is loaded and free, otherwise a token for every three bytes, which errs on the side of fewer.
#[tauri::command]
pub fn vocabulary_fit(app: AppHandle, words: Vec<String>) -> usize {
  let state = app.state::<LocalSpeech>();
  let engine = try_lock(&state.engine);
  let whisper = engine.as_ref().and_then(|engine| engine.as_ref());
  let tokens = |text: &str| whisper.map_or_else(|| text.len().div_ceil(3), |whisper| whisper.tokens(text).len());
  prompt_text(&words, |text| tokens(text) < PROMPT_TOKENS).1
}

/// The language a hold's words are in, as Whisper's code: English when translating, the language
/// Settings pins, or the one the hold's newest pass heard.
pub fn language(request: &str) -> Option<String> {
  let dictation = settings::get().dictation;
  if dictation.translate_to_english { return Some("en".into()); }
  if let Some(id) = pinned(&dictation.language) { return whisper_rs::get_lang_str(id).map(Into::into); }
  let state = APP.get()?.try_state::<LocalSpeech>()?;
  let hold = state.hold.lock().unwrap_or_else(|e| e.into_inner());
  (hold.id == request).then_some(hold.spoken).flatten().and_then(whisper_rs::get_lang_str).map(Into::into)
}

fn load_vad(root: &Path) -> Result<WhisperVadContext, String> {
  WhisperVadContext::new(root.join(SILERO.name).to_str().ok_or("Invalid speech model path.")?, WhisperVadContextParams::default())
    .map_err(|_| "Couldn’t load speech detection. Try again.".into())
}

/// Whisper, its state and the vocabulary it was last given. Every pass reuses the one state: whisper.cpp
/// clears its results, spectrogram and prompt at the start of each full() (no_context is on for all of
/// ours), and the engine's mutex keeps passes from sharing it. A new state each pass cost its GPU buffers.
struct Engine { whisper: WhisperContext, state: WhisperState, model: settings::Model, prompt: Prompt }

/// The vocabulary as Whisper was last given it: the words, those of them that fit in its prompt, and the
/// prompt's tokens.
#[derive(Default)]
struct Prompt { words: Vec<String>, sent: Vec<String>, tokens: Vec<i32> }

/// What none of our passes prints.
fn quiet(params: &mut FullParams) {
  params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
}

/// Whisper's own test for a window nobody spoke in (openai/whisper transcribe.py, whisper.cpp, WhisperKit):
/// the no-speech token likely *and* the words found unsure. A likely no-speech token alone is not silence:
/// clear words after a pause score high on it too, and dropping them is "Didn't catch that" for nothing.
fn silent(no_speech: f32, avg_logprob: f32) -> bool { no_speech > 0.6 && avg_logprob < -1.0 }

/// The mean log probability of a segment's words, special tokens left out (they sort from end-of-text up).
fn avg_logprob(segment: &whisper_rs::WhisperSegment<'_>, eot: i32) -> f32 {
  let logs: Vec<f32> = (0..segment.n_tokens()).filter_map(|i| segment.get_token(i)).filter(|token| token.token_id() < eot).map(|token| token.token_data().plog).collect();
  if logs.is_empty() { f32::NEG_INFINITY } else { logs.iter().sum::<f32>() / logs.len() as f32 }
}
impl Engine {
  fn load(root: &Path, model: settings::Model) -> Result<Self, String> {
    // Native debug logs can contain recognized tokens; keep speech out of app logs.
    whisper_rs::install_logging_hooks();
    let path = root.join(files(model)[0].name);
    let path = path.to_str().ok_or("Voice model path is not valid Unicode.")?;
    let mut parameters = WhisperContextParameters::default();
    parameters.use_gpu(true).flash_attn(true);
    let whisper = WhisperContext::new_with_params(path, parameters).or_else(|_| {
      let mut cpu = WhisperContextParameters::default(); cpu.use_gpu(false);
      WhisperContext::new_with_params(path, cpu)
    }).map_err(|_| "Couldn’t load the speech model. Quit an app or two to free up memory, then try again.")?;
    let state = whisper.create_state().map_err(|_| "There isn’t enough free memory. Quit an app or two and try again.")?;
    let mut engine = Self { whisper, state, model, prompt: Prompt::default() };
    engine.warm_up();
    Ok(engine)
  }

  /// A throw-away pass over a second of silence, with the final pass's beams, so the first dictation
  /// doesn't wait while Metal sets up what a pass needs.
  fn warm_up(&mut self) {
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_n_threads(threads() as i32);
    params.set_language(Some("en"));
    params.set_audio_ctx(self.audio_ctx(16_000));
    params.set_temperature_inc(0.0); // once, never again warmer
    params.set_max_tokens(16); // a few steps of the decoder are enough, however it hears silence
    quiet(&mut params);
    let _ = self.state.full(params, &vec![0.0; 16_000]);
  }

  fn audio_ctx(&self, samples: usize) -> i32 { encoder_ctx(self.model, samples) }

  fn tokens(&self, text: &str) -> Vec<i32> {
    // A token is at least a byte, so this room is always enough; too little would be undefined.
    self.whisper.tokenize(text, text.len() + 8).unwrap_or_default()
  }

  /// Tokenizes `words` as the prompt, once for each change of them.
  fn use_words(&mut self, words: &[String]) {
    if self.prompt.words == words { return; }
    let (text, count) = prompt_text(words, |text| self.tokens(text).len() < PROMPT_TOKENS);
    let tokens = if text.is_empty() { Vec::new() } else { self.tokens(&text) };
    self.prompt = Prompt { words: words.to_vec(), sent: entries(words).take(count).map(Into::into).collect(), tokens };
  }

  /// The language spoken in `pcm` and how sure Whisper is of it. It runs the encoder, about half the work
  /// of a pass.
  fn detect(&mut self, pcm: &[f32]) -> Result<(i32, f32), String> {
    // whisper.cpp takes a shorter audio context only from full(), and only after its own language
    // detection. A pass stopped before its encoder leaves the spectrogram and that context in place, so
    // detecting here encodes just the speech rather than all 30 s.
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(threads() as i32);
    params.set_language(Some("en"));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    quiet(&mut params);
    unsafe { params.set_start_encoder_callback(Some(stop_before_encoding)); }
    self.state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    let (language, sure) = self.state.lang_detect(0, threads()).map_err(|_| "Couldn’t understand that")?;
    Ok((language, sure.get(language as usize).copied().unwrap_or(0.0)))
  }

  /// `quick` is the live pass's greedy decoding; the final pass searches five beams, which costs about
  /// the same because the encoder dominates.
  fn run(&mut self, pcm: &[f32], language: i32, ask: &Ask, cancelled: Arc<AtomicBool>, quick: bool) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    self.use_words(&ask.words);
    let text = self.decode(pcm, language, ask, cancelled.clone(), quick, true)?;
    // Over near-silence a prompted Whisper can recite the vocabulary instead of what was said (OpenWhispr
    // #1454): heard again without it, when the retry could be kept.
    let Some(echo) = Echo::of(&text, &self.prompt.sent, pcm.len()).filter(|_| !self.prompt.tokens.is_empty()) else { return Ok(text) };
    if !quick { log::info!("dictation pass: it recited the vocabulary, heard again without it"); }
    match self.decode(pcm, language, ask, cancelled.clone(), quick, false) {
      Ok(again) if echo.keeps(&again, &self.prompt.sent, pcm.len()) => Ok(again),
      _ if cancelled.load(Ordering::Relaxed) => Err("Voice command cancelled.".into()),
      // The whole vocabulary that no retry replaces was never said.
      _ if echo.strict => Err(UNHEARD.into()),
      _ => Ok(text),
    }
  }

  fn decode(&mut self, pcm: &[f32], language: i32, ask: &Ask, cancelled: Arc<AtomicBool>, quick: bool, prompted: bool) -> Result<String, String> {
    let mut params = FullParams::new(if quick { SamplingStrategy::Greedy { best_of: 1 } } else { SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 } });
    params.set_n_threads(threads() as i32);
    params.set_language(whisper_rs::get_lang_str(language));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    params.set_translate(ask.translate);
    params.set_no_context(true);
    // Timestamps stay on, as OpenWhispr keeps them (whisperServer.js, #2150). Without them a decode that
    // ends early, as one can at a pause, moves on a whole 30 s window, so the words after the pause are
    // lost even in a short hold; with them whisper.cpp carries on from the last timestamp.
    params.set_suppress_nst(true);
    // OpenWhispr's thresholds for dictation (whisperServer.js, #1458): a decode this unsure is tried again
    // warmer, which cut made-up endings ("Thank you for watching") from 2.25 % to 0.06 % of its dictations.
    params.set_entropy_thold(2.8);
    params.set_logprob_thold(-1.25);
    if prompted && !self.prompt.tokens.is_empty() { params.set_tokens(&self.prompt.tokens); }
    quiet(&mut params);
    let mut abort = Abort { cancelled: cancelled.clone(), started: Instant::now(), piece: None };
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe { params.set_abort_callback(Some(should_abort)); params.set_abort_callback_user_data((&mut abort as *mut Abort).cast()); }
    self.state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    let mut text = String::new();
    let eot = self.whisper.token_eot();
    for segment in self.state.as_iter() {
      if silent(segment.no_speech_probability(), avg_logprob(&segment, eot)) { continue; } // that window, not the whole hold
      text.push_str(&segment.to_string());
    }
    let text = if prompted { without_recital(&text, &self.prompt.sent) } else { &text }.trim().to_owned();
    if text.is_empty() { return Err(UNHEARD.into()); }
    if text.chars().count() > 8000 { return Err("That was too long to type. Try a shorter one.".into()); }
    Ok(text)
  }

  /// A meeting piece with timestamps. `prompt` replaces the vocabulary when the caller has its own.
  fn segments(&mut self, pcm: &[f32], language: i32, prompt: Option<&str>, ask: &Ask, translate: bool, mut abort: Abort) -> Result<Vec<Segment>, String> {
    let own = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()).map(|prompt| self.tokens(&format!(" {}", prompt.replace('\0', ""))));
    if own.is_none() { self.use_words(&ask.words); }
    let tokens = own.as_deref().unwrap_or(&self.prompt.tokens);
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_n_threads(threads() as i32);
    params.set_language(whisper_rs::get_lang_str(language));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    params.set_translate(translate);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    if !tokens.is_empty() { params.set_tokens(tokens); }
    quiet(&mut params);
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe { params.set_abort_callback(Some(should_abort)); params.set_abort_callback_user_data((&mut abort as *mut Abort).cast()); }
    self.state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    // Timestamps are in hundredths of a second.
    let samples = |at: i64| (at.max(0) as usize * 160).min(pcm.len());
    let eot = self.whisper.token_eot();
    Ok(self.state.as_iter().filter(|segment| !silent(segment.no_speech_probability(), avg_logprob(segment, eot))).filter_map(|segment| {
      let text = segment.to_string().trim().to_owned();
      (!text.is_empty()).then(|| Segment { start: samples(segment.start_timestamp()), end: samples(segment.end_timestamp()), text })
    }).collect())
  }
}

impl LocalSpeech {
  /// A meeting piece stops when voice is off (Pause, Quit) or a release is waiting for the engine.
  fn piece_yields(&self) -> bool { !self.enabled.load(Ordering::Relaxed) || self.releases.load(Ordering::SeqCst) > 0 }

  /// The engine for a release, which a meeting piece running meanwhile gives up.
  fn engine_now(&self) -> MutexGuard<'_, Option<Engine>> {
    self.releases.fetch_add(1, Ordering::SeqCst);
    let engine = self.engine.lock().unwrap_or_else(|e| e.into_inner());
    self.releases.fetch_sub(1, Ordering::SeqCst);
    engine
  }

  fn hold<T>(&self, id: &str, use_it: impl FnOnce(&mut Hold) -> T) -> T {
    let mut hold = lock(&self.hold);
    if hold.id != id { *hold = Hold { id: id.to_owned(), ..Hold::default() }; }
    use_it(&mut hold)
  }

  /// Where the speech in `pcm` ends, in samples. The end is found more keenly than whether there is speech
  /// at all, so a short or quiet last word still counts.
  fn speech_end(&self, pcm: &[f32]) -> Result<usize, String> { self.find_speech_end(pcm, false) }

  /// `speech_end`, saying in the log (`report`) what the gates made of the audio: its levels, the speech
  /// detection's segments and where the speech was found to end. Never the words.
  fn find_speech_end(&self, pcm: &[f32], report: bool) -> Result<usize, String> {
    validate_audio(pcm)?;
    let (peak, rms) = levels(pcm);
    let seconds = |samples: usize| samples as f32 / 16_000.0;
    let say = |what: String| if report { log::info!("dictation gate: {:.1}s, peak {peak:.4}, loudest rms {rms:.4}: {what}", seconds(pcm.len())); };
    if silent_audio(pcm) { say("unheard, too quiet to hold a word (loudest rms under 0.002)".into()); return Err(UNHEARD.into()); }
    let mut vad = lock(&self.vad);
    let vad = vad.as_mut().ok_or("The speech model is still loading.")?;
    vad.detect_speech(pcm).map_err(|_| "Couldn’t understand that")?;
    let speech = vad.segments_from_probabilities(WhisperVadParams::default()).map_err(|_| "Couldn’t understand that")?;
    // Speech detection wants a quarter of a second of speech, which one short word can fall short of, so
    // a level that is plainly a voice counts too.
    let found = speech.num_segments();
    if found == 0 && !voiced(pcm) { say("unheard, no speech detected and not loud enough to count as a voice".into()); return Err(UNHEARD.into()); }
    let mut keen = WhisperVadParams::default();
    keen.set_threshold(0.3); keen.set_min_speech_duration(0);
    let speech = vad.segments_from_probabilities(keen).map_err(|_| "Couldn’t understand that")?;
    // In hundredths of a second; all of it when even the keen pass found no speech.
    let end = speech.get_segment_end_timestamp(speech.num_segments() - 1).map_or(pcm.len(), |end| (end * 160.0) as usize);
    say(format!("{found} speech segment(s), {} keen, speech ends at {:.2}s{}", speech.num_segments(), seconds(end.min(pcm.len())), if found == 0 { " (let through by its level)" } else { "" }));
    Ok(end)
  }

  /// A pass in the language Settings pins, or else the hold's: detected by its first pass that is sure
  /// of it, and reused by every later pass, since detecting again would double the work.
  fn pass(&self, engine: &mut Engine, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>, quick: bool) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    let ask = Ask::now();
    let started = Instant::now();
    let held = self.hold(id, |hold| hold.language);
    let (language, how) = match ask.language.map(|language| (language, "Settings".to_owned())).or_else(|| held.map(|language| (language, "this hold".to_owned()))) {
      Some(found) => found,
      None => {
        let (language, sure) = engine.detect(pcm)?;
        if sure >= 0.9 { self.hold(id, |hold| hold.language = Some(language)); }
        (language, format!("detected, {sure:.2} sure{}", if sure >= 0.9 { "" } else { ", not kept" }))
      }
    };
    self.hold(id, |hold| hold.spoken = Some(language));
    let result = engine.run(pcm, language, &ask, cancelled, quick);
    let ms = started.elapsed().as_millis();
    if quick {
      self.hold(id, |hold| { hold.live.passes += 1; hold.live.total_ms += ms; hold.live.slowest_ms = hold.live.slowest_ms.max(ms); });
    } else {
      let outcome = match &result { Ok(text) => format!("{} word(s)", text.split_whitespace().count()), Err(error) if error == UNHEARD => "nothing it was sure of".into(), Err(error) => format!("failed: {error}") };
      log::info!("dictation pass: {:.1}s of audio, language {} ({how}){}, 5 beams, {ms} ms, {outcome}", pcm.len() as f32 / 16_000.0,
        whisper_rs::get_lang_str(language).unwrap_or("?"), if ask.translate { ", translated" } else { "" });
    }
    result
  }

  /// The words once the key is let go. A live pass that already heard everything said is the answer, and
  /// one still running that will is worth waiting for; only speech past the newest live pass needs a
  /// pass of its own. A long hold or hands-free session is mostly in its words already: only its tail is left.
  fn finish(&self, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, String> {
    if self.long(id, pcm.len()) {
      let mut engine = self.engine_now();
      return self.note_finish(engine.as_mut().ok_or("The speech model is still loading.")?, id, 0, pcm, cancelled);
    }
    let end = self.find_speech_end(pcm, true)? + SETTLED;
    let heard = || self.hold(id, |hold| hold.heard.clone()).filter(|(samples, _)| *samples >= end).map(|(_, text)| text);
    let live = self.hold(id, |hold| hold.live);
    if live.passes > 0 { log::info!("dictation live: {} pass(es), {} ms in all, slowest {} ms", live.passes, live.total_ms, live.slowest_ms); }
    if let Some(text) = heard() { log::info!("dictation pass: none needed, a live pass heard all of it"); return Ok(text); }
    if let Some(draft) = lock(&self.draft).as_ref() {
      if draft.id != id || draft.samples < end { draft.cancelled.store(true, Ordering::Relaxed); } // frees the engine sooner
    }
    let mut engine = self.engine_now();
    if let Some(text) = heard() { return Ok(text); }
    self.pass(engine.as_mut().ok_or("The speech model is still loading.")?, id, pcm, cancelled, false)
  }

  /// Whether a hold of `samples` finishes as a long session, piece by piece: one past a piece, or a
  /// hands-free one with words in already.
  fn long(&self, id: &str, samples: usize) -> bool {
    pieced(id, samples) && (samples > note::PIECE || self.note(id, |note| note.committed) > 0)
  }

  /// Where the audio of a live pass over `count` samples starts: past what a hold heard piece by piece
  /// has in its words already, which is neither copied nor heard again.
  fn unheard(&self, id: &str, count: usize) -> usize {
    if pieced(id, count) { self.note(id, |note| note.committed).min(count) } else { 0 }
  }

  /// Holds a crash cut off before their words were out, transcribed into History at the time they were
  /// said. Each is read and let go before it is tried, so audio that crashed the app isn't tried again.
  /// ponytail: holds the engine for all of a long one; give it up between pieces if that ever gets in the way.
  fn recover(&self) {
    let Ok(found) = fs::read_dir(&self.unsent) else { return };
    for path in found.flatten().map(|entry| entry.path()) {
      let read = read_unsent(&path);
      let _ = fs::remove_file(&path);
      let Ok((said, pcm)) = read else { continue };
      let Some(mode) = context::Mode::parse(&said.mode).filter(|_| validate_audio(&pcm).is_ok()) else { continue };
      let ctx = context::HoldContext::new(&format!("recovered-{}", said.at_ms), mode, &said.bundle_id, &said.app_name);
      let heard = catch_unwind(AssertUnwindSafe(|| match self.engine_now().as_mut() {
        Some(engine) => self.pieces(engine, &ctx.request, String::new(), &pcm, Arc::default()),
        None => Err("The speech model is still loading.".into()),
      }));
      match heard {
        Ok(Ok(text)) => {
          let text = if ctx.mode.types() { text::finish(&text, &ctx, false) } else { text };
          history::record(history::Entry { words: text.split_whitespace().count(), text, ..said });
          log::info!("dictation: a hold a crash cut off is in History now");
        }
        Ok(Err(error)) => log::info!("dictation: a hold a crash cut off had no words: {error}"),
        Err(_) => log::error!("dictation: a hold a crash cut off couldn’t be transcribed"),
      }
    }
  }

  /// One live pass. Its words are kept while it still holds the engine, so a release waiting on it finds them.
  fn draft(&self, engine: &mut Engine, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Option<String> {
    self.speech_end(pcm).ok()?;
    let text = self.pass(engine, id, pcm, cancelled.clone(), true).ok()?;
    if cancelled.load(Ordering::Relaxed) { return None; }
    self.hold(id, |hold| hold.heard = Some((pcm.len(), text.clone())));
    Some(text)
  }
}

#[no_mangle]
extern "C" fn dictate_audio(id: *const c_char, samples: *const f32, count: usize) -> bool {
  let Some(app) = APP.get() else { return false };
  if samples.is_null() || id.is_null() { return false; }
  unsafe { dictate_learn_stop() }; // a new hold: the field may change by our own typing
  let id = unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned();
  if count > max_samples(&id) { return false; }
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) { return false; }
  let mut job = lock(&state.job);
  if job.is_some() { return false; }
  // AppKit owns the bounded audio buffer until this synchronous copy returns.
  let pcm = unsafe { std::slice::from_raw_parts(samples, count) }.to_vec();
  let cancelled = Arc::new(AtomicBool::new(false));
  *job = Some((id.clone(), cancelled.clone()));
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let ctx = context::get(&id);
    let mut claim = Claim::new(&state); claim.job = Some(cancelled.clone());
    // On disk until the words are out, so a crash on the way leaves it for the next launch.
    claim.unsent = keep_unsent(&state.unsent, &history::Entry::new(&ctx, "", pcm.len() as f64 / 16000.0), &pcm)
      .inspect_err(|e| log::warn!("dictation: couldn’t keep the audio until its words are out: {e}")).ok();
    let released = Instant::now();
    let result = catch_unwind(AssertUnwindSafe(|| state.finish(&id, &pcm, cancelled.clone()))).unwrap_or_else(|_| {
      log::error!("dictation: a pass panicked");
      Err(PANICKED.into())
    });
    let heard_words = result.as_ref().map_or(0, |text| text.split_whitespace().count());
    claim.end_job();
    if cancelled.load(Ordering::Relaxed) || !state.enabled.load(Ordering::Relaxed) { return; }
    // The words as Whisper heard them, should the pipeline after it fail.
    let result = result.map(|text| catch_unwind(AssertUnwindSafe(|| settle(&id, &text, pcm.len()))).unwrap_or(text));
    log::info!("dictation done: {:.1}s of audio, {} ms after release, {}", pcm.len() as f32 / 16_000.0, released.elapsed().as_millis(), match &result {
      Ok(text) => format!("{heard_words} word(s) heard, {} after the text pipeline", text.split_whitespace().count()),
      Err(error) if error == UNHEARD => "unheard".into(),
      Err(error) => format!("error: {error}"),
    });
    // Return follows the words when the app is one for messages, or when "send" ended what was said.
    let (result, send) = match result {
      // "Sticky: call Thomas" puts a sticky on the screen instead of typing.
      Ok(text) if ctx.mode.types() && text::sticky_words(&text).is_some() => {
        if let (Some(app), Some(words)) = (APP.get(), text::sticky_words(&text)) { crate::library::stickies::from_voice(app, &words); }
        (Ok(String::new()), false)
      }
      Ok(text) if ctx.mode.types() => { let (text, spoken) = text::without_send(&text); let send = spoken || settings::get().apps.send_for(&ctx.bundle_id); (Ok(text), send) }
      other => (other, false),
    };
    // The words just typed are watched for a correction, which may teach the vocabulary a word.
    let learn = ctx.mode.types() && settings::get().vocabulary.learn;
    let id = CString::new(id).unwrap_or_default();
    let (text, error) = match result {
      Ok(text) => (Some(CString::new(text.replace('\0', "")).unwrap_or_default()), None),
      Err(error) => (None, Some(CString::new(error).unwrap_or_default())),
    };
    let _ = app.run_on_main_thread(move || unsafe {
      dictate_result_sends(id.as_ptr(), send);
      dictate_result(id.as_ptr(), text.as_ref().map_or(std::ptr::null(), |text| text.as_ptr()), error.as_ref().map_or(std::ptr::null(), |error| error.as_ptr()));
      if let Some(text) = text.as_ref().filter(|text| learn && !text.is_empty()) { dictate_learn_watch(text.as_ptr()); }
    });
  });
  true
}

/// A live pass while the key is held: what has been said so far, for the overlay to show as it comes.
/// One at a time, never while the engine is busy (loading, or the final pass); when it cannot run it
/// simply skips this tick. A hands-free session, and a hold past one piece, runs as long as a note and is
/// transcribed like one.
#[no_mangle]
extern "C" fn dictate_draft(id: *const c_char, samples: *const f32, count: usize) -> bool {
  let Some(app) = APP.get() else { return false };
  if samples.is_null() || id.is_null() { return false; }
  unsafe { dictate_learn_stop() };
  let id = unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned();
  let long = pieced(&id, count);
  if !(8_000..=max_samples(&id)).contains(&count) { return false; } // under 0.5 s says nothing yet
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) || lock(&state.job).is_some() { return false; }
  let mut draft = lock(&state.draft);
  if draft.is_some() { return false; }
  let skip = state.unheard(&id, count);
  // AppKit owns the bounded audio buffer until this synchronous copy returns.
  let pcm = unsafe { std::slice::from_raw_parts(samples.add(skip), count - skip) }.to_vec();
  let cancelled = Arc::new(AtomicBool::new(false));
  *draft = Some(Draft { id: id.clone(), samples: count, cancelled: cancelled.clone() });
  drop(draft);
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let mut claim = Claim::new(&state); claim.draft = true;
    let text = try_lock(&state.engine).and_then(|mut engine| engine.as_mut().and_then(|engine| {
      if long { state.long_draft(engine, &id, skip, &pcm, cancelled.clone()) } else { state.draft(engine, &id, &pcm, cancelled.clone()) }
    }));
    drop(claim);
    let Some(text) = text else { return };
    let ctx = context::get(&id);
    let text = if ctx.mode.types() { text::finish(&text, &ctx, true) } else { text };
    let (id, text) = (CString::new(id).unwrap_or_default(), CString::new(text.replace('\0', "")).unwrap_or_default());
    let _ = app.run_on_main_thread(move || unsafe { dictate_draft_result(id.as_ptr(), text.as_ptr()); });
  });
  true
}

/// A hold's final words on their way out: the text pipeline and Claude's polish for typed modes, then
/// the history. Claude is asked only where the app's style says so and only once it is connected.
fn settle(id: &str, raw: &str, samples: usize) -> String {
  let ctx = context::get(id);
  let text = if ctx.mode.types() {
    let text = text::finish(raw, &ctx, false);
    let settings = settings::get();
    if settings.claude.enabled && settings.apps.style_for(&ctx.bundle_id).1 { ai::polish(&text, &ctx).unwrap_or(text) } else { text }
  } else { raw.to_owned() };
  history::record(history::Entry::new(&ctx, &text, samples as f64 / 16000.0));
  text
}

/// Keeps a hold's audio in `dir` until its words are out: what History will say of it, without the words,
/// on a line of its own, then the samples. Written beside its name and renamed onto it, so a crash leaves
/// all of it or none.
fn keep_unsent(dir: &Path, said: &history::Entry, pcm: &[f32]) -> std::io::Result<PathBuf> {
  fs::create_dir_all(dir)?;
  let path = dir.join(format!("{}.hold", said.at_ms));
  let mut bytes = serde_json::to_vec(said)?;
  bytes.push(b'\n');
  bytes.extend(pcm.iter().flat_map(|sample| sample.to_le_bytes()));
  let temp = path.with_extension("tmp");
  fs::write(&temp, bytes)?;
  fs::rename(&temp, &path)?;
  Ok(path)
}

fn read_unsent(path: &Path) -> std::io::Result<(history::Entry, Vec<f32>)> {
  if path.extension().is_none_or(|extension| extension != "hold") { return Err(std::io::ErrorKind::InvalidData.into()); }
  let bytes = fs::read(path)?;
  let at = bytes.iter().position(|byte| *byte == b'\n').ok_or(std::io::ErrorKind::InvalidData)?;
  Ok((serde_json::from_slice(&bytes[..at])?, bytes[at + 1..].as_chunks::<4>().0.iter().map(|sample| f32::from_le_bytes(*sample)).collect()))
}

/// What `transcribe_piece` is told about a piece: its language (None follows Settings; `auto` detects
/// it), words to spell right (None is the vocabulary), whether to translate it to English, and a flag the
/// caller sets to stop it.
#[derive(Clone, Debug, Default)]
pub struct PieceOptions { pub language: Option<String>, pub prompt: Option<String>, pub translate: bool, pub cancel: Option<Arc<AtomicBool>> }

/// `transcribe_piece`'s error when it gave the engine up before finishing: the piece is untouched and
/// can be tried again.
pub const INTERRUPTED: &str = "interrupted";

/// Words Whisper heard in a piece, `start` and `end` in samples from the piece's start.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Segment { pub start: usize, pub end: usize, pub text: String }

/// One piece of audio of up to 30 s, 16 kHz mono, with timestamps. Blocking: it waits for the engine.
/// Dictation comes first: a release waiting for the engine, Pause, Quit or `opts.cancel` stops the
/// piece with `INTERRUPTED`. Silence answers no segments.
pub fn transcribe_piece(pcm: &[f32], opts: PieceOptions) -> Result<Vec<Segment>, String> {
  let app = APP.get().ok_or("The speech model is still loading.")?;
  if pcm.len() > 30 * 16000 || pcm.iter().any(|sample| !sample.is_finite()) { return Err("Invalid audio".into()); }
  if validate_audio(pcm).is_err() { return Ok(Vec::new()); }
  let state: &'static LocalSpeech = app.state::<LocalSpeech>().inner();
  if !state.enabled.load(Ordering::Relaxed) { return Err("Dictation is paused.".into()); }
  let ask = Ask::now();
  let language = match opts.language.as_deref() {
    None => ask.language,
    Some("auto") => None,
    Some(code) => Some(whisper_rs::get_lang_id(code).ok_or("Unknown language")?),
  };
  let cancelled = opts.cancel.unwrap_or_default();
  let stopped = || cancelled.load(Ordering::Relaxed) || state.piece_yields();
  let mut engine = state.engine.lock().unwrap_or_else(|e| e.into_inner());
  if stopped() { return Err(INTERRUPTED.into()); }
  let engine = engine.as_mut().ok_or("The speech model is still loading.")?;
  let language = match language { Some(language) => language, None => engine.detect(pcm)?.0 };
  if stopped() { return Err(INTERRUPTED.into()); }
  let abort = Abort { cancelled: cancelled.clone(), started: Instant::now(), piece: Some(state) };
  engine.segments(pcm, language, opts.prompt.as_deref(), &ask, opts.translate, abort).map_err(|e| if stopped() { INTERRUPTED.into() } else { e })
}

#[path = "speech_note.rs"]
mod note;

#[cfg(test)]
#[path = "speech_tests.rs"]
mod tests;
