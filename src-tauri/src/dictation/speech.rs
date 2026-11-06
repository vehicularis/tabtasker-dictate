use std::{ffi::{c_char, c_void, CStr, CString}, fs, panic::{catch_unwind, AssertUnwindSafe}, path::{Path, PathBuf}, sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};
use crate::dictation::{context, history, text};
use crate::{ai, settings};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperSysContext, WhisperSysState, WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

use dictate_engine::{models::{self, cancellable, ModelKind as Model, CANCELLED, RETIRED, SILERO}, audio::{self, HANDS_FREE_SAMPLES, HOLD_SAMPLES as MAX_SAMPLES}, cleanup, pieces, prompt::{self, Echo, PROMPT_TOKENS}};

struct LocalSpeech {
  root: PathBuf,
  enabled: AtomicBool,
  /// The model being downloaded or loaded, and the flag that stops it.
  preparing: Mutex<Option<(Model, Arc<AtomicBool>)>>,
  /// The model the engine holds.
  loaded: Mutex<Option<Model>>,
  /// Held while a model loads, so quitting waits for it instead of exiting while it holds GPU buffers.
  loading: Mutex<()>,
  /// What Settings shows of the newest download or load: under way, or the error that stopped it.
  step: Mutex<Option<Step>>,
  /// The model, language and translation Settings last asked for, so only a change of them acts.
  seen: Mutex<Option<(Model, String, bool)>>,
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


pub(crate) fn free_space(dir: &Path) -> Option<u64> {
  let path = CString::new(dir.as_os_str().as_encoded_bytes()).ok()?;
  u64::try_from(unsafe { dictate_meeting_free_space(path.as_ptr()) }).ok()
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
    let label = want.files()[0].label;
    let report = |message: &str, percent: Option<u8>| {
      step(&app, Some(Step { model: want, message: message.into(), percent, failed: false }));
      if !swapping { status(&app, message, 0); }
    };
    report(&format!("Getting {label} ready…"), None);
    let result = cancellable(&cancel, models::fetch(&root, want.files(), &cancel, &free_space, &report)).await;
    let cancelled = || cancel.load(Ordering::Relaxed);
    if cancelled() {
      for model in want.files() { let _ = std::fs::remove_file(root.join(model.name).with_extension("part")); }
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
fn first_load(root: &Path, chosen: Model, loaded: bool) -> Model {
  let here = |model: Model| model.files().iter().all(|file| std::fs::metadata(root.join(file.name)).is_ok_and(|meta| meta.len() == file.bytes));
  let other = chosen.other();
  if !loaded && !here(chosen) && here(other) { other } else { chosen }
}

/// Loads `model` beside the engine in use, then swaps it in.
fn load(app: &AppHandle, root: &Path, model: Model, cancel: &AtomicBool) -> Result<(), String> {
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
  let model = lock(&state.loaded).map_or("Whisper", |model| model.files()[0].label);
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
struct Step { model: Model, message: String, percent: Option<u8>, failed: bool }

/// The speech models as Settings shows them: the one in use, each one's size and whether it is on
/// this Mac, and the newest download or load.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Models { active: Option<Model>, enabled: bool, step: Option<Step>, models: Vec<Stored> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored { model: Model, bytes: u64, downloaded: bool }

fn models(state: &LocalSpeech) -> Models {
  let stored = |model: Model| {
    let file = &model.files()[0];
    Stored { model, bytes: file.bytes, downloaded: std::fs::metadata(state.root.join(file.name)).is_ok_and(|meta| meta.len() == file.bytes) }
  };
  Models {
    active: *lock(&state.loaded), enabled: state.enabled.load(Ordering::Relaxed), step: lock(&state.step).clone(),
    models: vec![stored(Model::Turbo), stored(Model::Small)],
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
  if !audio::worth_a_pass(pcm) { return Err(UNHEARD.into()); }
  Ok(())
}

fn hands_free(id: &str) -> bool { context::get(id).mode == context::Mode::HandsFree }

/// Whether a hold of `samples` is heard piece by piece, like a note: a hands-free session, or any hold
/// that has run past one piece, whose pieces then go into its words while the key is still held.
fn pieced(id: &str, samples: usize) -> bool { samples > pieces::PIECE || hands_free(id) }

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
fn encoder_ctx(model: Model, samples: usize) -> i32 { if model == Model::Turbo { audio_ctx(samples) } else { 0 } }

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

/// How many of `words`, newest first, Whisper is given. Counted with Whisper's own tokens when the
/// model is loaded and free, otherwise a token for every three bytes, which errs on the side of fewer.
#[tauri::command]
pub fn vocabulary_fit(app: AppHandle, words: Vec<String>) -> usize {
  let state = app.state::<LocalSpeech>();
  let engine = try_lock(&state.engine);
  let whisper = engine.as_ref().and_then(|engine| engine.as_ref());
  let tokens = |text: &str| whisper.map_or_else(|| text.len().div_ceil(3), |whisper| whisper.tokens(text).len());
  prompt::prompt_text(&words, |text| tokens(text) < PROMPT_TOKENS).1
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
struct Engine { whisper: WhisperContext, state: WhisperState, model: Model, prompt: Prompt }

/// The vocabulary as Whisper was last given it: the words, those of them that fit in its prompt, and the
/// prompt's tokens.
#[derive(Default)]
struct Prompt { words: Vec<String>, sent: Vec<String>, tokens: Vec<i32> }

/// What none of our passes prints.
fn quiet(params: &mut FullParams) {
  params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
}

/// The mean log probability of a segment's words, special tokens left out (they sort from end-of-text up).
fn avg_logprob(segment: &whisper_rs::WhisperSegment<'_>, eot: i32) -> f32 {
  let logs: Vec<f32> = (0..segment.n_tokens()).filter_map(|i| segment.get_token(i)).filter(|token| token.token_id() < eot).map(|token| token.token_data().plog).collect();
  if logs.is_empty() { f32::NEG_INFINITY } else { logs.iter().sum::<f32>() / logs.len() as f32 }
}
impl Engine {
  fn load(root: &Path, model: Model) -> Result<Self, String> {
    // Native debug logs can contain recognized tokens; keep speech out of app logs.
    whisper_rs::install_logging_hooks();
    let path = root.join(model.files()[0].name);
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
    let (text, count) = prompt::prompt_text(words, |text| self.tokens(text).len() < PROMPT_TOKENS);
    let tokens = if text.is_empty() { Vec::new() } else { self.tokens(&text) };
    self.prompt = Prompt { words: words.to_vec(), sent: prompt::entries(words).take(count).map(Into::into).collect(), tokens };
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
      if cleanup::is_silent_segment(segment.no_speech_probability(), avg_logprob(&segment, eot)) { continue; } // that window, not the whole hold
      text.push_str(&segment.to_string());
    }
    let text = if prompted { prompt::without_recital(&text, &self.prompt.sent) } else { &text }.trim().to_owned();
    let text = cleanup::unloop(&text, pcm.len() as f32 / 16_000.0);
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
    Ok(self.state.as_iter().filter(|segment| !cleanup::is_silent_segment(segment.no_speech_probability(), avg_logprob(segment, eot))).filter_map(|segment| {
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
    let audio::Levels { peak, rms } = audio::levels(pcm);
    let seconds = |samples: usize| samples as f32 / 16_000.0;
    let say = |what: String| if report { log::info!("dictation gate: {:.1}s, peak {peak:.4}, loudest rms {rms:.4}: {what}", seconds(pcm.len())); };
    if audio::is_silent(pcm) { say("unheard, too quiet to hold a word (loudest rms under 0.002)".into()); return Err(UNHEARD.into()); }
    let mut vad = lock(&self.vad);
    let vad = vad.as_mut().ok_or("The speech model is still loading.")?;
    vad.detect_speech(pcm).map_err(|_| "Couldn’t understand that")?;
    let speech = vad.segments_from_probabilities(WhisperVadParams::default()).map_err(|_| "Couldn’t understand that")?;
    // Speech detection wants a quarter of a second of speech, which one short word can fall short of, so
    // a level that is plainly a voice counts too.
    let found = speech.num_segments();
    if found == 0 && !audio::is_voiced(pcm) { say("unheard, no speech detected and not loud enough to count as a voice".into()); return Err(UNHEARD.into()); }
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
    pieced(id, samples) && (samples > pieces::PIECE || self.note(id, |note| note.committed) > 0)
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
