use std::{ffi::{c_char, c_void, CStr, CString}, fs::File, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use ring::digest::{Context as Digest, SHA256};
use tauri::{AppHandle, Manager};
use crate::{ai, context, history, settings, text};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperSysContext, WhisperSysState, WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

const MAX_SAMPLES: usize = 60 * 16000;
/// A file the voice features download once and keep, checked against its size and SHA-256 every time.
pub(crate) struct Model { pub name: &'static str, pub label: &'static str, pub url: &'static str, pub bytes: u64, pub sha256: &'static str }
const MODELS: &[Model] = &[
  // Whisper large-v3 Turbo fine-tuned to keep its accuracy when the encoder sees only the speech
  // rather than a 30 s window (FUTO's audio context fine-tuning), in whisper.cpp's 8-bit format.
  Model {
    name: "ggml-acft-large-v3-turbo-q8_0.bin", label: "Whisper", bytes: 874188075,
    url: "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v2/ggml-acft-large-v3-turbo-q8_0.bin",
    sha256: "e8d17bf90d61da165773e8a4bb7de3462982eceb9a1ed696c0d6fe7c9136624a",
  },
  Model {
    name: "ggml-silero-v6.2.0.bin", label: "speech detection", bytes: 885098,
    url: "https://github.com/vehicularis/vehicularis-edge-models/releases/download/voice-v1/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
  },
];
/// Models an earlier version downloaded, removed once their replacement is in place.
const RETIRED: &[&str] = &["ggml-large-v3-turbo-q8_0.bin"];

struct LocalSpeech {
  root: PathBuf,
  enabled: AtomicBool,
  preparing: Mutex<Option<Arc<AtomicBool>>>,
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
/// What the passes of the newest hold found out, for the passes after them.
#[derive(Default)]
struct Hold { id: String, language: Option<i32>, heard: Option<(usize, String)> }
/// Speech that ends this long before a live pass's audio does is all in that pass's words.
const SETTLED: usize = 16000 * 3 / 10;
static APP: OnceLock<AppHandle> = OnceLock::new();
/// A hold with nothing to send (silence, too short, unclear): the overlay ends it quietly.
const UNHEARD: &str = "unheard";
extern "C" {
  fn dictate_model_status(message: *const c_char, status: i32);
  fn dictate_result(request: *const c_char, text: *const c_char, error: *const c_char);
  fn dictate_draft_result(request: *const c_char, text: *const c_char);
}

pub fn init(app: &AppHandle) -> Result<(), String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("voice-models");
  app.manage(LocalSpeech { root, enabled: AtomicBool::new(false), preparing: Mutex::default(), job: Mutex::default(), engine: Mutex::default(), vad: Mutex::default(), draft: Mutex::default(), hold: Mutex::default(), note: Mutex::default(), releases: AtomicUsize::new(0) });
  APP.get_or_init(|| app.clone());
  Ok(())
}

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
  if hash != model.sha256 { return Err("Voice model verification failed. Prepare the model again.".into()); }
  Ok(())
}

fn download_client() -> Result<reqwest::Client, String> {
  if rustls::crypto::CryptoProvider::get_default().is_none() { let _ = rustls::crypto::ring::default_provider().install_default(); }
  reqwest::Client::builder().https_only(true).referer(false)
    .connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(30 * 60))
    .redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|e| e.to_string())
}

/// Downloads whichever of `models` is missing or fails its check, reporting progress through `report`.
pub(crate) async fn fetch(app: &AppHandle, root: &Path, models: &'static [Model], cancel: &AtomicBool, report: fn(&AppHandle, &str, i32)) -> Result<(), String> {
  for model in models {
    if cancel.load(Ordering::Relaxed) { return Err("Voice model setup cancelled.".into()); }
    let path = root.join(model.name);
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("Couldn’t create voice model storage: {e}"))?; }
    let check = path.clone();
    if tauri::async_runtime::spawn_blocking(move || verify_model(&check, model)).await.map_err(|e| e.to_string())?.is_ok() { continue; }
    let client = download_client()?;
    let partial = path.with_extension("part");
    let result = async {
      let mut response = client.get(model.url).send().await.map_err(|_| "Couldn’t download the voice model. Check your connection and choose Prepare Model.")?
        .error_for_status().map_err(|_| "The voice model download is unavailable. Choose Prepare Model to retry.")?;
      if response.content_length().is_some_and(|bytes| bytes != model.bytes) { return Err("Voice model download has an unexpected size.".into()); }
      let mut file = File::create(&partial).map_err(|e| format!("Couldn’t save the voice model: {e}"))?;
      let mut bytes = 0u64;
      let mut last = Instant::now() - Duration::from_secs(1);
      loop {
        if cancel.load(Ordering::Relaxed) { return Err("Voice model setup cancelled.".into()); }
        let chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk()).await
          .map_err(|_| "Voice model download timed out. Choose Prepare Model to retry.")?
          .map_err(|_| "Voice model download was interrupted. Choose Prepare Model to retry.")?;
        let Some(chunk) = chunk else { break };
        bytes += chunk.len() as u64;
        if bytes > model.bytes { return Err("Voice model download is larger than expected.".into()); }
        file.write_all(&chunk).map_err(|e| format!("Couldn’t save the voice model: {e}"))?;
        if last.elapsed() >= Duration::from_millis(500) {
          report(app, &format!("Downloading {} · {}%", model.label, bytes * 100 / model.bytes), 0);
          last = Instant::now();
        }
      }
      file.sync_all().map_err(|e| e.to_string())?;
      drop(file);
      report(app, "Verifying downloaded model…", 0);
      let check = partial.clone();
      tauri::async_runtime::spawn_blocking(move || verify_model(&check, model)).await.map_err(|e| e.to_string())??;
      if cancel.load(Ordering::Relaxed) { return Err("Voice model setup cancelled.".into()); }
      std::fs::rename(&partial, &path).map_err(|e| format!("Couldn’t install the voice model: {e}"))
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
  let state = app.state::<LocalSpeech>();
  state.enabled.store(true, Ordering::Relaxed);
  let mut preparing = state.preparing.lock().unwrap();
  if preparing.is_some() { return; }
  let cancel = Arc::new(AtomicBool::new(false));
  *preparing = Some(cancel.clone());
  let app = app.clone();
  let root = state.root.clone();
  tauri::async_runtime::spawn(async move {
    let result = cancellable(&cancel, fetch(&app, &root, MODELS, &cancel, status)).await;
    if cancel.load(Ordering::Relaxed) {
      for model in MODELS { let _ = std::fs::remove_file(root.join(model.name).with_extension("part")); }
    }
    let result = match result {
      Ok(()) if !cancel.load(Ordering::Relaxed) => {
        for name in RETIRED { let _ = std::fs::remove_file(root.join(name)); }
        status(&app, "Loading Whisper on this Mac…", 0);
        let loading = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
          let state = loading.state::<LocalSpeech>();
          let mut engine = state.engine.lock().unwrap();
          if !state.enabled.load(Ordering::Relaxed) { return Err("Voice commands are off.".into()); }
          if engine.is_none() {
            let whisper = Engine::load(&root)?;
            *state.vad.lock().unwrap() = Some(load_vad(&root)?);
            *engine = Some(whisper);
          }
          Ok(())
        }).await.unwrap_or_else(|_| Err("Couldn’t load the local voice model.".into()))
      }
      Ok(()) => Err("Voice model setup cancelled. Choose Prepare Model to retry.".into()),
      error => error,
    };
    let state = app.state::<LocalSpeech>();
    state.preparing.lock().unwrap().take();
    if state.enabled.load(Ordering::Relaxed) {
      if cancel.load(Ordering::Relaxed) {
        let retry = app.clone();
        let _ = app.run_on_main_thread(move || {
          if retry.state::<LocalSpeech>().enabled.load(Ordering::Relaxed) { dictate_prepare_models(); }
        });
        return;
      }
      match result {
        Ok(()) => status(&app, "Whisper large-v3 Turbo · automatic language detection · audio stays on this Mac", 1),
        Err(error) => status(&app, &error, -1),
      }
    }
  });
}

#[no_mangle]
extern "C" fn dictate_disable_models() {
  let Some(app) = APP.get() else { return };
  let state = app.state::<LocalSpeech>();
  state.enabled.store(false, Ordering::Relaxed);
  if let Some(cancel) = state.preparing.lock().unwrap().as_ref() { cancel.store(true, Ordering::Relaxed); }
  if let Some((_, cancel)) = state.job.lock().unwrap().as_ref() { cancel.store(true, Ordering::Relaxed); }
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let mut engine = state.engine.lock().unwrap();
    if !state.enabled.load(Ordering::Relaxed) { engine.take(); state.vad.lock().unwrap().take(); }
  });
}

/// Frees the model before the process exits: the speech library's Metal device is a C++ static whose
/// destructor aborts while a loaded model still holds GPU buffers, and managed state is never dropped.
pub fn shutdown(app: &AppHandle) {
  let Some(state) = app.try_state::<LocalSpeech>() else { return };
  state.enabled.store(false, Ordering::Relaxed); // a load that hasn't started yet gives up
  if let Some((_, cancel)) = state.job.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { cancel.store(true, Ordering::Relaxed); }
  if let Some(draft) = state.draft.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { draft.cancelled.store(true, Ordering::Relaxed); }
  state.engine.lock().unwrap_or_else(|e| e.into_inner()).take();
  state.vad.lock().unwrap_or_else(|e| e.into_inner()).take();
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

fn validate_audio(pcm: &[f32]) -> Result<(), String> {
  if pcm.len() < 4000 || pcm.len() > MAX_SAMPLES || pcm.iter().any(|sample| !sample.is_finite()) {
    return Err(UNHEARD.into());
  }
  let energy = pcm.iter().map(|sample| (*sample as f64).powi(2)).sum::<f64>() / pcm.len() as f64;
  if energy < 1e-7 { return Err(UNHEARD.into()); }
  Ok(())
}

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

fn load_vad(root: &Path) -> Result<WhisperVadContext, String> {
  WhisperVadContext::new(root.join(MODELS[1].name).to_str().ok_or("Invalid speech model path.")?, WhisperVadContextParams::default())
    .map_err(|_| "Couldn’t load local speech detection. Choose Prepare Model to retry.".into())
}

struct Engine { whisper: WhisperContext }
impl Engine {
  fn load(root: &Path) -> Result<Self, String> {
    // Native debug logs can contain recognized tokens; keep speech out of app logs.
    whisper_rs::install_logging_hooks();
    let path = root.join(MODELS[0].name);
    let path = path.to_str().ok_or("Voice model path is not valid Unicode.")?;
    let mut parameters = WhisperContextParameters::default();
    parameters.use_gpu(true).flash_attn(true);
    let whisper = WhisperContext::new_with_params(path, parameters).or_else(|_| {
      let mut cpu = WhisperContextParameters::default(); cpu.use_gpu(false);
      WhisperContext::new_with_params(path, cpu)
    }).map_err(|_| "Couldn’t load Whisper. Free some memory, then choose Prepare Model.")?;
    Ok(Self { whisper })
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
    params.set_audio_ctx(audio_ctx(pcm.len()));
    params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
    unsafe { params.set_start_encoder_callback(Some(stop_before_encoding)); }
    state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    let (language, sure) = state.lang_detect(0, threads()).map_err(|_| "Couldn’t understand that")?;
    Ok((language, sure.get(language as usize).copied().unwrap_or(0.0)))
  }

  /// `quick` is the live pass's greedy decoding; the final pass searches five beams, which costs about
  /// the same because the encoder dominates.
  fn run(&mut self, pcm: &[f32], language: i32, cancelled: Arc<AtomicBool>, quick: bool) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    let mut state = self.whisper.create_state().map_err(|_| "Not enough memory")?;
    let mut params = FullParams::new(if quick { SamplingStrategy::Greedy { best_of: 1 } } else { SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 } });
    params.set_n_threads(threads() as i32);
    params.set_language(whisper_rs::get_lang_str(language));
    params.set_audio_ctx(audio_ctx(pcm.len()));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_suppress_nst(true);
    params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
    let mut abort = Abort { cancelled: cancelled.clone(), started: Instant::now(), piece: None };
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe { params.set_abort_callback(Some(should_abort)); params.set_abort_callback_user_data((&mut abort as *mut Abort).cast()); }
    state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    let mut text = String::new();
    for segment in state.as_iter() {
      if segment.no_speech_probability() > 0.6 { return Err(UNHEARD.into()); }
      text.push_str(&segment.to_string());
    }
    let text = text.trim().to_owned();
    if text.is_empty() { return Err(UNHEARD.into()); }
    if text.chars().count() > 8000 { return Err("Too long, try shorter".into()); }
    Ok(text)
  }
}

impl Engine {
  fn segments(&mut self, pcm: &[f32], language: i32, prompt: Option<&str>, translate: bool, mut abort: Abort) -> Result<Vec<Segment>, String> {
    let mut state = self.whisper.create_state().map_err(|_| "Not enough memory")?;
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_n_threads(threads() as i32);
    params.set_language(whisper_rs::get_lang_str(language));
    params.set_audio_ctx(audio_ctx(pcm.len()));
    params.set_translate(translate);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    if let Some(prompt) = prompt.filter(|prompt| !prompt.trim().is_empty()) { params.set_initial_prompt(prompt); }
    params.set_print_special(false); params.set_print_progress(false); params.set_print_realtime(false); params.set_print_timestamps(false);
    // The callback borrows this stack value only for the synchronous full() call.
    unsafe { params.set_abort_callback(Some(should_abort)); params.set_abort_callback_user_data((&mut abort as *mut Abort).cast()); }
    state.full(params, pcm).map_err(|_| "Couldn’t understand that")?;
    // Timestamps are in hundredths of a second.
    let samples = |at: i64| (at.max(0) as usize * 160).min(pcm.len());
    Ok(state.as_iter().filter(|segment| segment.no_speech_probability() <= 0.6).filter_map(|segment| {
      let text = segment.to_string().trim().to_owned();
      (!text.is_empty()).then(|| Segment { start: samples(segment.start_timestamp()), end: samples(segment.end_timestamp()), text })
    }).collect())
  }
}

impl LocalSpeech {
  /// A meeting piece stops when voice is off (Pause, Quit) or a release is waiting for the engine.
  fn piece_yields(&self) -> bool { !self.enabled.load(Ordering::Relaxed) || self.releases.load(Ordering::SeqCst) > 0 }

  fn hold<T>(&self, id: &str, use_it: impl FnOnce(&mut Hold) -> T) -> T {
    let mut hold = self.hold.lock().unwrap();
    if hold.id != id { *hold = Hold { id: id.to_owned(), ..Hold::default() }; }
    use_it(&mut hold)
  }

  /// Where the speech in `pcm` ends, in samples. The end is found more keenly than whether there is speech
  /// at all, so a short or quiet last word still counts.
  fn speech_end(&self, pcm: &[f32]) -> Result<usize, String> {
    validate_audio(pcm)?;
    let mut vad = self.vad.lock().unwrap();
    let vad = vad.as_mut().ok_or("Voice is still loading")?;
    vad.detect_speech(pcm).map_err(|_| "Couldn’t understand that")?;
    let speech = vad.segments_from_probabilities(WhisperVadParams::default()).map_err(|_| "Couldn’t understand that")?;
    if speech.num_segments() == 0 { return Err(UNHEARD.into()); }
    let mut keen = WhisperVadParams::default();
    keen.set_threshold(0.3); keen.set_min_speech_duration(0);
    let speech = vad.segments_from_probabilities(keen).map_err(|_| "Couldn’t understand that")?;
    // In hundredths of a second.
    Ok(speech.get_segment_end_timestamp(speech.num_segments() - 1).map_or(pcm.len(), |end| (end * 160.0) as usize))
  }

  /// A hold's language is detected by its first pass that is sure of it, and every later pass reuses it:
  /// detecting again would double the work.
  fn pass(&self, engine: &mut Engine, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>, quick: bool) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
    let language = match self.hold(id, |hold| hold.language) {
      Some(language) => language,
      None => {
        let (language, sure) = engine.detect(pcm)?;
        if sure >= 0.9 { self.hold(id, |hold| hold.language = Some(language)); }
        language
      }
    };
    engine.run(pcm, language, cancelled, quick)
  }

  /// The words once the key is let go. A live pass that already heard everything said is the answer, and
  /// one still running that will is worth waiting for; only speech past the newest live pass needs a
  /// pass of its own.
  fn finish(&self, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, String> {
    let end = self.speech_end(pcm)? + SETTLED;
    let heard = || self.hold(id, |hold| hold.heard.clone()).filter(|(samples, _)| *samples >= end).map(|(_, text)| text);
    if let Some(text) = heard() { return Ok(text); }
    if let Some(draft) = self.draft.lock().unwrap().as_ref() {
      if draft.id != id || draft.samples < end { draft.cancelled.store(true, Ordering::Relaxed); } // frees the engine sooner
    }
    self.releases.fetch_add(1, Ordering::SeqCst);
    let engine = self.engine.lock();
    self.releases.fetch_sub(1, Ordering::SeqCst);
    let mut engine = engine.unwrap();
    if let Some(text) = heard() { return Ok(text); }
    self.pass(engine.as_mut().ok_or("Voice is still loading")?, id, pcm, cancelled, false)
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
  if count > MAX_SAMPLES || samples.is_null() || id.is_null() { return false; }
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) { return false; }
  let mut job = state.job.lock().unwrap();
  if job.is_some() { return false; }
  // AppKit owns the bounded audio buffer until this synchronous copy returns.
  let (id, pcm) = unsafe { (CStr::from_ptr(id).to_string_lossy().into_owned(), std::slice::from_raw_parts(samples, count).to_vec()) };
  let cancelled = Arc::new(AtomicBool::new(false));
  *job = Some((id.clone(), cancelled.clone()));
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let result = state.finish(&id, &pcm, cancelled.clone());
    state.job.lock().unwrap().take();
    if cancelled.load(Ordering::Relaxed) || !state.enabled.load(Ordering::Relaxed) { return; }
    let result = result.map(|text| settle(&id, &text, pcm.len()));
    let id = CString::new(id).unwrap_or_default();
    let (text, error) = match result {
      Ok(text) => (Some(CString::new(text.replace('\0', "")).unwrap_or_default()), None),
      Err(error) => (None, Some(CString::new(error).unwrap_or_default())),
    };
    let _ = app.run_on_main_thread(move || unsafe {
      dictate_result(id.as_ptr(), text.as_ref().map_or(std::ptr::null(), |text| text.as_ptr()), error.as_ref().map_or(std::ptr::null(), |error| error.as_ptr()));
    });
  });
  true
}

/// A live pass while the key is held: what has been said so far, for the overlay to show as it comes.
/// One at a time, never while the engine is busy (loading, or the final pass); when it cannot run it
/// simply skips this tick.
#[no_mangle]
extern "C" fn dictate_draft(id: *const c_char, samples: *const f32, count: usize) -> bool {
  let Some(app) = APP.get() else { return false };
  if !(8_000..=MAX_SAMPLES).contains(&count) || samples.is_null() || id.is_null() { return false; } // under 0.5 s says nothing yet
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) || state.job.lock().unwrap().is_some() { return false; }
  let mut draft = state.draft.lock().unwrap();
  if draft.is_some() { return false; }
  // AppKit owns the bounded audio buffer until this synchronous copy returns.
  let (id, pcm) = unsafe { (CStr::from_ptr(id).to_string_lossy().into_owned(), std::slice::from_raw_parts(samples, count).to_vec()) };
  let cancelled = Arc::new(AtomicBool::new(false));
  *draft = Some(Draft { id: id.clone(), samples: count, cancelled: cancelled.clone() });
  drop(draft);
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let text = match state.engine.try_lock() {
      Ok(mut engine) => engine.as_mut().and_then(|engine| state.draft(engine, &id, &pcm, cancelled.clone())),
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

/// What `transcribe_piece` is told about a piece: its language (None or `auto` detects it), words to
/// spell right, whether to translate it to English, and a flag the caller sets to stop it.
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
  let app = APP.get().ok_or("Voice is still loading")?;
  if pcm.len() > 30 * 16000 || pcm.iter().any(|sample| !sample.is_finite()) { return Err("Invalid audio".into()); }
  if validate_audio(pcm).is_err() { return Ok(Vec::new()); }
  let state: &'static LocalSpeech = app.state::<LocalSpeech>().inner();
  if !state.enabled.load(Ordering::Relaxed) { return Err("Voice is off".into()); }
  let cancelled = opts.cancel.unwrap_or_default();
  let stopped = || cancelled.load(Ordering::Relaxed) || state.piece_yields();
  let mut engine = state.engine.lock().unwrap_or_else(|e| e.into_inner());
  if stopped() { return Err(INTERRUPTED.into()); }
  let engine = engine.as_mut().ok_or("Voice is still loading")?;
  let language = match opts.language.as_deref().filter(|language| *language != "auto") {
    Some(code) => whisper_rs::get_lang_id(code).ok_or("Unknown language")?,
    None => engine.detect(pcm)?.0,
  };
  if stopped() { return Err(INTERRUPTED.into()); }
  let abort = Abort { cancelled: cancelled.clone(), started: Instant::now(), piece: Some(state) };
  engine.segments(pcm, language, opts.prompt.as_deref(), opts.translate, abort).map_err(|e| if stopped() { INTERRUPTED.into() } else { e })
}

#[path = "speech_note.rs"]
mod note;

#[cfg(test)]
#[path = "speech_tests.rs"]
mod tests;
