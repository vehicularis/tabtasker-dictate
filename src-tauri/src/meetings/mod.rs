//! Meetings: the microphone and the Mac's own sound recorded together (meeting_audio.m), transcribed a
//! piece at a time while the meeting runs, and saved as one Markdown file with who said what.
//!
//! Nothing waits in memory alone. Every sample goes to a spool folder in the app data dir as it arrives,
//! and every transcribed piece is appended there too, so a crash or a quit loses nothing: the next
//! launch offers to save what the spool holds.
pub mod speakers;

use std::ffi::{c_char, CStr};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use crate::dictation::speech;
use dictate_engine::meeting::levels::{cut, has_voice, PIECE};
use dictate_engine::meeting::speakers::{diarize, ready, Turn};
use dictate_engine::meeting::transcript::{assign_speakers, clock, dateline, document, length, transcript, untitled};
use dictate_engine::meeting::{fill, Gap, Line, Source, SOURCES};
use dictate_engine::{error::Error, whisper::Segment};
use crate::library::notes;
use crate::{ai, settings};

const RATE: usize = 16000;
/// A stream further behind the meeting's clock than this has stalled, and the time it lost is filled.
const JITTER: u64 = RATE as u64 / 10;
/// A meeting stops, or won't start, with less free space than this: about an hour and a half of audio.
const LOW_DISK: u64 = 512 * 1024 * 1024;

/// One piece as the spool keeps it: `from..done` of its stream, and what was said there. `failed` is
/// audio Whisper couldn't read, kept to try again.
#[derive(Debug, Serialize, Deserialize)]
struct Piece { source: Source, from: u64, done: u64, lines: Vec<Line>, #[serde(default, skip_serializing_if = "std::ops::Not::not")] failed: bool }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
  stamp: String,
  since_ms: u64,
  /// The file saved while some audio had no transcript yet.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  saved: Option<String>,
}

// ---------- the spool ----------

/// The file a stream's samples are spooled to.
fn file(source: Source) -> &'static str { match source { Source::Mic => "mic.pcm", Source::System => "system.pcm" } }

/// One meeting's audio and transcribed pieces on disk: `meeting.json`, a 16-bit file per stream, and
/// `pieces.jsonl`. Removed once the meeting is saved.
struct Spool { dir: PathBuf, header: Header }

impl Spool {
  fn create(root: &Path, header: Header) -> io::Result<Self> {
    let spool = Self { dir: root.join(header.since_ms.to_string()), header };
    fs::create_dir_all(&spool.dir)?;
    spool.keep_header(&spool.header)?;
    Ok(spool)
  }

  /// Written whole or not at all: a crash never leaves a spool nobody can read.
  fn keep_header(&self, header: &Header) -> io::Result<()> {
    let temp = self.dir.join("meeting.json.new");
    let mut file = File::create(&temp)?;
    file.write_all(&serde_json::to_vec(header)?)?;
    file.sync_all()?;
    fs::rename(temp, self.dir.join("meeting.json"))
  }

  /// The meeting has a file, but some of its audio has no transcript yet: the spool stays for that.
  fn mark_saved(&self, path: &Path) {
    let header = Header { saved: Some(path.display().to_string()), ..self.header.clone() };
    if let Err(e) = self.keep_header(&header) { log::warn!("meeting: couldn’t mark the recording saved: {e}"); }
  }

  fn open(dir: &Path) -> Option<Self> {
    let header = serde_json::from_slice(&fs::read(dir.join("meeting.json")).ok()?).ok()?;
    Some(Self { dir: dir.to_owned(), header })
  }

  fn id(&self) -> String { self.header.since_ms.to_string() }

  fn samples(&self, source: Source) -> u64 {
    fs::metadata(self.dir.join(file(source))).map_or(0, |meta| meta.len() / 2)
  }

  fn writer(&self, source: Source) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(self.dir.join(file(source)))
  }

  /// `count` samples from `from`, as floats: read a megabyte at a time, so a whole stream (a ten-hour meeting is
  /// 1.2 GB on disk) never sits in memory twice over.
  fn read(&self, source: Source, from: u64, count: usize) -> Result<Vec<f32>, String> {
    let mut file = File::open(self.dir.join(file(source))).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(from * 2)).map_err(|e| e.to_string())?;
    let mut pcm = Vec::with_capacity(count);
    let mut bytes = vec![0u8; (1 << 20).min(count * 2)];
    let mut left = count * 2;
    while left > 0 {
      let take = bytes.len().min(left);
      file.read_exact(&mut bytes[..take]).map_err(|e| e.to_string())?;
      pcm.extend(bytes[..take].as_chunks::<2>().0.iter().map(|pair| i16::from_le_bytes(*pair) as f32 / 32768.0));
      left -= take;
    }
    Ok(pcm)
  }

  /// How far each stream is transcribed, every line so far, and the audio that has no transcript. A
  /// piece cut short by a crash is skipped: its audio is still there to transcribe again.
  fn progress(&self) -> Progress {
    let mut at = Progress::default();
    let Ok(text) = fs::read_to_string(self.dir.join("pieces.jsonl")) else { return at };
    for piece in text.lines().filter_map(|line| serde_json::from_str::<Piece>(line).ok()) {
      let (i, source) = (piece.source.index(), piece.source);
      if piece.done > at.done[i] {
        // Audio before this piece that no piece kept is a gap too.
        if piece.from > at.done[i] { at.gaps.push(Gap { source, from: at.done[i], to: piece.from }); }
        let from = piece.from.max(at.done[i]);
        at.done[i] = piece.done;
        if piece.failed { at.gaps.push(Gap { source, from, to: piece.done }); } else { at.lines.extend(piece.lines); }
      } else if !piece.failed && fill(&mut at.gaps, source, piece.from, piece.done) {
        at.lines.extend(piece.lines);
      }
    }
    at
  }

  fn record(&self, piece: &Piece) -> Result<(), String> {
    let mut file = OpenOptions::new().create(true).read(true).append(true).open(self.dir.join("pieces.jsonl")).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_string(piece).map_err(|e| e.to_string())?;
    line.push('\n');
    // A line a crash cut short gets its end, so this one is read on its own.
    if file.seek(SeekFrom::End(-1)).is_ok() {
      let mut last = [0u8];
      if file.read_exact(&mut last).is_ok() && last[0] != b'\n' { line.insert(0, '\n'); }
    }
    file.write_all(line.as_bytes()).and_then(|_| file.sync_data()).map_err(|e| e.to_string())
  }

  fn remove(&self) {
    if let Err(e) = fs::remove_dir_all(&self.dir) { log::warn!("meeting: couldn’t remove the spool: {e}"); }
  }
}

#[derive(Default)]
struct Progress { done: [u64; 2], lines: Vec<Line>, gaps: Vec<Gap> }

fn pcm16(samples: &[f32]) -> Vec<u8> {
  samples.iter().flat_map(|sample| ((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes()).collect()
}

// ---------- a meeting ----------

struct Job {
  spool: Spool,
  /// Samples in each stream's file: what the worker may read.
  written: [AtomicU64; 2],
  /// The open files while recording, and when they were last flushed to the disk.
  writers: Mutex<([Option<File>; 2], Instant)>,
  started: Instant,
  ended: AtomicBool,
  /// What the Mac's own sound is doing: pending, on, off, unsupported, denied or failed.
  system: Mutex<String>,
  /// Why the meeting stopped early.
  problem: Mutex<Option<String>>,
  /// A stop is on its way to the main thread.
  stopping: AtomicBool,
  /// Stop was pressed: the meeting is saving, though its last audio is still on the way.
  closing: AtomicBool,
}

impl Job {
  fn new(spool: Spool, recording: bool) -> io::Result<Self> {
    let writers = if recording { [Some(spool.writer(Source::Mic)?), Some(spool.writer(Source::System)?)] } else { [None, None] };
    let written = SOURCES.map(|source| AtomicU64::new(spool.samples(source)));
    Ok(Self {
      spool, written, writers: Mutex::new((writers, Instant::now())), started: Instant::now(), ended: AtomicBool::new(!recording),
      system: Mutex::new("pending".into()), problem: Mutex::default(), stopping: AtomicBool::new(false), closing: AtomicBool::new(!recording),
    })
  }

  fn len(&self, source: Source) -> u64 { self.written[source.index()].load(Ordering::SeqCst) }

  fn stopped_early(&self, problem: &str) {
    self.problem.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(|| problem.to_owned());
    stop_soon(self);
  }

  /// `age` is how many seconds ago the first of `pcm` was captured.
  fn append(&self, source: Source, pcm: &[f32], age: f64) {
    let i = source.index();
    let mut writers = self.writers.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = writers.0[i].as_mut() else { return };
    let written = self.written[i].load(Ordering::SeqCst);
    // Each stream keeps to the meeting's clock: a stall (a device switching, a microphone slow to open)
    // leaves silence behind, so both streams' timestamps line up. Capture time places a buffer, so one
    // that queued up behind others arrives late but is not a stall.
    let at = (self.started.elapsed().as_secs_f64() - age.max(0.0)).max(0.0);
    let due = (at * RATE as f64) as u64;
    let gap = if due > written + JITTER { due - written } else { 0 };
    let mut bytes = vec![0u8; gap as usize * 2];
    bytes.extend(pcm16(pcm));
    if let Err(e) = file.write_all(&bytes) {
      log::warn!("meeting: couldn’t write audio: {e}");
      // Back to the last whole sample, and nothing more on this stream, so what is there stays readable.
      if let Err(e) = file.set_len(written * 2) { log::warn!("meeting: couldn’t trim the audio: {e}"); }
      writers.0[i] = None;
      drop(writers);
      let full = matches!(e.kind(), io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded);
      self.stopped_early(if full { "Your disk is full, so the meeting stopped" } else { "Couldn’t save the meeting’s audio, so it stopped" });
      return;
    }
    self.written[i].fetch_add(gap + pcm.len() as u64, Ordering::SeqCst);
    // Written is safe from a crash; flushed is safe from a power cut too.
    if writers.1.elapsed() >= Duration::from_secs(5) {
      for file in writers.0.iter().flatten() { let _ = file.sync_data(); }
      writers.1 = Instant::now();
    }
  }

  /// The files are closed and flushed: the meeting has all the audio it will get.
  fn end(&self) {
    let mut writers = self.writers.lock().unwrap_or_else(|e| e.into_inner());
    for file in writers.0.iter_mut().filter_map(Option::take) { let _ = file.sync_all(); }
    drop(writers);
    self.ended.store(true, Ordering::SeqCst);
  }
}

#[derive(Default)]
struct Meetings { recording: Option<Arc<Job>>, finishing: Vec<String> }
static STATE: Mutex<Meetings> = Mutex::new(Meetings { recording: None, finishing: Vec::new() });
static APP: OnceLock<AppHandle> = OnceLock::new();
static ROOT: OnceLock<PathBuf> = OnceLock::new();
/// Why the last meeting asked for didn't start.
static REFUSED: Mutex<Option<String>> = Mutex::new(None);

fn state() -> std::sync::MutexGuard<'static, Meetings> { STATE.lock().unwrap_or_else(|e| e.into_inner()) }

pub fn init(app: &AppHandle) -> Result<(), String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("meetings");
  ROOT.get_or_init(|| root);
  APP.get_or_init(|| app.clone());
  Ok(())
}

/// Why the meeting asked for last didn't start, once; None when the caller has nothing better to say
/// than its own words (the microphone card already explains a missing permission).
pub fn start_problem() -> Option<String> { REFUSED.lock().unwrap_or_else(|e| e.into_inner()).take() }

fn refuse(why: &str) -> i32 {
  *REFUSED.lock().unwrap_or_else(|e| e.into_inner()) = Some(why.to_owned());
  -1
}

fn emit(payload: serde_json::Value) {
  if let Some(app) = APP.get() { let _ = app.emit("dictate-meeting", payload); }
}

fn recording_payload(job: &Job) -> serde_json::Value {
  json!({ "state": "recording", "id": job.spool.id(), "since": job.spool.header.since_ms, "system": *job.system.lock().unwrap_or_else(|e| e.into_inner()) })
}

fn saving_payload(job: &Job, message: &str) -> serde_json::Value {
  json!({ "state": "saving", "id": job.spool.id(), "since": job.spool.header.since_ms, "message": message })
}

extern "C" {
  fn dictate_meeting(action: *const c_char) -> bool;
  fn dictate_meeting_permission() -> i32;
  fn dictate_meeting_free_space(path: *const c_char) -> i64;
}

/// Bytes free where `dir` is, counting what macOS clears when asked; None when it can't tell.
fn free_space(dir: &Path) -> Option<u64> {
  let path = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()).ok()?;
  u64::try_from(unsafe { dictate_meeting_free_space(path.as_ptr()) }).ok()
}

/// Stops the recording meeting from a thread that is not the main one, once.
fn stop_soon(job: &Job) {
  if job.stopping.swap(true, Ordering::SeqCst) { return; }
  if let Some(app) = APP.get() { let _ = app.run_on_main_thread(|| unsafe { dictate_meeting(c"stop".as_ptr()); }); }
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64) }

fn text(text: *const c_char) -> Option<String> {
  (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned())
}

/// On the main thread as a meeting starts: 1 to record the Mac's sound too, 0 for the microphone only,
/// -1 when it can't start, with the reason in `start_problem`. `stamp` is the local time as
/// "YYYY-MM-DD HH.mm".
#[no_mangle]
extern "C" fn dictate_meeting_begin(stamp: *const c_char) -> i32 {
  REFUSED.lock().unwrap_or_else(|e| e.into_inner()).take();
  let Some(root) = ROOT.get() else { return refuse("Meetings aren’t ready yet. Try again in a moment.") };
  speakers::prepare_in_background();
  let Some(stamp) = text(stamp).filter(|stamp| stamp.len() == 16 && stamp.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ' ' | '.'))) else { return refuse("Couldn’t start the meeting.") };
  let mut meetings = state();
  if meetings.recording.is_some() { return refuse("The last meeting is still saving. Try again in a moment."); }
  if free_space(root.parent().unwrap_or(root)).is_some_and(|free| free < LOW_DISK) { return refuse("Your disk is almost full, so the meeting can’t start."); }
  let job = match Spool::create(root, Header { stamp, since_ms: now_ms(), saved: None }).and_then(|spool| Job::new(spool, true)) {
    Ok(job) => Arc::new(job),
    Err(e) => {
      log::warn!("meeting: couldn’t make the spool: {e}");
      return refuse(if e.kind() == io::ErrorKind::StorageFull { "Your disk is full, so the meeting can’t start." } else { "Couldn’t make room for the meeting’s audio." });
    }
  };
  let worker = job.clone();
  if let Err(e) = std::thread::Builder::new().name("meeting".into()).spawn(move || work(worker)) {
    log::warn!("meeting: {e}");
    job.spool.remove();
    return refuse("Couldn’t start the meeting.");
  }
  meetings.recording = Some(job.clone());
  drop(meetings);
  crate::app::menu::meeting_changed(true);
  emit(recording_payload(&job));
  i32::from(settings::get().meetings.system_audio)
}

/// From the audio queue: 16 kHz mono samples, `source` 0 for the microphone and 1 for the Mac's sound,
/// the first of them captured `age` seconds ago.
#[no_mangle]
extern "C" fn dictate_meeting_audio(source: i32, samples: *const f32, count: usize, age: f64) {
  let source = match source { 0 => Source::Mic, 1 => Source::System, _ => return };
  if samples.is_null() || count == 0 || count > 10 * RATE { return; }
  let Some(job) = state().recording.clone() else { return };
  // The native side owns the buffer until this synchronous call returns.
  job.append(source, unsafe { std::slice::from_raw_parts(samples, count) }, age);
}

#[no_mangle]
extern "C" fn dictate_meeting_sources(system: *const c_char) {
  let Some(system) = text(system).filter(|system| matches!(system.as_str(), "on" | "off" | "unsupported" | "denied" | "failed")) else { return };
  let Some(job) = state().recording.clone() else { return };
  *job.system.lock().unwrap_or_else(|e| e.into_inner()) = system;
  if !job.closing.load(Ordering::SeqCst) { emit(recording_payload(&job)); }
}

/// The meeting is saving from here on: the tray, the pill and Settings say so at once, while the
/// devices close and the last buffers arrive.
fn closing(job: &Job) {
  if job.closing.swap(true, Ordering::SeqCst) { return; }
  crate::app::menu::meeting_changed(false);
  emit(saving_payload(job, "Finishing the transcript"));
}

/// On the main thread, the moment a recording meeting is told to stop.
#[no_mangle]
extern "C" fn dictate_meeting_stopping() {
  let Some(job) = state().recording.clone() else { return };
  closing(&job);
}

/// On the main thread: a meeting asked for couldn't start, from its shortcut or once the last one closed.
#[no_mangle]
extern "C" fn dictate_meeting_unstarted() {
  if let (Some(app), Some(why)) = (APP.get(), start_problem()) { let _ = app.emit("dictate-notice", json!({ "message": why })); }
}

/// Every buffer of the recording meeting is in: the worker transcribes what is left and saves it.
#[no_mangle]
extern "C" fn dictate_meeting_end(problem: *const c_char) {
  let mut meetings = state();
  let Some(job) = meetings.recording.take() else { return };
  meetings.finishing.push(job.spool.id());
  drop(meetings);
  if let Some(problem) = text(problem) { job.problem.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(problem); }
  closing(&job);
  job.end();
}

// ---------- transcribing while the meeting runs ----------

enum Trouble { Interrupted, Waiting(&'static str), Unreadable }

fn transcribe(pcm: &[f32]) -> Result<Vec<Segment>, Trouble> {
  let settings = settings::get();
  // The person's own words, most recent first, so Whisper spells names right.
  let mut prompt = String::new();
  for word in &settings.vocabulary.words {
    if prompt.len() + word.len() > 600 { break; }
    if !prompt.is_empty() { prompt.push_str(", "); }
    prompt.push_str(word);
  }
  let options = speech::PieceOptions {
    language: Some(settings.dictation.language.clone()), prompt: (!prompt.is_empty()).then_some(prompt),
    translate: settings.dictation.translate_to_english, cancel: None,
  };
  speech::transcribe_piece(pcm, options).map_err(|error| match &error {
    Error::Interrupted => Trouble::Interrupted,
    Error::Other(why) if why == speech::PAUSED => Trouble::Waiting("Turn dictation back on to finish the transcript."),
    Error::NotUnderstood => Trouble::Unreadable,
    _ => {
      log::warn!("meeting: a piece waits: {error}");
      Trouble::Waiting("Waiting for the speech model to finish the transcript.")
    }
  })
}

fn keep(job: &Job, piece: &Piece) {
  // The lines stay in memory either way; a piece the spool missed is a gap after a crash, tried again.
  if let Err(e) = job.spool.record(piece) { log::warn!("meeting: couldn’t keep a piece: {e}"); }
}

/// The next piece of `source`, if one is ready: true once it is transcribed, or given up on and kept
/// as a gap. Gaps in `retry` (from an earlier run) go first.
fn step(job: &Job, source: Source, at: &mut Progress, retry: &mut Vec<Gap>, failures: &mut [u32; 2]) -> Result<bool, Trouble> {
  let i = source.index();
  let again = retry.iter().position(|gap| gap.source == source);
  let (from, left, last) = match again {
    Some(r) => (retry[r].from, retry[r].to - retry[r].from, true),
    None => (at.done[i], job.len(source).saturating_sub(at.done[i]), job.ended.load(Ordering::SeqCst)),
  };
  if left == 0 { return Ok(false); }
  let pcm = job.spool.read(source, from, (left as usize).min(PIECE)).map_err(|e| { log::warn!("meeting: {e}"); Trouble::Waiting("Waiting for the speech model to finish the transcript.") })?;
  let Some(cut) = cut(&pcm, last && left as usize <= PIECE) else { return Ok(false) };
  let piece = &pcm[..cut];
  let to = from + cut as u64;
  let heard = if has_voice(piece) {
    match transcribe(piece) {
      Ok(heard) => Some(heard),
      // Three times over, a piece Whisper can't read is kept as audio and the meeting moves on.
      Err(Trouble::Unreadable) if failures[i] >= 2 => None,
      Err(Trouble::Unreadable) => { failures[i] += 1; return Err(Trouble::Interrupted); }
      Err(trouble) => return Err(trouble),
    }
  } else { Some(Vec::new()) };
  failures[i] = 0;
  match again {
    Some(r) if to >= retry[r].to => { retry.remove(r); }
    Some(r) => retry[r].from = to,
    None => at.done[i] = to,
  }
  let Some(heard) = heard else {
    log::warn!("meeting: {} of audio at {} couldn’t be transcribed", length(cut as u64 / RATE as u64), clock(from));
    // A gap tried again is already kept as one.
    if again.is_none() {
      keep(job, &Piece { source, from, done: to, lines: Vec::new(), failed: true });
      at.gaps.push(Gap { source, from, to });
    }
    return Ok(true);
  };
  let found: Vec<Line> = heard.into_iter().map(|segment| Line { source, start: from + segment.start as u64, end: from + segment.end as u64, text: segment.text, speaker: None }).collect();
  keep(job, &Piece { source, from, done: to, lines: found.clone(), failed: false });
  if again.is_some() { fill(&mut at.gaps, source, from, to); }
  at.lines.extend(found);
  Ok(true)
}

/// A meeting's worker: pieces while it records, the rest once it ends, then the file.
fn work(job: Arc<Job>) {
  let mut at = job.spool.progress();
  // Audio an earlier run couldn't transcribe gets another go.
  let mut retry = at.gaps.clone();
  let missing = |gaps: &[Gap]| gaps.iter().map(|gap| gap.to - gap.from).sum::<u64>();
  let before = missing(&at.gaps);
  let mut failures = [0u32; 2];
  let mut told = None;
  let mut looked: Option<Instant> = None;
  loop {
    let ended = job.ended.load(Ordering::SeqCst);
    if !ended && looked.is_none_or(|looked| looked.elapsed() >= Duration::from_secs(30)) {
      looked = Some(Instant::now());
      if free_space(&job.spool.dir).is_some_and(|free| free < LOW_DISK) { job.stopped_early("Your disk is almost full, so the meeting stopped"); }
    }
    let mut moved = false;
    let mut waiting = None;
    for source in SOURCES {
      match step(&job, source, &mut at, &mut retry, &mut failures) {
        Ok(stepped) => moved |= stepped,
        Err(Trouble::Interrupted) => {}
        Err(Trouble::Waiting(why)) => waiting = Some(why),
        Err(Trouble::Unreadable) => {}
      }
    }
    if ended && retry.is_empty() && SOURCES.iter().all(|source| at.done[source.index()] >= job.len(*source)) { break; }
    if ended && waiting.is_some() && waiting != told {
      told = waiting;
      emit(saving_payload(&job, waiting.unwrap_or_default()));
    }
    if !moved { std::thread::sleep(if waiting.is_some() { Duration::from_secs(2) } else if ended { Duration::from_millis(100) } else { Duration::from_millis(700) }); }
  }
  let outcome = finish(&job, &at, missing(&at.gaps) < before);
  // Out of `finishing` before anyone hears: a recording kept to try again is a leftover at once.
  state().finishing.retain(|id| *id != job.spool.id());
  emit(outcome);
}

/// The lines with their voices told apart, stream by stream, over the whole recording (clustering wants
/// all of a voice). The two streams run at once, each on its own thread, up to two hours apiece; past that, one
/// after the other, since each wants its whole stream as floats (230 MB an hour) and the models a copy. Without
/// the models, or when a stream fails, its lines keep their stream's label.
fn with_speakers(job: &Job, lines: &[Line]) -> Vec<Line> {
  let mut lines = lines.to_vec();
  let Some(root) = speech::models_root() else { return lines };
  if !ready(&root) { log::info!("meeting: the speaker models aren’t downloaded yet, so lines are labelled by stream"); return lines; }
  emit(saving_payload(job, "Working out who said what"));
  let wanted: Vec<Source> = SOURCES.into_iter().filter(|source| job.len(*source) > 0 && lines.iter().any(|line| line.source == *source && !line.text.trim().is_empty())).collect();
  let one = |source: Source| -> Option<Vec<Turn>> {
    let pcm = match job.spool.read(source, 0, job.len(source) as usize) { Ok(pcm) => pcm, Err(e) => { log::warn!("meeting: couldn’t read the {source:?} stream for speakers: {e}"); return None; } };
    let began = Instant::now();
    match diarize(&root, &pcm) {
      Ok(turns) => {
        let voices = turns.iter().map(|turn| turn.speaker).collect::<std::collections::HashSet<_>>().len();
        log::info!("meeting: {source:?} stream: {voices} voice(s) in {} turns, {:.1}s", turns.len(), began.elapsed().as_secs_f32());
        Some(turns)
      }
      Err(e) => { log::warn!("meeting: speakers in the {source:?} stream: {e}"); None }
    }
  };
  let together = wanted.len() > 1 && wanted.iter().all(|source| job.len(*source) < 2 * 3600 * RATE as u64);
  let heard: Vec<(Source, Option<Vec<Turn>>)> = if together {
    std::thread::scope(|scope| {
      let threads: Vec<_> = wanted.iter().map(|&source| scope.spawn(move || (source, one(source)))).collect();
      threads.into_iter().filter_map(|thread| thread.join().ok()).collect()
    })
  } else { wanted.iter().map(|&source| (source, one(source))).collect() };
  for (source, turns) in heard { if let Some(turns) = turns { assign_speakers(&mut lines, source, &turns); } }
  lines
}

/// "1 part" or "3 parts".
fn parts(n: usize) -> String { if n == 1 { "1 part".into() } else { format!("{n} parts") } }

/// Saves the meeting, and answers what the pill and Settings hear. A recording with audio Whisper
/// couldn't read is kept, so it can be tried again; nothing is deleted that wasn't transcribed.
fn finish(job: &Job, at: &Progress, recovered: bool) -> serde_json::Value {
  let id = job.spool.id();
  let settings = settings::get();
  let problem = job.problem.lock().unwrap_or_else(|e| e.into_inner()).clone();
  let said = at.lines.iter().any(|line| !line.text.trim().is_empty());
  if !said && at.gaps.is_empty() {
    job.spool.remove();
    return json!({ "state": "error", "id": id, "message": problem.unwrap_or_else(|| "Nothing was said, so there’s nothing to save".into()) });
  }
  if !said { return json!({ "state": "error", "id": id, "message": "Couldn’t transcribe the meeting.", "leftover": id }); }
  let kept = (!at.gaps.is_empty()).then(|| format!("{} not transcribed. The audio is kept.", parts(at.gaps.len())));
  let outcome = |path: &str, kept: Option<String>| {
    let message = [problem.as_ref().map(|problem| format!("{problem}.")), kept].into_iter().flatten().collect::<Vec<_>>().join(" ");
    let mut outcome = json!({ "state": "saved", "id": id, "path": path });
    if !message.is_empty() { outcome["message"] = message.into(); }
    if !at.gaps.is_empty() { outcome["leftover"] = id.clone().into(); }
    outcome
  };
  // Tried again and nothing more came through: the file saved before stands.
  if let Some(path) = job.spool.header.saved.as_deref().filter(|_| !recovered) {
    return outcome(path, Some(format!("{} still not transcribed. The audio is kept.", parts(at.gaps.len()))));
  }
  let lines = if settings.meetings.speakers { with_speakers(job, &at.lines) } else { at.lines.clone() };
  let (markdown, plain) = transcript(&lines, &at.gaps, &settings.meetings.you, &settings.meetings.others);
  let claude = settings.claude.enabled && settings.meetings.summarize;
  if claude { emit(saving_payload(job, "Writing the summary")); }
  let summary = if claude { ai::summarize(ai::Kind::Meeting, &plain) } else { None };
  let title = if claude { ai::title(&plain) } else { None }.map(|title| title.trim().to_owned()).filter(|title| !title.is_empty())
    .unwrap_or_else(|| untitled(&job.spool.header.stamp));
  let length = SOURCES.iter().map(|source| job.len(*source)).max().unwrap_or(0);
  let body = document(&dateline(&job.spool.header.stamp, length), summary.as_deref(), &markdown);
  match notes::save_markdown(notes::Kind::Meeting, &title, &body, &job.spool.header.stamp, &[("duration".into(), clock(length))]) {
    Ok(path) => {
      if at.gaps.is_empty() { job.spool.remove(); } else { job.spool.mark_saved(&path); }
      outcome(&path.display().to_string(), kept)
    }
    // The spool stays: the recording can be saved again from the pill or Settings.
    Err(e) => {
      log::warn!("meeting: couldn’t save: {e}");
      json!({ "state": "error", "id": id, "message": "Couldn’t write to the meetings folder.", "leftover": id })
    }
  }
}

// ---------- what the pill and Settings ask for ----------

/// A recording kept until someone chooses, newest first: a meeting the app stopped before it was saved,
/// or one `saved` with audio Whisper couldn't read.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leftover { id: String, since_ms: u64, seconds: u64, saved: bool }

fn leftovers(root: &Path, busy: &[String]) -> Vec<Leftover> {
  let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
  let mut found: Vec<Leftover> = entries.filter_map(|entry| {
    let dir = entry.ok()?.path();
    let spool = Spool::open(&dir)?;
    if busy.contains(&spool.id()) { return None; }
    let samples = SOURCES.iter().map(|source| spool.samples(*source)).max().unwrap_or(0);
    // Under a second and no words: nothing to keep.
    if samples < RATE as u64 && spool.progress().lines.is_empty() { spool.remove(); return None; }
    Some(Leftover { id: spool.id(), since_ms: spool.header.since_ms, seconds: samples / RATE as u64, saved: spool.header.saved.is_some() })
  }).collect();
  found.sort_by_key(|leftover| std::cmp::Reverse(leftover.since_ms));
  found
}

/// Recordings that aren't leftovers: the one recording and those being saved.
fn busy(meetings: &Meetings) -> Vec<String> {
  meetings.recording.iter().map(|job| job.spool.id()).chain(meetings.finishing.iter().cloned()).collect()
}

/// A meeting recording or being saved, which a restart for an update waits for.
pub(crate) fn in_progress() -> bool { !busy(&state()).is_empty() }

/// What the pill shows when the overlay loads, and what Settings shows: the meeting recording, those
/// being saved, the recordings kept, and whether macOS lets the Mac's sound be recorded.
#[tauri::command]
pub fn meeting_state() -> serde_json::Value {
  let meetings = state();
  let job = meetings.recording.as_deref();
  let closing = job.is_some_and(|job| job.closing.load(Ordering::SeqCst));
  let recording = job.filter(|_| !closing).map(recording_payload);
  let busy = busy(&meetings);
  // A meeting told to stop is saving, though it still takes its last buffers.
  let finishing: Vec<String> = job.filter(|_| closing).map(|job| job.spool.id()).into_iter().chain(meetings.finishing.iter().cloned()).collect();
  drop(meetings);
  let leftovers = ROOT.get().map(|root| leftovers(root, &busy)).unwrap_or_default();
  let permission = match unsafe { dictate_meeting_permission() } { -1 => "unsupported", 1 => "allowed", 2 => "denied", _ => "notDetermined" };
  json!({ "recording": recording, "saving": finishing, "leftovers": leftovers, "systemAudio": permission })
}

/// Saves (`save`) or discards a recording that was kept. Saving one already saved with gaps tries the
/// gaps again.
#[tauri::command]
pub fn meeting_recover(id: String, save: bool) -> Result<(), String> {
  let root = ROOT.get().ok_or("Meetings aren’t ready yet. Try again in a moment.")?;
  let mut meetings = state();
  let busy = busy(&meetings);
  if !leftovers(root, &busy).iter().any(|leftover| leftover.id == id) { return Err("That recording isn’t there any more.".into()); }
  let spool = Spool::open(&root.join(&id)).ok_or("That recording isn’t there any more.")?;
  if !save {
    return fs::remove_dir_all(&spool.dir).map_err(|e| { log::warn!("meeting: couldn’t discard: {e}"); "Couldn’t discard the recording.".into() });
  }
  let job = Arc::new(Job::new(spool, false).map_err(|e| e.to_string())?);
  meetings.finishing.push(id.clone());
  drop(meetings);
  emit(saving_payload(&job, "Finishing the transcript"));
  let worker = job.clone();
  std::thread::Builder::new().name("meeting".into()).spawn(move || work(worker)).map(|_| ()).map_err(|e| {
    log::warn!("meeting: {e}");
    state().finishing.retain(|known| *known != id);
    "Couldn’t save the recording. Try again in a moment.".into()
  })
}

/// Shows a saved meeting in Finder; only files in the meetings folder.
#[tauri::command]
pub fn meeting_reveal(path: String) -> Result<(), String> {
  let dir = notes::meetings_dir()?.canonicalize().map_err(|e| e.to_string())?;
  let file = PathBuf::from(path).canonicalize().map_err(|_| "That meeting isn’t there any more.")?;
  if !file.starts_with(&dir) { return Err("That file isn’t a meeting.".into()); }
  std::process::Command::new("/usr/bin/open").arg("-R").arg(file).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens Privacy & Security where System Audio Recording is allowed.
#[tauri::command]
pub fn meeting_privacy() -> Result<(), String> {
  std::process::Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    .spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn line(source: Source, seconds: f64, text: &str) -> Line {
    let start = (seconds * RATE as f64) as u64;
    Line { source, start, end: start + 2 * RATE as u64, text: text.into(), speaker: None }
  }

  #[test]
  fn a_meeting_claude_didnt_name_is_called_for_when_it_began() {
    let stamp = "2026-11-02 14.05";
    assert_eq!(untitled(stamp), "Meeting 2026-11-02 14.05");
    // The default template keeps it whole in the file name.
    assert_eq!(notes::file_stem("{date} {title}", &untitled(stamp), notes::stamp(stamp).unwrap()), "2026-11-02 Meeting 2026-11-02 14.05");
  }

  fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-meeting-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
  }

  #[test]
  fn the_spool_keeps_audio_and_pieces_through_a_crash() {
    let root = temp("spool");
    let spool = Spool::create(&root, Header { stamp: "2026-11-02 14.05".into(), since_ms: 1_700, saved: None }).unwrap();
    let mut mic = spool.writer(Source::Mic).unwrap();
    mic.write_all(&pcm16(&[0.0, 0.5, -0.5, 1.5])).unwrap();
    assert_eq!(spool.samples(Source::Mic), 4);
    assert_eq!(spool.samples(Source::System), 0);
    let back = spool.read(Source::Mic, 1, 3).unwrap();
    assert!((back[0] - 0.5).abs() < 1e-3 && (back[1] + 0.5).abs() < 1e-3 && (back[2] - 1.0).abs() < 1e-3);

    spool.record(&Piece { source: Source::Mic, from: 0, done: 4, lines: vec![line(Source::Mic, 0.0, "Hello.")], failed: false }).unwrap();
    // A crash in the middle of writing the next piece, then a later one.
    OpenOptions::new().append(true).open(spool.dir.join("pieces.jsonl")).unwrap().write_all(b"{\"source\":\"system\",\"do").unwrap();
    spool.record(&Piece { source: Source::System, from: 0, done: 9, lines: vec![line(Source::System, 0.2, "Hi.")], failed: false }).unwrap();
    let again = Spool::open(&spool.dir).unwrap();
    assert_eq!(again.header.stamp, "2026-11-02 14.05");
    let at = again.progress();
    assert_eq!(at.done, [4, 9]);
    assert!(at.gaps.is_empty());
    assert_eq!(at.lines.iter().map(|line| line.text.as_str()).collect::<Vec<_>>(), ["Hello.", "Hi."]);

    // A recording left behind is offered back; one with nothing in it is cleared away.
    Spool::create(&root, Header { stamp: "2026-11-02 15.00".into(), since_ms: 2_000, saved: None }).unwrap();
    let found = leftovers(&root, &[]);
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].id.as_str(), found[0].since_ms, found[0].saved), ("1700", 1_700, false));
    // Saved with gaps, it is still kept, and says so.
    spool.mark_saved(Path::new("/tmp/2026-11-02 14.05 Meeting.md"));
    assert_eq!(Spool::open(&spool.dir).unwrap().header.saved.as_deref(), Some("/tmp/2026-11-02 14.05 Meeting.md"));
    assert!(leftovers(&root, &[])[0].saved);
    assert!(!root.join("2000").exists());
    assert!(leftovers(&root, &["1700".into()]).is_empty());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn a_stalled_stream_is_padded_to_the_meetings_clock() {
    let root = temp("clock");
    let job = Job::new(Spool::create(&root, Header { stamp: "2026-11-02 14.05".into(), since_ms: 1, saved: None }).unwrap(), true).unwrap();
    let job = Job { started: Instant::now() - Duration::from_secs(5), ..job };
    let seconds = |samples: u64| samples as f64 / RATE as f64;
    // A microphone slow to open: its first buffer lands where it was captured.
    job.append(Source::System, &[0.1; 1600], 2.0);
    assert!((2.99..3.1).contains(&seconds(job.len(Source::System) - 1600)), "{}", job.len(Source::System));
    assert_eq!(job.spool.samples(Source::System), job.len(Source::System));
    // Buffers that queued up behind others arrive late, but they are not a stall.
    let len = job.len(Source::System);
    job.append(Source::System, &[0.1; 1600], 1.9);
    assert_eq!(job.len(Source::System), len + 1600);
    // A stall of under two seconds (the output device switching) is filled as well.
    job.append(Source::System, &[0.1; 1600], 0.0);
    assert!((4.99..5.1).contains(&seconds(job.len(Source::System) - 1600)), "{}", job.len(Source::System));
    // On time: nothing added.
    let len = job.len(Source::System);
    job.append(Source::System, &[0.1; 1600], 0.0);
    assert_eq!(job.len(Source::System), len + 1600);
    // The other stream, captured alongside, lines up with it.
    job.append(Source::Mic, &[0.1; 1600], 0.0);
    assert!(job.len(Source::System).abs_diff(job.len(Source::Mic) + 1600) < RATE as u64 / 20);
    job.end();
    assert!(job.writers.lock().unwrap().0.iter().all(Option::is_none));
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn audio_whisper_couldnt_read_is_a_gap_until_a_later_try_fills_it() {
    let root = temp("gaps");
    let spool = Spool::create(&root, Header { stamp: "2026-11-02 14.05".into(), since_ms: 3, saved: None }).unwrap();
    let piece = |source, from, done, text: Option<&str>| Piece {
      source, from, done, failed: text.is_none(),
      lines: text.map(|text| vec![Line { source, start: from, end: done, text: text.into(), speaker: None }]).unwrap_or_default(),
    };
    spool.record(&piece(Source::Mic, 0, 100, Some("one"))).unwrap();
    spool.record(&piece(Source::Mic, 100, 400, None)).unwrap();
    spool.record(&piece(Source::Mic, 400, 500, Some("three"))).unwrap();
    // A piece the spool missed leaves its audio without a transcript too.
    spool.record(&piece(Source::System, 50, 90, Some("hi"))).unwrap();
    let at = spool.progress();
    assert_eq!(at.done, [500, 90]);
    assert_eq!(at.gaps, [Gap { source: Source::Mic, from: 100, to: 400 }, Gap { source: Source::System, from: 0, to: 50 }]);
    // Tried again, the start of the gap comes through: the rest is still a gap.
    spool.record(&piece(Source::Mic, 100, 250, Some("two"))).unwrap();
    // The same piece twice (a crash after keeping it) counts once.
    spool.record(&piece(Source::Mic, 100, 250, Some("two"))).unwrap();
    let at = spool.progress();
    assert_eq!(at.gaps, [Gap { source: Source::System, from: 0, to: 50 }, Gap { source: Source::Mic, from: 250, to: 400 }]);
    assert_eq!(at.lines.iter().map(|line| line.text.as_str()).collect::<Vec<_>>(), ["one", "three", "hi", "two"]);
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn a_recording_with_gaps_is_never_thrown_away() {
    let root = temp("finish");
    let job = Job::new(Spool::create(&root, Header { stamp: "2026-11-02 14.05".into(), since_ms: 4, saved: None }).unwrap(), false).unwrap();
    // Whisper couldn't read any of it: nothing is saved, and nothing is deleted.
    let at = Progress { done: [16000, 0], lines: Vec::new(), gaps: vec![Gap { source: Source::Mic, from: 0, to: 16000 }] };
    let outcome = finish(&job, &at, false);
    assert_eq!((outcome["state"].as_str(), outcome["leftover"].as_str()), (Some("error"), Some("4")));
    assert_eq!(outcome["message"], "Couldn’t transcribe the meeting.");
    assert!(job.spool.dir.exists());
    // Tried again after a save with gaps, and still nothing: the saved file stands.
    let saved = Job { spool: Spool { header: Header { saved: Some("/x/2026-11-02 14.05 Meeting.md".into()), ..job.spool.header.clone() }, dir: job.spool.dir.clone() }, ..Job::new(Spool::open(&job.spool.dir).unwrap(), false).unwrap() };
    let at = Progress { lines: vec![line(Source::Mic, 0.0, "Hello.")], ..at };
    let outcome = finish(&saved, &at, false);
    assert_eq!((outcome["state"].as_str(), outcome["path"].as_str()), (Some("saved"), Some("/x/2026-11-02 14.05 Meeting.md")));
    assert_eq!(outcome["message"], "1 part still not transcribed. The audio is kept.");
    assert!(job.spool.dir.exists());
    // Only silence: the recording goes.
    let outcome = finish(&job, &Progress::default(), false);
    assert_eq!(outcome["message"], "Nothing was said, so there’s nothing to save");
    assert!(outcome.get("leftover").is_none());
    assert!(!job.spool.dir.exists());
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn a_failed_write_leaves_whole_samples_and_stops_the_stream() {
    let root = temp("write");
    let job = Job::new(Spool::create(&root, Header { stamp: "2026-11-02 14.05".into(), since_ms: 5, saved: None }).unwrap(), true).unwrap();
    job.append(Source::Mic, &[0.1; 1600], 0.0);
    let len = job.len(Source::Mic);
    // A read-only handle in place of the stream's file: the next write fails.
    job.writers.lock().unwrap().0[0] = Some(File::open(job.spool.dir.join(file(Source::Mic))).unwrap());
    job.stopping.store(true, Ordering::SeqCst); // no app to stop in a test
    job.append(Source::Mic, &[0.1; 1600], 0.0);
    assert_eq!(job.len(Source::Mic), len);
    assert_eq!(job.spool.samples(Source::Mic), len);
    assert!(job.writers.lock().unwrap().0[0].is_none());
    assert_eq!(job.problem.lock().unwrap().as_deref(), Some("Couldn’t save the meeting’s audio, so it stopped"));
    job.append(Source::Mic, &[0.1; 1600], 0.0); // nothing more on this stream
    assert_eq!(job.len(Source::Mic), len);
    job.end();
    fs::remove_dir_all(root).unwrap();
  }
}
