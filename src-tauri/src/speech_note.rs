//! Notes: talk for as long as you like. While you are still talking the words are transcribed a piece
//! at a time, cut where you pause, each piece once; the live preview is only the piece still being
//! said. Letting go leaves only that last piece to transcribe, however long the note. A hands-free
//! session, up to ten minutes, is transcribed the same way.
use super::*;

/// The longest piece transcribed at once: inside Whisper's 30 s window.
pub(super) const PIECE: usize = 25 * 16000;
/// A pause this long ends a piece...
const PAUSE: usize = 16000 * 4 / 10;
/// ...once the piece holds this much, so pieces are sentences rather than single words.
const ENOUGH: usize = 6 * 16000;
/// The untranscribed audio a note may hold at once; the Mac drops what is transcribed.
pub(super) const TAIL: usize = 10 * 60 * 16000;

/// The note being taken. `committed` counts the samples since the note began that are in `text`;
/// `cancelled` stops its steps when the note is.
#[derive(Default)]
pub(super) struct Note { id: String, text: String, pub(super) committed: usize, busy: bool, cancelled: Arc<AtomicBool> }

/// Where to cut `len` untranscribed samples, given the speech in them as (start, end) sample ranges:
/// in the middle of the last pause that closes a piece of at least ENOUGH, within PIECE. A tail that
/// has run past PIECE is cut at its last pause, or at PIECE if the speech never paused. None while the
/// piece is still being said.
pub(super) fn cut(speech: &[(usize, usize)], len: usize) -> Option<usize> {
  let Some(&(_, last_end)) = speech.last() else {
    return (len > ENOUGH).then(|| len - PAUSE); // silence: let it go, keeping a moment for a word starting
  };
  let mut pauses: Vec<usize> = speech.windows(2).filter(|pair| pair[1].0 - pair[0].1 >= PAUSE).map(|pair| (pair[0].1 + pair[1].0) / 2).collect();
  if len - last_end.min(len) >= PAUSE { pauses.push((last_end + len) / 2); }
  let mut within = pauses.iter().copied().filter(|&at| at <= PIECE);
  if let Some(at) = within.clone().rfind(|&at| at >= ENOUGH) { return Some(at); }
  if len <= PIECE { return None; }
  Some(within.next_back().unwrap_or(PIECE))
}

fn join(text: &str, more: &str) -> String {
  match (text.is_empty(), more.is_empty()) { (true, _) => more.to_owned(), (_, true) => text.to_owned(), _ => format!("{text} {more}") }
}

impl LocalSpeech {
  /// The speech in `pcm` as sample ranges, found keenly like a hold's end; none for silence.
  fn speech_in(&self, pcm: &[f32]) -> Result<Vec<(usize, usize)>, String> {
    let energy = pcm.iter().map(|sample| (*sample as f64).powi(2)).sum::<f64>() / pcm.len().max(1) as f64;
    if pcm.len() < 4000 || energy < 1e-7 { return Ok(Vec::new()); }
    let mut vad = self.vad.lock().unwrap();
    let vad = vad.as_mut().ok_or("The speech model is still loading.")?;
    vad.detect_speech(pcm).map_err(|_| "Couldn’t understand that")?;
    let mut keen = WhisperVadParams::default();
    keen.set_threshold(0.3); keen.set_min_speech_duration(0);
    let speech = vad.segments_from_probabilities(keen).map_err(|_| "Couldn’t understand that")?;
    // In hundredths of a second.
    Ok((0..speech.num_segments()).filter_map(|i| Some(((speech.get_segment_start_timestamp(i)? * 160.0) as usize, (speech.get_segment_end_timestamp(i)? * 160.0) as usize))).collect())
  }

  /// The words of one piece; nothing for a piece that turns out to be silence.
  fn piece(&self, engine: &mut Engine, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, String> {
    match self.pass(engine, id, pcm, cancelled, false) {
      Err(error) if error == UNHEARD => Ok(String::new()),
      other => other,
    }
  }

  /// A note that was cancelled leaves nothing for the next one, and its step still running stops.
  pub(super) fn forget_note(&self, id: &str) {
    let mut note = self.note.lock().unwrap();
    if note.id == id { note.cancelled.store(true, Ordering::Relaxed); *note = Note::default(); }
  }

  /// The note `id`, begun afresh if it is not the one being taken.
  pub(super) fn note<T>(&self, id: &str, use_it: impl FnOnce(&mut Note) -> T) -> T {
    let mut note = self.note.lock().unwrap();
    if note.id != id { *note = Note { id: id.to_owned(), ..Note::default() }; }
    use_it(&mut note)
  }

  /// The note `id` only while it is still the one being taken: a step of a cancelled note never
  /// touches the next.
  fn same_note<T>(&self, id: &str, use_it: impl FnOnce(&mut Note) -> T) -> Result<T, String> {
    let mut note = self.note.lock().unwrap();
    if note.id == id { Ok(use_it(&mut note)) } else { Err("Voice command cancelled.".into()) }
  }

  /// One step while the note is being taken: `pcm` is what the Mac still holds, starting `base` samples
  /// into the note. A piece that has ended is transcribed for good; otherwise the piece still being said
  /// gets a quick pass for the preview. Answers how much of the note is now transcribed, and the preview.
  pub(super) fn note_step(&self, engine: &mut Engine, id: &str, base: usize, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<(usize, Option<String>), String> {
    let skip = self.same_note(id, |note| note.committed.saturating_sub(base))?.min(pcm.len());
    let tail = &pcm[skip..];
    let speech = self.speech_in(tail)?;
    if let Some(at) = cut(&speech, tail.len()) {
      let words = if speech.iter().any(|&(start, _)| start < at) { self.piece(engine, id, &tail[..at], cancelled.clone())? } else { String::new() };
      if cancelled.load(Ordering::Relaxed) { return Err("Voice command cancelled.".into()); }
      return self.same_note(id, |note| { note.text = join(&note.text, &words); note.committed = base + skip + at; (note.committed, None) });
    }
    let preview = if speech.is_empty() { None } else { self.pass(engine, id, tail, cancelled, true).ok() };
    Ok((base + skip, preview))
  }

  /// A live pass of a hands-free session, `pcm` starting `base` samples in: the pieces that have ended
  /// go into its words for good, and the draft is those words and the piece still being said. Until a
  /// piece is in, it is an ordinary live pass, which a release can take as the answer.
  pub(super) fn long_draft(&self, engine: &mut Engine, id: &str, base: usize, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Option<String> {
    let (committed, preview) = self.note_step(engine, id, base, pcm, cancelled.clone()).ok()?;
    if cancelled.load(Ordering::Relaxed) { return None; }
    let said = self.same_note(id, |note| note.text.clone()).ok()?;
    if let (0, Some(words)) = (committed, &preview) { self.hold(id, |hold| hold.heard = Some((base + pcm.len(), words.clone()))); }
    let text = join(&said, preview.as_deref().unwrap_or_default());
    (!text.is_empty()).then_some(text)
  }

  /// The whole note once the key is let go: what is left of `pcm` (starting `base` samples in) is
  /// transcribed piece by piece and added to the words already in.
  pub(super) fn note_finish(&self, engine: &mut Engine, id: &str, base: usize, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, String> {
    let mut at = self.note(id, |note| note.committed.saturating_sub(base)).min(pcm.len());
    let mut text = self.note(id, |note| std::mem::take(&mut note.text));
    while at < pcm.len() {
      let rest = &pcm[at..];
      let speech = self.speech_in(rest)?;
      if speech.is_empty() { break; }
      let end = if rest.len() <= PIECE { rest.len() } else { cut(&speech, rest.len()).unwrap_or(PIECE) };
      match self.piece(engine, id, &rest[..end], cancelled.clone()) {
        Ok(words) => text = join(&text, &words),
        Err(error) if cancelled.load(Ordering::Relaxed) => return Err(error),
        // One piece Whisper could not read does not cost the rest of the note.
        Err(error) => log::warn!("voice note: a piece was not transcribed: {error}"),
      }
      at += end;
    }
    let _ = self.same_note(id, |note| *note = Note::default());
    if text.is_empty() { Err(UNHEARD.into()) } else { Ok(text) }
  }
}

extern "C" {
  fn dictate_note_progress(request: *const c_char, committed: usize, preview: *const c_char);
}

/// A step of the note `id` (see note_step). One at a time, and never while the engine is busy: a step
/// that cannot run is skipped, and the next one carries the same audio and more.
#[no_mangle]
extern "C" fn dictate_note_step(id: *const c_char, base: usize, samples: *const f32, count: usize) -> bool {
  let Some(app) = APP.get() else { return false };
  if count == 0 || count > TAIL || samples.is_null() || id.is_null() { return false; }
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) || state.job.lock().unwrap().is_some() { return false; }
  // AppKit owns the bounded audio buffer until this synchronous copy returns.
  let (id, pcm) = unsafe { (CStr::from_ptr(id).to_string_lossy().into_owned(), std::slice::from_raw_parts(samples, count).to_vec()) };
  let Some(cancelled) = state.note(&id, |note| (!std::mem::replace(&mut note.busy, true)).then(|| note.cancelled.clone())) else { return false };
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let step = match state.engine.try_lock() {
      Ok(mut engine) => engine.as_mut().map(|engine| state.note_step(engine, &id, base, &pcm, cancelled)),
      Err(_) => None,
    };
    let _ = state.same_note(&id, |note| note.busy = false);
    let Some(Ok((committed, preview))) = step else { return };
    let preview = preview.map(|text| CString::new(text.replace('\0', "")).unwrap_or_default());
    let id = CString::new(id).unwrap_or_default();
    let _ = app.run_on_main_thread(move || unsafe {
      dictate_note_progress(id.as_ptr(), committed, preview.as_ref().map_or(std::ptr::null(), |text| text.as_ptr()));
    });
  });
  true
}

/// The note `id` is done: `samples` is what the Mac still holds, starting `base` samples in. Answers
/// through dictate_result, like a hold.
#[no_mangle]
extern "C" fn dictate_note_finish(id: *const c_char, base: usize, samples: *const f32, count: usize) -> bool {
  let Some(app) = APP.get() else { return false };
  if count > TAIL || (count > 0 && samples.is_null()) || id.is_null() { return false; }
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) { return false; }
  let mut job = state.job.lock().unwrap();
  if job.is_some() { return false; }
  let (id, pcm) = unsafe { (CStr::from_ptr(id).to_string_lossy().into_owned(), if count > 0 { std::slice::from_raw_parts(samples, count).to_vec() } else { Vec::new() }) };
  let cancelled = Arc::new(AtomicBool::new(false));
  *job = Some((id.clone(), cancelled.clone()));
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    // Waits for a step still running, so its piece is in before the rest is read.
    let result = match state.engine.lock().unwrap().as_mut() {
      Some(engine) => state.note_finish(engine, &id, base, &pcm, cancelled.clone()),
      None => Err("The speech model is still loading.".into()),
    };
    state.job.lock().unwrap().take();
    if cancelled.load(Ordering::Relaxed) || !state.enabled.load(Ordering::Relaxed) { return; }
    if let Ok(text) = &result { history::record(history::Entry::new(&context::get(&id), text, (base + pcm.len()) as f64 / 16000.0)); }
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
