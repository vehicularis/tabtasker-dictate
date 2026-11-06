//! Notes: talk for as long as you like. While you are still talking the words are transcribed a piece
//! at a time, cut where you pause, each piece once; the live preview is only the piece still being
//! said. Letting go leaves only that last piece to transcribe, however long the note. A hands-free
//! session, up to ten minutes, and a hold past one piece, up to five, are transcribed the same way.
use super::*;

/// The note being taken. `committed` counts the samples since the note began that are in `text`;
/// `cancelled` stops its steps when the note is.
#[derive(Default)]
pub(super) struct Note { id: String, text: String, pub(super) committed: usize, pub(super) busy: bool, cancelled: Arc<AtomicBool> }

impl LocalSpeech {
  /// The speech in `pcm` as sample ranges, found keenly like a hold's end; none for silence.
  fn speech_in(&self, pcm: &[f32]) -> Result<Vec<(usize, usize)>, Error> { lock(&self.vad).as_mut().ok_or(Error::NotLoaded)?.speech_ranges(pcm) }

  /// The words of one piece; nothing for a piece that turns out to be silence.
  fn piece(&self, engine: &mut Whisper, id: &str, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, Error> {
    match self.pass(engine, id, pcm, cancelled, false) {
      Err(Error::Unheard) => Ok(String::new()),
      other => other,
    }
  }

  /// A note that was cancelled leaves nothing for the next one, and its step still running stops.
  pub(super) fn forget_note(&self, id: &str) {
    let mut note = lock(&self.note);
    if note.id == id { note.cancelled.store(true, Ordering::Relaxed); *note = Note::default(); }
  }

  /// The note `id`, begun afresh if it is not the one being taken.
  pub(super) fn note<T>(&self, id: &str, use_it: impl FnOnce(&mut Note) -> T) -> T {
    let mut note = lock(&self.note);
    if note.id != id { *note = Note { id: id.to_owned(), ..Note::default() }; }
    use_it(&mut note)
  }

  /// The note `id` only while it is still the one being taken: a step of a cancelled note never
  /// touches the next.
  pub(super) fn same_note<T>(&self, id: &str, use_it: impl FnOnce(&mut Note) -> T) -> Result<T, Error> {
    let mut note = lock(&self.note);
    if note.id == id { Ok(use_it(&mut note)) } else { Err(Error::Cancelled) }
  }

  /// One step while the note is being taken: `pcm` is what the Mac still holds, starting `base` samples
  /// into the note. A piece that has ended is transcribed for good; otherwise the piece still being said
  /// gets a quick pass for the preview. Answers how much of the note is now transcribed, and the preview.
  pub(super) fn note_step(&self, engine: &mut Whisper, id: &str, base: usize, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<(usize, Option<String>), Error> {
    let skip = self.same_note(id, |note| note.committed.saturating_sub(base))?.min(pcm.len());
    let tail = &pcm[skip..];
    let speech = self.speech_in(tail)?;
    if let Some(at) = pieces::cut(&speech, tail.len()) {
      let words = if speech.iter().any(|&(start, _)| start < at) { self.piece(engine, id, &tail[..at], cancelled.clone())? } else { String::new() };
      if cancelled.load(Ordering::Relaxed) { return Err(Error::Cancelled); }
      return self.same_note(id, |note| { note.text = pieces::join(&note.text, &words); note.committed = base + skip + at; (note.committed, None) });
    }
    let preview = if speech.is_empty() { None } else { self.pass(engine, id, tail, cancelled, true).ok() };
    Ok((base + skip, preview))
  }

  /// A live pass of a hands-free session or a long hold, `pcm` starting `base` samples in: the pieces that have ended
  /// go into its words for good, and the draft is those words and the piece still being said. Until a
  /// piece is in, it is an ordinary live pass, which a release can take as the answer.
  pub(super) fn long_draft(&self, engine: &mut Whisper, id: &str, base: usize, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Option<String> {
    let (committed, preview) = self.note_step(engine, id, base, pcm, cancelled.clone()).ok()?;
    if cancelled.load(Ordering::Relaxed) { return None; }
    let said = self.same_note(id, |note| note.text.clone()).ok()?;
    if let (0, Some(words)) = (committed, &preview) { self.hold(id, |hold| hold.heard = Some((base + pcm.len(), words.clone()))); }
    let text = pieces::join(&said, preview.as_deref().unwrap_or_default());
    (!text.is_empty()).then_some(text)
  }

  /// The whole note once the key is let go: what is left of `pcm` (starting `base` samples in) is
  /// transcribed piece by piece and added to the words already in.
  pub(super) fn note_finish(&self, engine: &mut Whisper, id: &str, base: usize, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, Error> {
    let at = self.note(id, |note| note.committed.saturating_sub(base)).min(pcm.len());
    let text = self.note(id, |note| std::mem::take(&mut note.text));
    let result = self.pieces(engine, id, text, &pcm[at..], cancelled);
    let _ = self.same_note(id, |note| *note = Note::default());
    result
  }

  /// `pcm` transcribed piece by piece, cut where it pauses, after the words in `text` already.
  pub(super) fn pieces(&self, engine: &mut Whisper, id: &str, mut text: String, pcm: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, Error> {
    let mut at = 0;
    while at < pcm.len() {
      let rest = &pcm[at..];
      let speech = self.speech_in(rest)?;
      if speech.is_empty() { break; }
      let end = if rest.len() <= pieces::PIECE { rest.len() } else { pieces::cut(&speech, rest.len()).unwrap_or(pieces::PIECE) };
      match self.piece(engine, id, &rest[..end], cancelled.clone()) {
        Ok(words) => text = pieces::join(&text, &words),
        Err(error) if cancelled.load(Ordering::Relaxed) => return Err(error),
        // One piece Whisper could not read does not cost the rest of the note.
        Err(error) => log::warn!("voice note: a piece was not transcribed: {error}"),
      }
      at += end;
    }
    if text.is_empty() { Err(Error::Unheard) } else { Ok(text) }
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
  if count == 0 || count > pieces::TAIL || samples.is_null() || id.is_null() { return false; }
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) || lock(&state.job).is_some() { return false; }
  // AppKit owns the bounded audio buffer until this synchronous copy returns.
  let (id, pcm) = unsafe { (CStr::from_ptr(id).to_string_lossy().into_owned(), std::slice::from_raw_parts(samples, count).to_vec()) };
  let Some(cancelled) = state.note(&id, |note| (!std::mem::replace(&mut note.busy, true)).then(|| note.cancelled.clone())) else { return false };
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let mut claim = Claim::new(&state); claim.step = Some(id.clone());
    let step = try_lock(&state.engine).and_then(|mut engine| engine.as_mut().map(|engine| state.note_step(engine, &id, base, &pcm, cancelled)));
    drop(claim);
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
  if count > pieces::TAIL || (count > 0 && samples.is_null()) || id.is_null() { return false; }
  let state = app.state::<LocalSpeech>();
  if !state.enabled.load(Ordering::Relaxed) { return false; }
  let mut job = lock(&state.job);
  if job.is_some() { return false; }
  let (id, pcm) = unsafe { (CStr::from_ptr(id).to_string_lossy().into_owned(), if count > 0 { std::slice::from_raw_parts(samples, count).to_vec() } else { Vec::new() }) };
  let cancelled = Arc::new(AtomicBool::new(false));
  *job = Some((id.clone(), cancelled.clone()));
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<LocalSpeech>();
    let mut claim = Claim::new(&state); claim.job = Some(cancelled.clone());
    // Waits for a step still running, so its piece is in before the rest is read.
    let result = catch_unwind(AssertUnwindSafe(|| match lock(&state.engine).as_mut() {
      Some(engine) => state.note_finish(engine, &id, base, &pcm, cancelled.clone()),
      None => Err(Error::NotLoaded),
    })).unwrap_or_else(|_| {
      log::error!("voice note: its last pass panicked");
      Err(Error::Other(PANICKED.into()))
    });
    claim.end_job();
    if cancelled.load(Ordering::Relaxed) || !state.enabled.load(Ordering::Relaxed) { return; }
    if let Ok(text) = &result { history::record(history::Entry::new(&context::get(&id), text, (base + pcm.len()) as f64 / 16000.0)); }
    let id = CString::new(id).unwrap_or_default();
    let (text, error) = match result {
      Ok(text) => (Some(CString::new(text.replace('\0', "")).unwrap_or_default()), None),
      Err(error) => (None, Some(CString::new(error.to_string()).unwrap_or_default())),
    };
    let _ = app.run_on_main_thread(move || unsafe {
      dictate_result(id.as_ptr(), text.as_ref().map_or(std::ptr::null(), |text| text.as_ptr()), error.as_ref().map_or(std::ptr::null(), |error| error.as_ptr()));
    });
  });
  true
}
