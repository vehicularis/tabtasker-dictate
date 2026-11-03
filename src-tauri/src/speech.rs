use std::{ffi::{c_char, c_void, CStr, CString}, fs::File, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, MutexGuard, OnceLock, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use ring::digest::{Context as Digest, SHA256};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};
use crate::{ai, context, history, settings, text};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperSysContext, WhisperSysState, WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

const MAX_SAMPLES: usize = 60 * 16000;
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
}
struct Draft { id: String, samples: usize, cancelled: Arc<AtomicBool> }
/// What the passes of the newest hold found out, for the passes after them. `spoken` is the language
/// of its newest pass, sure or not, for the text pipeline.
#[derive(Default)]
struct Hold { id: String, language: Option<i32>, spoken: Option<i32>, heard: Option<(usize, String)> }
/// Speech that ends this long before a live pass's audio does is all in that pass's words.
const SETTLED: usize = 16000 * 3 / 10;
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Where the speech models live, once the app is up: for other models that belong beside them.
pub(crate) fn models_root() -> Option<PathBuf> { APP.get().map(|app| app.state::<LocalSpeech>().root.clone()) }
/// A hold with nothing to send (silence, too short, unclear): the overlay ends it quietly.
const UNHEARD: &str = "unheard";
/// Whisper reads at most 224 tokens of prompt; the vocabulary stays under this.
const PROMPT_TOKENS: usize = 200;
extern "C" {
  fn dictate_model_status(message: *const c_char, status: i32);
  fn dictate_result(request: *const c_char, text: *const c_char, error: *const c_char);
  fn dictate_result_sends(request: *const c_char, send: bool);
  fn dictate_draft_result(request: *const c_char, text: *const c_char);
  fn dictate_learn_watch(text: *const c_char);
  fn dictate_learn_stop();
}

impl LocalSpeech {
  fn new(root: PathBuf) -> Self {
    Self {
      root, enabled: AtomicBool::new(false), preparing: Mutex::default(), loaded: Mutex::default(), loading: Mutex::default(), step: Mutex::default(), seen: Mutex::default(),
      job: Mutex::default(), engine: Mutex::default(), vad: Mutex::default(), draft: Mutex::default(), hold: Mutex::default(), note: Mutex::default(),
      releases: AtomicUsize::new(0),
    }
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
    if state.seen.lock().unwrap().replace(choice.clone()).as_ref() == Some(&choice) { return; }
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
  let mut file = File::open(path).map_err(|_| "Voice model has not been downloaded.")?;
  if file.metadata().map_err(|e| e.to_string())?.len() != model.bytes { return Err("Voice model size does not match.".into()); }
  let mut digest = Digest::new(&SHA256);
  let mut buffer = [0; 64 * 1024];
  loop { let count = file.read(&mut buffer).map_err(|e| e.to_string())?; if count == 0 { break; } digest.update(&buffer[..count]); }
  let hash: String = digest.finish().as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
  if hash != model.sha256 { return Err("The speech model didn’t pass its check. Download it again.".into()); }
  Ok(())
}

fn download_client() -> Result<reqwest::Client, String> {
  if rustls::crypto::CryptoProvider::get_default().is_none() { let _ = rustls::crypto::ring::default_provider().install_default(); }
  reqwest::Client::builder().https_only(true).referer(false)
    .connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(30 * 60))
    .redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|e| e.to_string())
}

/// Downloads whichever of `models` is missing or fails its check, reporting progress through `report`:
/// a line for the person, and how much of the download is done while it is downloading.
pub(crate) async fn fetch(root: &Path, models: &'static [Model], cancel: &AtomicBool, report: &(impl Fn(&str, Option<u8>) + Sync)) -> Result<(), String> {
  for model in models {
    if cancel.load(Ordering::Relaxed) { return Err("Voice model setup cancelled.".into()); }
    let path = root.join(model.name);
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("Couldn’t create speech model storage: {e}"))?; }
    let check = path.clone();
    if tauri::async_runtime::spawn_blocking(move || verify_model(&check, model)).await.map_err(|e| e.to_string())?.is_ok() { continue; }
    let client = download_client()?;
    let partial = path.with_extension("part");
    let result = async {
      let mut response = client.get(model.url).send().await.map_err(|_| "Couldn’t download the speech model. Check your connection and try again.")?
        .error_for_status().map_err(|_| "The speech model download is unavailable right now. Try again later.")?;
      if response.content_length().is_some_and(|bytes| bytes != model.bytes) { return Err("Voice model download has an unexpected size.".into()); }
      let mut file = File::create(&partial).map_err(|e| format!("Couldn’t save the speech model: {e}"))?;
      let mut bytes = 0u64;
      let mut last = Instant::now() - Duration::from_secs(1);
      loop {
        if cancel.load(Ordering::Relaxed) { return Err("Voice model setup cancelled.".into()); }
        let chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk()).await
          .map_err(|_| "The speech model download timed out. Try again.")?
          .map_err(|_| "The speech model download was interrupted. Try again.")?;
        let Some(chunk) = chunk else { break };
        bytes += chunk.len() as u64;
        if bytes > model.bytes { return Err("Voice model download is larger than expected.".into()); }
        file.write_all(&chunk).map_err(|e| format!("Couldn’t save the speech model: {e}"))?;
        if last.elapsed() >= Duration::from_millis(500) {
          let percent = (bytes * 100 / model.bytes) as u8;
          report(&format!("Downloading {} · {percent}%", model.label), Some(percent));
          last = Instant::now();
        }
      }
      file.sync_all().map_err(|e| e.to_string())?;
      drop(file);
      report("Verifying downloaded model…", None);
      let check = partial.clone();
      tauri::async_runtime::spawn_blocking(move || verify_model(&check, model)).await.map_err(|e| e.to_string())??;
      if cancel.load(Ordering::Relaxed) { return Err("Voice model setup cancelled.".into()); }
      std::fs::rename(&partial, &path).map_err(|e| format!("Couldn’t install the speech model: {e}"))
    }.await;
    if result.is_err() { let _ = std::fs::remove_file(&partial); }
    result?;
  }
  Ok(())
}

pub(crate) async fn wait_cancelled(cancel: &AtomicBool) {
  while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(100)).await; }
}

pub(crate) async fn cancellable<T>(cancel: &AtomicBool, work: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
  tokio::select! {
    result = work => result,
    _ = wait_cancelled(cancel) => Err("Voice model setup cancelled.".into()),
  }
}

#[no_mangle]
extern "C" fn dictate_prepare_models() {
  let Some(app) = APP.get() else {
    unsafe { dictate_model_status(c"Voice model storage is unavailable. Restart TabTasker Dictate and try again.".as_ptr(), -1); }
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
  let want = first_load(&state.root, chosen, state.loaded.lock().unwrap().is_some());
  let cancel = {
    let mut preparing = state.preparing.lock().unwrap();
    if let Some((model, cancel)) = preparing.as_ref() {
      if *model != want { cancel.store(true, Ordering::Relaxed); } // it prepares again as it stops, for the new choice
      return;
    }
    if *state.loaded.lock().unwrap() == Some(want) {
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
    let swapping = state.loaded.lock().unwrap().is_some();
    let label = files(want)[0].label;
    let report = |message: &str, percent: Option<u8>| {
      step(&app, Some(Step { model: want, message: message.into(), percent, failed: false }));
      if !swapping { status(&app, message, 0); }
    };
    report(&format!("Preparing {label}…"), None);
    let result = cancellable(&cancel, fetch(&root, files(want), &cancel, &report)).await;
    let cancelled = || cancel.load(Ordering::Relaxed);
    if cancelled() {
      for model in files(want) { let _ = std::fs::remove_file(root.join(model.name).with_extension("part")); }
    }
    let result = match result {
      Ok(()) if !cancelled() => {
        for name in RETIRED { let _ = std::fs::remove_file(root.join(name)); }
        report(&format!("Loading {label} on this Mac…"), None);
        let (loading, stop) = (app.clone(), cancel.clone());
        tauri::async_runtime::spawn_blocking(move || load(&loading, &root, want, &stop)).await
          .unwrap_or_else(|_| Err("Couldn’t load the local speech model.".into()))
      }
      Ok(()) => Err("Voice model setup was cancelled.".into()),
      error => error,
    };
    state.preparing.lock().unwrap().take();
    if !state.enabled.load(Ordering::Relaxed) { step(&app, None); return; }
    if cancelled() { prepare(&app); return; } // the choice changed, or voice went off and on again
    match result {
      Ok(()) => {
        step(&app, None);
        status(&app, &ready(&state), 1);
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
  if !state.enabled.load(Ordering::Relaxed) { return Err("Voice commands are off.".into()); }
  let whisper = Engine::load(root, model)?;
  let vad = if state.vad.lock().unwrap().is_none() { Some(load_vad(root)?) } else { None };
  // Waits for a pass in flight: the old model goes only once nothing is using it.
  let mut engine = state.engine.lock().unwrap();
  if !state.enabled.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) { return Err("Voice model setup cancelled.".into()); }
  if let Some(vad) = vad { *state.vad.lock().unwrap() = Some(vad); }
  *engine = Some(whisper);
  *state.loaded.lock().unwrap() = Some(model);
  Ok(())
}

/// What the overlay says once the model is ready.
fn ready(state: &LocalSpeech) -> String {
  let dictation = settings::get().dictation;
  let model = state.loaded.lock().unwrap().map_or("Whisper", |model| files(model)[0].label);
  let language = if dictation.translate_to_english { "translating to English".to_owned() } else {
    pinned(&dictation.language).and_then(whisper_rs::get_lang_str_full).map_or_else(|| "automatic language detection".to_owned(), |name| {
      let mut chars = name.chars();
      chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
    })
  };
  format!("{model} · {language} · audio stays on this Mac")
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
    active: *state.loaded.lock().unwrap(), enabled: state.enabled.load(Ordering::Relaxed), step: state.step.lock().unwrap().clone(),
    models: vec![stored(settings::Model::Turbo), stored(settings::Model::Small)],
  }
}

fn step(app: &AppHandle, step: Option<Step>) {
  let state = app.state::<LocalSpeech>();
  *state.step.lock().unwrap() = step;
  let _ = app.emit("dictate-model", models(&state));
}

#[tauri::command]
pub fn speech_models(app: AppHandle) -> Models { models(&app.state()) }

/// The chosen model again, after a download or load that failed.
#[tauri::command]
pub fn prepare_model(app: AppHandle) -> Result<(), String> {
  if !app.state::<LocalSpeech>().enabled.load(Ordering::Relaxed) { return Err("Turn dictation on first".into()); }
  prepare(&app);
  Ok(())
}

#[no_mangle]
extern "C" fn dictate_disable_models() {
  let Some(app) = APP.get() else { return };
  let state = app.state::<LocalSpeech>();
  state.enabled.store(false, Ordering::Relaxed);
  if let Some((_, cancel)) = state.preparing.lock().unwrap().as_ref() { cancel.store(true, Ordering::Relaxed); }
  if let Some((_, cancel)) = state.job.lock().unwrap().as_ref() { cancel.store(true, Ordering::Relaxed); }
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let mut engine = state.engine.lock().unwrap();
    if !state.enabled.load(Ordering::Relaxed) { engine.take(); state.vad.lock().unwrap().take(); state.loaded.lock().unwrap().take(); }
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
  if let Some((known, cancel)) = state.job.lock().unwrap().as_ref() {
    if known == id { cancel.store(true, Ordering::Relaxed); }
  };
  // A release may be waiting on this hold's live pass rather than running its own.
  if let Some(draft) = state.draft.lock().unwrap().as_ref() {
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

/// The most audio a hold may send: a minute, or ten for a hands-free session.
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

/// The vocabulary as Whisper's prompt, and how many words it holds: a comma list, newest first, with as
/// many words as `fits`. It starts with a space, as the words would inside heard text.
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

/// Too quiet to hold a word: even its loudest tenth of a second is below the level of a breath (OpenWhispr
/// localSpeechGate.js, its first rule). Whisper is never asked there, where it would make words up.
fn silent_audio(pcm: &[f32]) -> bool {
  pcm.chunks(1_600).map(|window| (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt()).fold(0.0, f32::max) < 0.002
}

fn prompt_text(words: &[String], fits: impl Fn(&str) -> bool) -> (String, usize) {
  let (mut text, mut count) = (String::new(), 0);
  for word in words.iter().map(|word| word.trim()).filter(|word| !word.is_empty() && !word.contains('\0')) {
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
  let engine = state.engine.try_lock().ok();
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

/// Whisper, with the tokens of the vocabulary it was last given.
struct Engine { whisper: WhisperContext, model: settings::Model, prompt: (Vec<String>, Vec<i32>) }

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
    }).map_err(|_| "Couldn’t load Whisper. Quit an app or two to free memory, then try again.")?;
    Ok(Self { whisper, model, prompt: Default::default() })
  }

  fn audio_ctx(&self, samples: usize) -> i32 { encoder_ctx(self.model, samples) }

  fn tokens(&self, text: &str) -> Vec<i32> {
    // A token is at least a byte, so this room is always enough; too little would be undefined.
    self.whisper.tokenize(text, text.len() + 8).unwrap_or_default()
  }

  /// Tokenizes `words` as the prompt, once for each change of them.
  fn use_words(&mut self, words: &[String]) {
    if self.prompt.0 == words { return; }
    let (text, _) = prompt_text(words, |text| self.tokens(text).len() < PROMPT_TOKENS);
    let tokens = if text.is_empty() { Vec::new() } else { self.tokens(&text) };
    self.prompt = (words.to_vec(), tokens);
  }

  /// The language spoken in `pcm` and how sure Whisper is of it. It runs the encoder, about half the work
  /// of a pass.
  fn detect(&self, pcm: &[f32]) -> Result<(i32, f32), String> {
    let mut state = self.whisper.create_state().map_err(|_| "Not enough memory")?;
    // whisper.cpp takes a shorter audio context only from full(), and only after its own language
    // detection. A pass stopped before its encoder leaves the spectrogram and that context in place, so
    // detecting here encodes just the speech rather than all 30 s.
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(threads() as i32);
    params.set_language(Some("en"));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
    unsafe { params.set_start_encoder_callback(Some(stop_before_encoding)); }
    state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    let (language, sure) = state.lang_detect(0, threads()).map_err(|_| "Couldn’t understand that")?;
    Ok((language, sure.get(language as usize).copied().unwrap_or(0.0)))
  }

  /// `quick` is the live pass's greedy decoding; the final pass searches five beams, which costs about
  /// the same because the encoder dominates.
  fn run(&mut self, pcm: &[f32], language: i32, ask: &Ask, cancelled: Arc<AtomicBool>, quick: bool) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    self.use_words(&ask.words);
    let text = self.decode(pcm, language, ask, cancelled.clone(), quick, true)?;
    // Over near-silence a prompted Whisper can recite the vocabulary instead of what was said (OpenWhispr
    // #1454): heard again without it.
    if !self.prompt.1.is_empty() && echoes_prompt(&text, &self.prompt.0) { return self.decode(pcm, language, ask, cancelled, quick, false); }
    Ok(text)
  }

  fn decode(&mut self, pcm: &[f32], language: i32, ask: &Ask, cancelled: Arc<AtomicBool>, quick: bool, prompted: bool) -> Result<String, String> {
    let mut state = self.whisper.create_state().map_err(|_| "Not enough memory")?;
    let mut params = FullParams::new(if quick { SamplingStrategy::Greedy { best_of: 1 } } else { SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 } });
    params.set_n_threads(threads() as i32);
    params.set_language(whisper_rs::get_lang_str(language));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    params.set_translate(ask.translate);
    params.set_no_context(true);
    // Without timestamps whisper.cpp moves on a whole 30 s window when a decode ends early, and what was said in
    // the rest of it is lost; past one window the timestamps say where to carry on.
    params.set_no_timestamps(pcm.len() <= 28 * 16_000);
    params.set_suppress_nst(true);
    // OpenWhispr's thresholds for dictation (whisperServer.js, #1458): a decode this unsure is tried again
    // warmer, which cut made-up endings ("Thank you for watching") from 2.25 % to 0.06 % of its dictations.
    params.set_entropy_thold(2.8);
    params.set_logprob_thold(-1.25);
    if prompted && !self.prompt.1.is_empty() { params.set_tokens(&self.prompt.1); }
    params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
    let mut abort = Abort { cancelled: cancelled.clone(), started: Instant::now(), piece: None };
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe { params.set_abort_callback(Some(should_abort)); params.set_abort_callback_user_data((&mut abort as *mut Abort).cast()); }
    state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    let mut text = String::new();
    let eot = self.whisper.token_eot();
    for segment in state.as_iter() {
      if silent(segment.no_speech_probability(), avg_logprob(&segment, eot)) { continue; } // that window, not the whole hold
      text.push_str(&segment.to_string());
    }
    let text = text.trim().to_owned();
    if text.is_empty() { return Err(UNHEARD.into()); }
    if text.chars().count() > 8000 { return Err("Too long, try shorter".into()); }
    Ok(text)
  }

  /// A meeting piece with timestamps. `prompt` replaces the vocabulary when the caller has its own.
  fn segments(&mut self, pcm: &[f32], language: i32, prompt: Option<&str>, ask: &Ask, translate: bool, mut abort: Abort) -> Result<Vec<Segment>, String> {
    let own = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()).map(|prompt| self.tokens(&format!(" {}", prompt.replace('\0', ""))));
    if own.is_none() { self.use_words(&ask.words); }
    let tokens = own.as_deref().unwrap_or(&self.prompt.1);
    let mut state = self.whisper.create_state().map_err(|_| "Not enough memory")?;
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_n_threads(threads() as i32);
    params.set_language(whisper_rs::get_lang_str(language));
    params.set_audio_ctx(self.audio_ctx(pcm.len()));
    params.set_translate(translate);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    if !tokens.is_empty() { params.set_tokens(tokens); }
    params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe { params.set_abort_callback(Some(should_abort)); params.set_abort_callback_user_data((&mut abort as *mut Abort).cast()); }
    state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    // Timestamps are in hundredths of a second.
    let samples = |at: i64| (at.max(0) as usize * 160).min(pcm.len());
    let eot = self.whisper.token_eot();
    Ok(state.as_iter().filter(|segment| !silent(segment.no_speech_probability(), avg_logprob(segment, eot))).filter_map(|segment| {
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
    let mut hold = self.hold.lock().unwrap();
    if hold.id != id { *hold = Hold { id: id.to_owned(), ..Hold::default() }; }
    use_it(&mut hold)
  }

  /// Where the speech in `pcm` ends, in samples. The end is found more keenly than whether there is speech
  /// at all, so a short or quiet last word still counts.
  fn speech_end(&self, pcm: &[f32]) -> Result<usize, String> {
    validate_audio(pcm)?;
    if silent_audio(pcm) { return Err(UNHEARD.into()); }
    let mut vad = self.vad.lock().unwrap();
    let vad = vad.as_mut().ok_or("The speech model is still loading.")?;
    vad.detect_speech(pcm).map_err(|_| "Couldn’t understand that")?;
    let speech = vad.segments_from_probabilities(WhisperVadParams::default()).map_err(|_| "Couldn’t understand that")?;
    if speech.num_segments() == 0 { return Err(UNHEARD.into()); }
    let mut keen = WhisperVadParams::default();
    keen.set_threshold(0.3); keen.set_min_speech_duration(0);
    let speech = vad.segments_from_probabilities(keen).map_err(|_| "Couldn’t understand that")?;
    // In hundredths of a second.
    Ok(speech.get_segment_end_timestamp(speech.num_segments() - 1).map_or(pcm.len(), |end| (end * 160.0) as usize))
  }

  /// A pass in the language Settings pins, or else the hold's: detected by its first pass that is sure
  /// of it, and reused by every later pass, since detecting again would double the work.
  fn pass(&self, engine: &mut Engine, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>, quick: bool) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    let ask = Ask::now();
    let language = match ask.language.or_else(|| self.hold(id, |hold| hold.language)) {
      Some(language) => language,
      None => {
        let (language, sure) = engine.detect(pcm)?;
        if sure >= 0.9 { self.hold(id, |hold| hold.language = Some(language)); }
        language
      }
    };
    self.hold(id, |hold| hold.spoken = Some(language));
    engine.run(pcm, language, &ask, cancelled, quick)
  }

  /// The words once the key is let go. A live pass that already heard everything said is the answer, and
  /// one still running that will is worth waiting for; only speech past the newest live pass needs a
  /// pass of its own. A long hands-free session is mostly in its words already: only its tail is left.
  fn finish(&self, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, String> {
    if self.long(id, pcm.len()) {
      let mut engine = self.engine_now();
      return self.note_finish(engine.as_mut().ok_or("The speech model is still loading.")?, id, 0, pcm, cancelled);
    }
    let end = self.speech_end(pcm)? + SETTLED;
    let heard = || self.hold(id, |hold| hold.heard.clone()).filter(|(samples, _)| *samples >= end).map(|(_, text)| text);
    if let Some(text) = heard() { return Ok(text); }
    if let Some(draft) = self.draft.lock().unwrap().as_ref() {
      if draft.id != id || draft.samples < end { draft.cancelled.store(true, Ordering::Relaxed); } // frees the engine sooner
    }
    let mut engine = self.engine_now();
    if let Some(text) = heard() { return Ok(text); }
    self.pass(engine.as_mut().ok_or("The speech model is still loading.")?, id, pcm, cancelled, false)
  }

  /// Whether a hold of `samples` finishes as a long session, piece by piece: a hands-free one that is
  /// past one piece or has words in already.
  fn long(&self, id: &str, samples: usize) -> bool {
    hands_free(id) && (samples > note::PIECE || self.note(id, |note| note.committed) > 0)
  }

  /// Where the audio of a live pass over `count` samples starts: past what a hands-free session has in
  /// its words already, which is neither copied nor heard again.
  fn unheard(&self, id: &str, count: usize) -> usize {
    if hands_free(id) { self.note(id, |note| note.committed).min(count) } else { 0 }
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
  let mut job = state.job.lock().unwrap();
  if job.is_some() { return false; }
  // AppKit owns the bounded audio buffer until this synchronous copy returns.
  let pcm = unsafe { std::slice::from_raw_parts(samples, count) }.to_vec();
  let cancelled = Arc::new(AtomicBool::new(false));
  *job = Some((id.clone(), cancelled.clone()));
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let result = state.finish(&id, &pcm, cancelled.clone());
    state.job.lock().unwrap().take();
    if cancelled.load(Ordering::Relaxed) || !state.enabled.load(Ordering::Relaxed) { return; }
    let result = result.map(|text| settle(&id, &text, pcm.len()));
    let ctx = context::get(&id);
    // Return follows the words when the app is one for messages, or when "send" ended what was said.
    let (result, send) = match result {
      // "Sticky: call Thomas" puts a sticky on the screen instead of typing.
      Ok(text) if ctx.mode.types() && text::sticky_words(&text).is_some() => {
        if let (Some(app), Some(words)) = (APP.get(), text::sticky_words(&text)) { crate::stickies::from_voice(app, &words); }
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
/// simply skips this tick. A hands-free session runs as long as a note and is transcribed like one.
#[no_mangle]
extern "C" fn dictate_draft(id: *const c_char, samples: *const f32, count: usize) -> bool {
  let Some(app) = APP.get() else { return false };
  if samples.is_null() || id.is_null() { return false; }
  unsafe { dictate_learn_stop() };
  let id = unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned();
  let long = hands_free(&id);
  if !(8_000..=max_samples(&id)).contains(&count) { return false; } // under 0.5 s says nothing yet
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) || state.job.lock().unwrap().is_some() { return false; }
  let mut draft = state.draft.lock().unwrap();
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
    let text = match state.engine.try_lock() {
      Ok(mut engine) => engine.as_mut().and_then(|engine| if long { state.long_draft(engine, &id, skip, &pcm, cancelled.clone()) } else { state.draft(engine, &id, &pcm, cancelled.clone()) }),
      Err(_) => None,
    };
    state.draft.lock().unwrap().take();
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

/// What `transcribe_piece` is told about a piece: its language (None follows Settings; `auto` detects
/// it), words to spell right (None is the vocabulary), whether to translate it to English, and a flag the
/// caller sets to stop it.
#[derive(Clone, Debug, Default)]
pub struct PieceOptions { pub language: Option<String>, pub prompt: Option<String>, pub translate: bool, pub cancel: Option<Arc<AtomicBool>> }

impl PieceOptions {
  /// The options Settings gives dictation: its language, vocabulary and translation.
  pub fn from_settings() -> Self {
    Self { translate: settings::get().dictation.translate_to_english, ..Self::default() }
  }
}

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
