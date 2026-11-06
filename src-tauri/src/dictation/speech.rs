use std::{ffi::{c_char, CStr, CString}, fs, panic::{catch_unwind, AssertUnwindSafe}, path::{Path, PathBuf}, sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::Instant};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};
use crate::dictation::{context, history, text};
use crate::{ai, settings};
use dictate_engine::{models::{self, cancellable, ModelKind as Model, CANCELLED, RETIRED, SILERO}, audio::{self, HANDS_FREE_SAMPLES, HOLD_SAMPLES as MAX_SAMPLES}, error::Error, pieces, pipeline::{self, LanguageFrom, SURE}, prompt::{self, PROMPT_TOKENS}, vad::{Gate, SpeechDetector, Verdict}, whisper::{self, Ask, Segment, Whisper}};

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
  engine: Mutex<Option<Whisper>>,
  /// Speech detection, apart from the engine so a release can see what was said while a live pass runs.
  vad: Mutex<Option<SpeechDetector>>,
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
  let whisper = Whisper::load(&root.join(model.files()[0].name), model)?;
  let vad = if lock(&state.vad).is_none() { Some(SpeechDetector::load(&root.join(SILERO.name))?) } else { None };
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
    whisper::pinned(&dictation.language).and_then(whisper::lang_name).map_or_else(|| "any language".to_owned(), |name| {
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

fn hands_free(id: &str) -> bool { context::get(id).mode == context::Mode::HandsFree }

/// Whether a hold of `samples` is heard piece by piece, like a note: a hands-free session, or any hold
/// that has run past one piece, whose pieces then go into its words while the key is still held.
fn pieced(id: &str, samples: usize) -> bool { samples > pieces::PIECE || hands_free(id) }

/// The most audio a hold may send: five minutes, or ten for a hands-free session.
fn max_samples(id: &str) -> usize { if hands_free(id) { HANDS_FREE_SAMPLES } else { MAX_SAMPLES } }

/// What Settings asks of every pass now.
fn ask_now() -> Ask {
  let settings = settings::get();
  Ask { language: whisper::pinned(&settings.dictation.language), translate: settings.dictation.translate_to_english, words: settings.vocabulary.words }
}

/// How many of `words`, newest first, Whisper is given. Counted with Whisper's own tokens when the
/// model is loaded and free, otherwise a token for every three bytes, which errs on the side of fewer.
#[tauri::command]
pub fn vocabulary_fit(app: AppHandle, words: Vec<String>) -> usize {
  let state = app.state::<LocalSpeech>();
  let engine = try_lock(&state.engine);
  let whisper = engine.as_ref().and_then(|engine| engine.as_ref());
  let tokens = |text: &str| whisper.map_or_else(|| text.len().div_ceil(3), |whisper| whisper.token_count(text));
  prompt::prompt_text(&words, |text| tokens(text) < PROMPT_TOKENS).1
}

/// The language a hold's words are in, as Whisper's code: English when translating, the language
/// Settings pins, or the one the hold's newest pass heard.
pub fn language(request: &str) -> Option<String> {
  let dictation = settings::get().dictation;
  if dictation.translate_to_english { return Some("en".into()); }
  if let Some(id) = whisper::pinned(&dictation.language) { return whisper::lang_code(id).map(Into::into); }
  let state = APP.get()?.try_state::<LocalSpeech>()?;
  let hold = state.hold.lock().unwrap_or_else(|e| e.into_inner());
  (hold.id == request).then_some(hold.spoken).flatten().and_then(whisper::lang_code).map(Into::into)
}

impl LocalSpeech {
  /// A meeting piece stops when voice is off (Pause, Quit) or a release is waiting for the engine.
  fn piece_yields(&self) -> bool { !self.enabled.load(Ordering::Relaxed) || self.releases.load(Ordering::SeqCst) > 0 }

  /// The engine for a release, which a meeting piece running meanwhile gives up.
  fn engine_now(&self) -> MutexGuard<'_, Option<Whisper>> {
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
  fn speech_end(&self, pcm: &[f32]) -> Result<usize, Error> { self.find_speech_end(pcm, false) }

  /// `speech_end`, saying in the log (`report`) what the gates made of the audio: its levels, the speech
  /// detection's segments and where the speech was found to end. Never the words.
  fn find_speech_end(&self, pcm: &[f32], report: bool) -> Result<usize, Error> {
    let mut vad = lock(&self.vad);
    let Gate { levels: audio::Levels { peak, rms }, verdict } = match vad.as_mut() {
      Some(vad) => vad.gate(pcm)?,
      // Audio too quiet for a word ends quietly even before speech detection is loaded.
      None if !audio::worth_a_pass(pcm) => return Err(Error::Unheard),
      None if audio::is_silent(pcm) => Gate { levels: audio::levels(pcm), verdict: Verdict::TooQuiet },
      None => return Err(Error::NotLoaded),
    };
    drop(vad);
    let seconds = |samples: usize| samples as f32 / 16_000.0;
    let say = |what: String| if report { log::info!("dictation gate: {:.1}s, peak {peak:.4}, loudest rms {rms:.4}: {what}", seconds(pcm.len())); };
    match verdict {
      Verdict::TooQuiet => { say("unheard, too quiet to hold a word (loudest rms under 0.002)".into()); Err(Error::Unheard) }
      Verdict::NoVoice => { say("unheard, no speech detected and not loud enough to count as a voice".into()); Err(Error::Unheard) }
      Verdict::Speech { end, segments, keen, by_level } => {
        say(format!("{segments} speech segment(s), {keen} keen, speech ends at {:.2}s{}", seconds(end.min(pcm.len())), if by_level { " (let through by its level)" } else { "" }));
        Ok(end)
      }
    }
  }

  /// A pass in the language Settings pins, or else the hold's: detected by its first pass that is sure
  /// of it, and reused by every later pass, since detecting again would double the work.
  fn pass(&self, engine: &mut Whisper, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>, quick: bool) -> Result<String, Error> {
    if cancelled.load(Ordering::Relaxed) { return Err(Error::Cancelled); } // before counting or logging a pass that never ran
    let started = Instant::now();
    let ask = ask_now();
    let held = self.hold(id, |hold| hold.language);
    let result = pipeline::hear(engine, pcm, &ask, held, &|| cancelled.load(Ordering::Relaxed), quick);
    if let Ok(heard) = &result {
      self.hold(id, |hold| {
        if let LanguageFrom::Detected { sure } = heard.from { if sure >= SURE { hold.language = Some(heard.language); } }
        hold.spoken = Some(heard.language);
      });
    }
    let ms = result.as_ref().map_or_else(|_| started.elapsed().as_millis(), |heard| heard.ms);
    if quick {
      self.hold(id, |hold| { hold.live.passes += 1; hold.live.total_ms += ms; hold.live.slowest_ms = hold.live.slowest_ms.max(ms); });
    } else {
      let outcome = match &result { Ok(heard) => format!("{} word(s)", heard.text.split_whitespace().count()), Err(Error::Unheard) => "nothing it was sure of".into(), Err(error) => format!("failed: {error}") };
      let (language, how) = match &result {
        Ok(heard) => (Some(heard.language), match heard.from {
          LanguageFrom::Settings => "Settings".to_owned(),
          LanguageFrom::Hold => "this hold".to_owned(),
          LanguageFrom::Detected { sure } => format!("detected, {sure:.2} sure{}", if sure >= SURE { "" } else { ", not kept" }),
        }),
        // hear drops what it learned when the pass fails; the language is still known unless it was to be detected.
        Err(_) => ask.language.map(|language| (Some(language), "Settings".to_owned())).or_else(|| held.map(|language| (Some(language), "this hold".to_owned()))).unwrap_or((None, "not detected".to_owned())),
      };
      log::info!("dictation pass: {:.1}s of audio, language {} ({how}){}, 5 beams, {ms} ms, {outcome}", pcm.len() as f32 / 16_000.0,
        language.and_then(whisper::lang_code).unwrap_or("?"), if ask.translate { ", translated" } else { "" });
    }
    result.map(|heard| heard.text)
  }

  /// The words once the key is let go. A live pass that already heard everything said is the answer, and
  /// one still running that will is worth waiting for; only speech past the newest live pass needs a
  /// pass of its own. A long hold or hands-free session is mostly in its words already: only its tail is left.
  fn finish(&self, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, Error> {
    if self.long(id, pcm.len()) {
      let mut engine = self.engine_now();
      return self.note_finish(engine.as_mut().ok_or(Error::NotLoaded)?, id, 0, pcm, cancelled);
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
    self.pass(engine.as_mut().ok_or(Error::NotLoaded)?, id, pcm, cancelled, false)
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
      let Some(mode) = context::Mode::parse(&said.mode).filter(|_| audio::worth_a_pass(&pcm)) else { continue };
      let ctx = context::HoldContext::new(&format!("recovered-{}", said.at_ms), mode, &said.bundle_id, &said.app_name);
      let heard = catch_unwind(AssertUnwindSafe(|| match self.engine_now().as_mut() {
        Some(engine) => self.pieces(engine, &ctx.request, String::new(), &pcm, Arc::default()),
        None => Err(Error::NotLoaded),
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
  fn draft(&self, engine: &mut Whisper, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Option<String> {
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
      Err(Error::Other(PANICKED.into()))
    });
    let heard_words = result.as_ref().map_or(0, |text| text.split_whitespace().count());
    claim.end_job();
    if cancelled.load(Ordering::Relaxed) || !state.enabled.load(Ordering::Relaxed) { return; }
    // The words as Whisper heard them, should the pipeline after it fail.
    let result = result.map(|text| catch_unwind(AssertUnwindSafe(|| settle(&id, &text, pcm.len()))).unwrap_or(text));
    log::info!("dictation done: {:.1}s of audio, {} ms after release, {}", pcm.len() as f32 / 16_000.0, released.elapsed().as_millis(), match &result {
      Ok(text) => format!("{heard_words} word(s) heard, {} after the text pipeline", text.split_whitespace().count()),
      Err(Error::Unheard) => "unheard".into(),
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
      Err(error) => (None, Some(CString::new(error.to_string()).unwrap_or_default())),
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

/// One piece of audio of up to 30 s, 16 kHz mono, with timestamps. Blocking: it waits for the engine.
/// Dictation comes first: a release waiting for the engine, Pause, Quit or `opts.cancel` stops the
/// piece with `Error::Interrupted`, leaving it untouched to be tried again. Silence answers no segments.
pub fn transcribe_piece(pcm: &[f32], opts: PieceOptions) -> Result<Vec<Segment>, Error> {
  let app = APP.get().ok_or(Error::NotLoaded)?;
  if pcm.len() > 30 * 16000 || pcm.iter().any(|sample| !sample.is_finite()) { return Err(Error::InvalidAudio); }
  if !audio::worth_a_pass(pcm) { return Ok(Vec::new()); }
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) { return Err(Error::Other("Dictation is paused.".into())); }
  let ask = ask_now();
  let language = match opts.language.as_deref() {
    None => ask.language,
    Some("auto") => None,
    Some(code) => Some(whisper::lang_id(code).ok_or(Error::UnknownLanguage)?),
  };
  let cancelled = opts.cancel.unwrap_or_default();
  let stopped = || cancelled.load(Ordering::Relaxed) || state.piece_yields();
  let mut engine = state.engine.lock().unwrap_or_else(|e| e.into_inner());
  if stopped() { return Err(Error::Interrupted); }
  let engine = engine.as_mut().ok_or(Error::NotLoaded)?;
  let language = match language { Some(language) => language, None => engine.detect_language(pcm)?.0 };
  if stopped() { return Err(Error::Interrupted); }
  engine.segments(pcm, language, opts.prompt.as_deref(), &ask, opts.translate, &stopped).map_err(|e| if stopped() { Error::Interrupted } else { e })
}

#[path = "speech_note.rs"]
mod note;

#[cfg(test)]
#[path = "speech_tests.rs"]
mod tests;
