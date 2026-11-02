//! Meetings: the microphone and the Mac's own sound recorded together (meeting_audio.m), transcribed a
//! piece at a time while the meeting runs, and saved as one Markdown file with who said what.
//!
//! Nothing waits in memory alone. Every sample goes to a spool folder in the app data dir as it arrives,
//! and every transcribed piece is appended there too, so a crash or a quit loses nothing: the next
//! launch offers to save what the spool holds.
use std::ffi::{c_char, CStr};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use crate::{ai, notes, settings, speech};

const RATE: usize = 16000;
/// The longest piece transcribed at once: inside Whisper's 30 s window.
const PIECE: usize = 25 * RATE;
/// A pause ends a piece once it holds this much, so pieces are sentences rather than single words.
const ENOUGH: usize = 8 * RATE;
/// Loudness is measured over 30 ms frames...
const FRAME: usize = RATE * 3 / 100;
/// ...and half a second of quiet ones is a pause.
const PAUSE: usize = 17;
/// A meeting left running stops here, before its spool fills the disk.
const LONGEST: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source { Mic, System }
const SOURCES: [Source; 2] = [Source::Mic, Source::System];
impl Source {
  fn index(self) -> usize { self as usize }
  fn file(self) -> &'static str { match self { Self::Mic => "mic.pcm", Self::System => "system.pcm" } }
}

/// Words heard in one stream, `start` and `end` in samples from the start of the meeting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line { pub source: Source, pub start: u64, pub end: u64, pub text: String }

/// One transcribed piece as the spool keeps it: its stream is transcribed up to `done` samples.
#[derive(Debug, Serialize, Deserialize)]
struct Piece { source: Source, done: u64, lines: Vec<Line> }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header { stamp: String, since_ms: u64 }

// ---------- pieces: where to cut, and whether anyone spoke ----------

fn levels(pcm: &[f32]) -> Vec<f32> {
  pcm.chunks(FRAME).map(|frame| (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt()).collect()
}

/// What counts as quiet and as a voice in `levels`: measured against the quietest stretch, so a
/// humming room and digital silence both work, within bounds so a window of nothing but speech still
/// has pauses.
fn thresholds(levels: &[f32]) -> (f32, f32) {
  let mut sorted = levels.to_vec();
  sorted.sort_by(f32::total_cmp);
  let floor = sorted.get(sorted.len() / 10).copied().unwrap_or(0.0);
  let quiet = (floor * 2.0).clamp(0.002, 0.012);
  (quiet, (quiet * 1.5).max(0.005))
}

/// Where to cut the untranscribed `pcm` (at most PIECE samples): at the last pause that closes a piece
/// of at least ENOUGH. A full window with no such pause is cut at its quietest moment near the end.
/// `last` means `pcm` is all that is left of a meeting that has ended: it goes whole. None while the
/// piece is still being said.
pub(crate) fn cut(pcm: &[f32], last: bool) -> Option<usize> {
  if pcm.is_empty() { return None; }
  if last && pcm.len() <= PIECE { return Some(pcm.len()); }
  let levels = levels(pcm);
  let (quiet, _) = thresholds(&levels);
  let mut at = None;
  let mut run = 0;
  for (i, level) in levels.iter().enumerate() {
    run = if *level < quiet { run + 1 } else { 0 };
    let closes = i + 1 == levels.len() || levels[i + 1] >= quiet;
    if run >= PAUSE && closes {
      // In the middle of a pause; one still going at the end keeps a moment for a word starting.
      let frame = if i + 1 == levels.len() { i + 1 - PAUSE / 2 } else { i + 1 - run / 2 };
      if frame * FRAME >= ENOUGH { at = Some(frame * FRAME); }
    }
  }
  if at.is_some() { return at; }
  if pcm.len() < PIECE { return None; }
  let from = (pcm.len() - 6 * RATE) / FRAME;
  let quietest = (from..levels.len()).min_by(|a, b| levels[*a].total_cmp(&levels[*b]))?;
  Some((quietest * FRAME).max(ENOUGH))
}

/// Whether `pcm` holds a third of a second of voice: Whisper invents words for silence and hum.
pub(crate) fn has_voice(pcm: &[f32]) -> bool {
  let levels = levels(pcm);
  let (_, voice) = thresholds(&levels);
  levels.iter().filter(|level| **level >= voice).count() >= 10
}

// ---------- the transcript and the file ----------

/// `samples` into the meeting as HH:MM:SS.
pub(crate) fn clock(samples: u64) -> String {
  let seconds = samples / RATE as u64;
  format!("{:02}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
}

/// A speaker label that stays one bold word in Markdown, whatever was typed in Settings.
fn label(name: &str, fallback: &str) -> String {
  let clean = name.replace(['*', '_', '`', '[', ']'], " ").split_whitespace().collect::<Vec<_>>().join(" ");
  if clean.is_empty() { fallback.to_owned() } else { clean }
}

/// Both streams' lines in the order they were said: one paragraph per turn, a speaker's lines that
/// follow on within two seconds joined up to a minute long. Answers the Markdown (`**You** 00:01:23
/// words`) and a plain version for Claude (`You 00:01:23: words`).
pub(crate) fn transcript(lines: &[Line], you: &str, others: &str) -> (String, String) {
  let mut lines: Vec<&Line> = lines.iter().filter(|line| !line.text.trim().is_empty()).collect();
  lines.sort_by_key(|line| (line.start, line.source.index()));
  let mut turns: Vec<(Source, u64, u64, String)> = Vec::new();
  for line in lines {
    let text = line.text.trim();
    match turns.last_mut() {
      Some((source, start, end, words)) if *source == line.source && line.start <= *end + 2 * RATE as u64 && line.start < *start + 60 * RATE as u64 => {
        words.push(' ');
        words.push_str(text);
        *end = (*end).max(line.end);
      }
      _ => turns.push((line.source, line.start, line.end, text.to_owned())),
    }
  }
  let (you, others) = (label(you, "You"), label(others, "Others"));
  let name = |source: Source| if source == Source::Mic { &you } else { &others };
  let markdown = turns.iter().map(|(source, start, _, words)| format!("**{}** {} {words}", name(*source), clock(*start))).collect::<Vec<_>>().join("\n\n");
  let plain = turns.iter().map(|(source, start, _, words)| format!("{} {}: {words}", name(*source), clock(*start))).collect::<Vec<_>>().join("\n");
  (markdown, plain)
}

/// The file's body under its title: Claude's summary, decisions and action items when there are any,
/// then the transcript.
pub(crate) fn document(summary: Option<&str>, transcript: &str) -> String {
  let mut body = String::new();
  if let Some(summary) = summary.map(str::trim).filter(|summary| !summary.is_empty()) {
    if !summary.starts_with('#') { body.push_str("## Summary\n\n"); }
    body.push_str(summary);
    body.push_str("\n\n");
  }
  body.push_str("## Transcript\n\n");
  body.push_str(transcript);
  body
}

// ---------- the spool ----------

/// One meeting's audio and transcribed pieces on disk: `meeting.json`, a 16-bit file per stream, and
/// `pieces.jsonl`. Removed once the meeting is saved.
struct Spool { dir: PathBuf, header: Header }

impl Spool {
  fn create(root: &Path, header: Header) -> Result<Self, String> {
    let dir = root.join(header.since_ms.to_string());
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t keep the meeting’s audio: {e}"))?;
    let mut file = File::create(dir.join("meeting.json")).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&header).map_err(|e| e.to_string())?).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    Ok(Self { dir, header })
  }

  fn open(dir: &Path) -> Option<Self> {
    let header = serde_json::from_slice(&fs::read(dir.join("meeting.json")).ok()?).ok()?;
    Some(Self { dir: dir.to_owned(), header })
  }

  fn id(&self) -> String { self.header.since_ms.to_string() }

  fn samples(&self, source: Source) -> u64 {
    fs::metadata(self.dir.join(source.file())).map_or(0, |meta| meta.len() / 2)
  }

  fn writer(&self, source: Source) -> Result<File, String> {
    OpenOptions::new().create(true).append(true).open(self.dir.join(source.file())).map_err(|e| format!("Couldn’t keep the meeting’s audio: {e}"))
  }

  fn read(&self, source: Source, from: u64, count: usize) -> Result<Vec<f32>, String> {
    let file = File::open(self.dir.join(source.file())).map_err(|e| e.to_string())?;
    let mut bytes = vec![0u8; count * 2];
    file.read_exact_at(&mut bytes, from * 2).map_err(|e| e.to_string())?;
    Ok(bytes.as_chunks::<2>().0.iter().map(|pair| i16::from_le_bytes(*pair) as f32 / 32768.0).collect())
  }

  /// How far each stream is transcribed, and every line so far. A piece cut short by a crash is
  /// skipped: its audio is still there to transcribe again.
  fn progress(&self) -> ([u64; 2], Vec<Line>) {
    let (mut done, mut lines) = ([0u64; 2], Vec::new());
    let Ok(text) = fs::read_to_string(self.dir.join("pieces.jsonl")) else { return (done, lines) };
    for piece in text.lines().filter_map(|line| serde_json::from_str::<Piece>(line).ok()) {
      let i = piece.source.index();
      if piece.done <= done[i] { continue; }
      done[i] = piece.done;
      lines.extend(piece.lines);
    }
    (done, lines)
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
  /// Why the meeting stopped early, for a meeting that ends with nothing said.
  problem: Mutex<Option<String>>,
  stopping: AtomicBool,
}

impl Job {
  fn new(spool: Spool, recording: bool) -> Result<Self, String> {
    let writers = if recording { [Some(spool.writer(Source::Mic)?), Some(spool.writer(Source::System)?)] } else { [None, None] };
    let written = SOURCES.map(|source| AtomicU64::new(spool.samples(source)));
    Ok(Self {
      spool, written, writers: Mutex::new((writers, Instant::now())), started: Instant::now(), ended: AtomicBool::new(!recording),
      system: Mutex::new("pending".into()), problem: Mutex::default(), stopping: AtomicBool::new(false),
    })
  }

  fn len(&self, source: Source) -> u64 { self.written[source.index()].load(Ordering::SeqCst) }

  fn append(&self, source: Source, pcm: &[f32]) {
    let i = source.index();
    let mut writers = self.writers.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = writers.0[i].as_mut() else { return };
    let written = self.written[i].load(Ordering::SeqCst);
    // Each stream keeps to the meeting's clock: audio that stalled (a device switching, a microphone
    // slow to open) leaves silence behind, so both streams' timestamps still line up.
    let due = (self.started.elapsed().as_secs_f64() * RATE as f64) as u64;
    let behind = due.saturating_sub(written + pcm.len() as u64);
    // Buffers that merely queued up for a moment arrive late but whole: only the start and a real stall
    // are filled.
    let gap = if written == 0 || behind > 2 * RATE as u64 { behind } else { 0 };
    let mut bytes = vec![0u8; gap as usize * 2];
    bytes.extend(pcm16(pcm));
    if let Err(e) = file.write_all(&bytes) {
      log::warn!("meeting: couldn’t write audio: {e}");
      *self.problem.lock().unwrap_or_else(|e| e.into_inner()) = Some("The disk is full, so the meeting stopped".into());
      self.written[i].store(self.spool.samples(source), Ordering::SeqCst);
      stop_soon(self);
      return;
    }
    self.written[i].fetch_add(gap + pcm.len() as u64, Ordering::SeqCst);
    // Written is safe from a crash; flushed is safe from a power cut too.
    if writers.1.elapsed() >= Duration::from_secs(5) {
      for file in writers.0.iter().flatten() { let _ = file.sync_data(); }
      writers.1 = Instant::now();
    }
    drop(writers);
    if self.started.elapsed() >= LONGEST { stop_soon(self); }
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

fn state() -> std::sync::MutexGuard<'static, Meetings> { STATE.lock().unwrap_or_else(|e| e.into_inner()) }

pub fn init(app: &AppHandle) -> Result<(), String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("meetings");
  ROOT.get_or_init(|| root);
  APP.get_or_init(|| app.clone());
  Ok(())
}

fn emit(payload: serde_json::Value) {
  if let Some(app) = APP.get() { let _ = app.emit("dictate-meeting", payload); }
}

fn recording_payload(job: &Job) -> serde_json::Value {
  json!({ "state": "recording", "id": job.spool.id(), "since": job.spool.header.since_ms, "system": *job.system.lock().unwrap_or_else(|e| e.into_inner()) })
}

extern "C" {
  fn dictate_meeting(action: *const c_char) -> bool;
  fn dictate_meeting_permission() -> i32;
}

/// Stops the recording meeting from a thread that is not the main one, once.
fn stop_soon(job: &Job) {
  if job.stopping.swap(true, Ordering::SeqCst) { return; }
  if job.started.elapsed() >= LONGEST {
    if let Some(app) = APP.get() { let _ = app.emit("dictate-notice", json!({ "message": "The meeting stopped after 4 hours and is being saved" })); }
  }
  if let Some(app) = APP.get() { let _ = app.run_on_main_thread(|| unsafe { dictate_meeting(c"stop".as_ptr()); }); }
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64) }

fn text(text: *const c_char) -> Option<String> {
  (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned())
}

/// On the main thread as a meeting starts: 1 to record the Mac's sound too, 0 for the microphone only,
/// -1 when it can't start. `stamp` is the local time as "YYYY-MM-DD HH.mm".
#[no_mangle]
extern "C" fn dictate_meeting_begin(stamp: *const c_char) -> i32 {
  let Some(root) = ROOT.get() else { return -1 };
  let Some(stamp) = text(stamp).filter(|stamp| stamp.len() == 16 && stamp.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ' ' | '.'))) else { return -1 };
  let mut meetings = state();
  if meetings.recording.is_some() { return -1; }
  let job = match Spool::create(root, Header { stamp, since_ms: now_ms() }).and_then(|spool| Job::new(spool, true)) {
    Ok(job) => Arc::new(job),
    Err(e) => {
      log::warn!("meeting: {e}");
      if let Some(app) = APP.get() { let _ = app.emit("dictate-notice", json!({ "message": e })); }
      return -1;
    }
  };
  let worker = job.clone();
  if let Err(e) = std::thread::Builder::new().name("meeting".into()).spawn(move || work(worker)) {
    log::warn!("meeting: {e}");
    job.spool.remove();
    return -1;
  }
  meetings.recording = Some(job.clone());
  drop(meetings);
  crate::meeting_changed(true);
  emit(recording_payload(&job));
  i32::from(settings::get().meetings.system_audio)
}

/// From the audio queue: 16 kHz mono samples, `source` 0 for the microphone and 1 for the Mac's sound.
#[no_mangle]
extern "C" fn dictate_meeting_audio(source: i32, samples: *const f32, count: usize) {
  let source = match source { 0 => Source::Mic, 1 => Source::System, _ => return };
  if samples.is_null() || count == 0 || count > 10 * RATE { return; }
  let Some(job) = state().recording.clone() else { return };
  // The native side owns the buffer until this synchronous call returns.
  job.append(source, unsafe { std::slice::from_raw_parts(samples, count) });
}

#[no_mangle]
extern "C" fn dictate_meeting_sources(system: *const c_char) {
  let Some(system) = text(system).filter(|system| matches!(system.as_str(), "on" | "off" | "unsupported" | "denied" | "failed")) else { return };
  let Some(job) = state().recording.clone() else { return };
  *job.system.lock().unwrap_or_else(|e| e.into_inner()) = system;
  emit(recording_payload(&job));
}

/// Every buffer of the recording meeting is in: the worker transcribes what is left and saves it.
#[no_mangle]
extern "C" fn dictate_meeting_end(problem: *const c_char) {
  let mut meetings = state();
  let Some(job) = meetings.recording.take() else { return };
  meetings.finishing.push(job.spool.id());
  drop(meetings);
  if let Some(problem) = text(problem) { job.problem.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(problem); }
  crate::meeting_changed(false);
  emit(json!({ "state": "saving", "id": job.spool.id(), "since": job.spool.header.since_ms, "message": "Finishing the transcript" }));
  job.end();
}

// ---------- transcribing while the meeting runs ----------

enum Trouble { Interrupted, Waiting(&'static str), Unreadable }

fn transcribe(pcm: &[f32]) -> Result<Vec<speech::Segment>, Trouble> {
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
  speech::transcribe_piece(pcm, options).map_err(|error| match error.as_str() {
    speech::INTERRUPTED => Trouble::Interrupted,
    "Voice is off" => Trouble::Waiting("Turn voice back on to finish the transcript"),
    "Couldn’t understand that" => Trouble::Unreadable,
    _ => {
      log::warn!("meeting: a piece waits: {error}");
      Trouble::Waiting("Waiting for voice to finish the transcript")
    }
  })
}

/// The next piece of `source`, if one is ready: true once it is transcribed and kept.
fn step(job: &Job, source: Source, done: &mut [u64; 2], lines: &mut Vec<Line>, failures: &mut [u32; 2]) -> Result<bool, Trouble> {
  let i = source.index();
  let len = job.len(source);
  if done[i] >= len { return Ok(false); }
  let left = (len - done[i]) as usize;
  let pcm = job.spool.read(source, done[i], left.min(PIECE)).map_err(|e| { log::warn!("meeting: {e}"); Trouble::Waiting("Waiting for voice to finish the transcript") })?;
  let Some(at) = cut(&pcm, job.ended.load(Ordering::SeqCst) && left <= PIECE) else { return Ok(false) };
  let piece = &pcm[..at];
  let heard = if has_voice(piece) {
    match transcribe(piece) {
      Ok(heard) => heard,
      // A piece Whisper can't read, three times over, doesn't hold up the rest of the meeting.
      Err(Trouble::Unreadable) if failures[i] >= 2 => { log::warn!("meeting: a piece was not transcribed"); Vec::new() }
      Err(Trouble::Unreadable) => { failures[i] += 1; return Err(Trouble::Interrupted); }
      Err(trouble) => return Err(trouble),
    }
  } else { Vec::new() };
  failures[i] = 0;
  let base = done[i];
  let found: Vec<Line> = heard.into_iter().map(|segment| Line { source, start: base + segment.start as u64, end: base + segment.end as u64, text: segment.text }).collect();
  done[i] = base + at as u64;
  // The lines are kept in memory either way; a piece the spool missed is transcribed again after a crash.
  if let Err(e) = job.spool.record(&Piece { source, done: done[i], lines: found.clone() }) { log::warn!("meeting: couldn’t keep a piece: {e}"); }
  lines.extend(found);
  Ok(true)
}

/// A meeting's worker: pieces while it records, the rest once it ends, then the file.
fn work(job: Arc<Job>) {
  let (mut done, mut lines) = job.spool.progress();
  let mut failures = [0u32; 2];
  let mut told = None;
  loop {
    let ended = job.ended.load(Ordering::SeqCst);
    let mut moved = false;
    let mut waiting = None;
    for source in SOURCES {
      match step(&job, source, &mut done, &mut lines, &mut failures) {
        Ok(stepped) => moved |= stepped,
        Err(Trouble::Interrupted) => {}
        Err(Trouble::Waiting(why)) => waiting = Some(why),
        Err(Trouble::Unreadable) => {}
      }
    }
    if ended && SOURCES.iter().all(|source| done[source.index()] >= job.len(*source)) { break; }
    if ended && waiting.is_some() && waiting != told {
      told = waiting;
      emit(json!({ "state": "saving", "id": job.spool.id(), "since": job.spool.header.since_ms, "message": waiting }));
    }
    if !moved { std::thread::sleep(if waiting.is_some() { Duration::from_secs(2) } else if ended { Duration::from_millis(100) } else { Duration::from_millis(700) }); }
  }
  finish(&job, &lines);
  state().finishing.retain(|id| *id != job.spool.id());
}

fn finish(job: &Job, lines: &[Line]) {
  let id = job.spool.id();
  let settings = settings::get();
  let (markdown, plain) = transcript(lines, &settings.meetings.you, &settings.meetings.others);
  if markdown.is_empty() {
    job.spool.remove();
    let problem = job.problem.lock().unwrap_or_else(|e| e.into_inner()).clone();
    emit(json!({ "state": "error", "id": id, "message": problem.unwrap_or_else(|| "Nothing was said, so there’s nothing to save".into()) }));
    return;
  }
  let claude = settings.claude.enabled && settings.meetings.summarize;
  if claude { emit(json!({ "state": "saving", "id": id, "since": job.spool.header.since_ms, "message": "Writing the summary" })); }
  let summary = if claude { ai::summarize(ai::Kind::Meeting, &plain) } else { None };
  let title = if claude { ai::title(&plain) } else { None }.map(|title| title.trim().to_owned()).filter(|title| !title.is_empty())
    .unwrap_or_else(|| format!("Meeting {}", job.spool.header.stamp));
  let length = SOURCES.iter().map(|source| job.len(*source)).max().unwrap_or(0);
  let saved = notes::save_markdown(notes::Kind::Meeting, &title, &document(summary.as_deref(), &markdown), &job.spool.header.stamp, &[("duration".into(), clock(length))]);
  match saved {
    Ok(path) => {
      job.spool.remove();
      emit(json!({ "state": "saved", "id": id, "path": path.display().to_string() }));
    }
    // The spool stays: the recording can be saved again from the pill or Settings.
    Err(e) => emit(json!({ "state": "error", "id": id, "message": format!("{e}."), "leftover": id })),
  }
}

// ---------- what the pill and Settings ask for ----------

/// A meeting the app stopped before it was saved, newest first.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leftover { id: String, since_ms: u64, seconds: u64 }

fn leftovers(root: &Path, busy: &[String]) -> Vec<Leftover> {
  let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
  let mut found: Vec<Leftover> = entries.filter_map(|entry| {
    let dir = entry.ok()?.path();
    let spool = Spool::open(&dir)?;
    if busy.contains(&spool.id()) { return None; }
    let samples = SOURCES.iter().map(|source| spool.samples(*source)).max().unwrap_or(0);
    // Under a second and no words: nothing to keep.
    if samples < RATE as u64 && spool.progress().1.is_empty() { spool.remove(); return None; }
    Some(Leftover { id: spool.id(), since_ms: spool.header.since_ms, seconds: samples / RATE as u64 })
  }).collect();
  found.sort_by_key(|leftover| std::cmp::Reverse(leftover.since_ms));
  found
}

fn busy(meetings: &Meetings) -> Vec<String> {
  meetings.recording.iter().map(|job| job.spool.id()).chain(meetings.finishing.iter().cloned()).collect()
}

/// What the pill shows when the overlay loads, and what Settings shows: the meeting recording, those
/// being saved, the ones a crash or quit left, and whether macOS lets the Mac's sound be recorded.
#[tauri::command]
pub fn meeting_state() -> serde_json::Value {
  let meetings = state();
  let recording = meetings.recording.as_deref().map(recording_payload);
  let busy = busy(&meetings);
  let finishing = meetings.finishing.clone();
  drop(meetings);
  let leftovers = ROOT.get().map(|root| leftovers(root, &busy)).unwrap_or_default();
  let permission = match unsafe { dictate_meeting_permission() } { -1 => "unsupported", 1 => "allowed", 2 => "denied", _ => "notDetermined" };
  json!({ "recording": recording, "saving": finishing, "leftovers": leftovers, "systemAudio": permission })
}

/// Saves (`save`) or discards a meeting that was left unsaved.
#[tauri::command]
pub fn meeting_recover(id: String, save: bool) -> Result<(), String> {
  let root = ROOT.get().ok_or("Meetings are unavailable")?;
  let mut meetings = state();
  let busy = busy(&meetings);
  if !leftovers(root, &busy).iter().any(|leftover| leftover.id == id) { return Err("That recording is gone".into()); }
  let spool = Spool::open(&root.join(&id)).ok_or("That recording is gone")?;
  if !save {
    return fs::remove_dir_all(&spool.dir).map_err(|e| format!("Couldn’t discard the recording: {e}"));
  }
  let job = Arc::new(Job::new(spool, false)?);
  meetings.finishing.push(id.clone());
  drop(meetings);
  emit(json!({ "state": "saving", "id": id, "since": job.spool.header.since_ms, "message": "Finishing the transcript" }));
  let worker = job.clone();
  std::thread::Builder::new().name("meeting".into()).spawn(move || work(worker)).map(|_| ()).map_err(|e| {
    state().finishing.retain(|known| *known != id);
    e.to_string()
  })
}

/// Shows a saved meeting in Finder; only files in the meetings folder.
#[tauri::command]
pub fn meeting_reveal(path: String) -> Result<(), String> {
  let dir = notes::meetings_dir()?.canonicalize().map_err(|e| e.to_string())?;
  let file = PathBuf::from(path).canonicalize().map_err(|_| "The meeting has moved")?;
  if !file.starts_with(&dir) { return Err("Not a meeting".into()); }
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
    Line { source, start, end: start + 2 * RATE as u64, text: text.into() }
  }

  /// Speech-like audio for `seconds`, or silence with a little hiss.
  fn audio(parts: &[(bool, f64)]) -> Vec<f32> {
    parts.iter().flat_map(|&(speech, seconds)| (0..(seconds * RATE as f64) as usize).map(move |i| {
      if speech { 0.2 * (i as f32 * 0.07).sin() } else { 0.0004 * (i as f32 * 1.3).sin() }
    })).collect()
  }

  #[test]
  fn the_clock_reads_hours_minutes_and_seconds() {
    assert_eq!(clock(0), "00:00:00");
    assert_eq!(clock(83 * 16000 + 15999), "00:01:23");
    assert_eq!(clock((3600 * 2 + 61) * 16000), "02:01:01");
  }

  #[test]
  fn lines_merge_by_time_into_turns() {
    let lines = [
      line(Source::System, 4.0, "Hi, can you hear me?"),
      line(Source::Mic, 0.5, "Hello."),
      line(Source::Mic, 9.0, "Yes, loud and clear."),
      line(Source::Mic, 11.5, "Shall we start?"), // follows on: the same turn
      line(Source::System, 13.0, " "),             // nothing said
      line(Source::Mic, 30.0, "Then the budget."),  // a pause: a new turn
    ];
    let (markdown, plain) = transcript(&lines, "Can", "Others");
    assert_eq!(markdown, "**Can** 00:00:00 Hello.\n\n**Others** 00:00:04 Hi, can you hear me?\n\n**Can** 00:00:09 Yes, loud and clear. Shall we start?\n\n**Can** 00:00:30 Then the budget.");
    assert_eq!(plain.lines().next(), Some("Can 00:00:00: Hello."));
    // Same moment: the microphone first, every time.
    let (tie, _) = transcript(&[line(Source::System, 1.0, "b"), line(Source::Mic, 1.0, "a")], "You", "Others");
    assert_eq!(tie, "**You** 00:00:01 a\n\n**Others** 00:00:01 b");
  }

  #[test]
  fn a_long_turn_starts_a_new_line_each_minute_and_labels_stay_bold() {
    let lines: Vec<Line> = (0..40).map(|i| line(Source::Mic, i as f64 * 2.0, "word")).collect();
    let (markdown, _) = transcript(&lines, "**Me**", "  ");
    let turns: Vec<&str> = markdown.split("\n\n").collect();
    assert_eq!(turns.len(), 2);
    assert!(turns[0].starts_with("**Me** 00:00:00 word word"));
    assert!(turns[1].starts_with("**Me** 00:01:00 word"));
    let (others, _) = transcript(&[line(Source::System, 0.0, "hi")], "You", " ** ");
    assert_eq!(others, "**Others** 00:00:00 hi");
  }

  #[test]
  fn the_file_has_the_summary_then_the_transcript() {
    let transcript = "**You** 00:00:00 Hello.";
    assert_eq!(document(None, transcript), "## Transcript\n\n**You** 00:00:00 Hello.");
    assert_eq!(document(Some("  "), transcript), "## Transcript\n\n**You** 00:00:00 Hello.");
    let summary = "## Summary\n\nWe met.\n\n## Decisions\n\n- Ship it\n\n## Action items\n\n- [ ] Can: write it up\n";
    assert_eq!(document(Some(summary), transcript), format!("{}\n\n## Transcript\n\n{transcript}", summary.trim()));
    assert!(document(Some("We met."), transcript).starts_with("## Summary\n\nWe met.\n\n## Transcript"));
  }

  #[test]
  fn pieces_are_cut_at_pauses_once_long_enough() {
    // Still talking, or a pause too early: wait.
    assert_eq!(cut(&audio(&[(true, 6.0)]), false), None);
    assert_eq!(cut(&audio(&[(true, 3.0), (false, 1.0), (true, 3.0)]), false), None);
    // A pause after 9 s of speech ends the piece in its middle.
    let at = cut(&audio(&[(true, 9.0), (false, 1.0), (true, 2.0)]), false).unwrap();
    assert!((9 * RATE..10 * RATE).contains(&at), "{at}");
    // The last pause that fits wins.
    let at = cut(&audio(&[(true, 9.0), (false, 1.0), (true, 5.0), (false, 1.0), (true, 1.0)]), false).unwrap();
    assert!((15 * RATE..16 * RATE).contains(&at), "{at}");
    // A pause still going at the end keeps a moment for the next word.
    let at = cut(&audio(&[(true, 9.0), (false, 1.0)]), false).unwrap();
    assert!((9 * RATE + 4000..10 * RATE).contains(&at), "{at}");
    // 25 s without a pause is cut anyway, inside the window.
    let at = cut(&audio(&[(true, 25.0)]), false).unwrap();
    assert!((ENOUGH..=PIECE).contains(&at), "{at}");
    // The end of a finished meeting goes whole.
    assert_eq!(cut(&audio(&[(true, 3.0)]), true), Some(3 * RATE));
    assert_eq!(cut(&[], true), None);
  }

  #[test]
  fn only_audio_with_a_voice_is_transcribed() {
    assert!(!has_voice(&audio(&[(false, 10.0)])));
    assert!(!has_voice(&vec![0.0; 5 * RATE]));
    assert!(has_voice(&audio(&[(false, 5.0), (true, 0.5), (false, 5.0)])));
    assert!(!has_voice(&audio(&[(false, 5.0), (true, 0.1), (false, 5.0)])));
  }

  fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-meeting-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
  }

  #[test]
  fn the_spool_keeps_audio_and_pieces_through_a_crash() {
    let root = temp("spool");
    let spool = Spool::create(&root, Header { stamp: "2026-11-02 14.05".into(), since_ms: 1_700 }).unwrap();
    let mut mic = spool.writer(Source::Mic).unwrap();
    mic.write_all(&pcm16(&[0.0, 0.5, -0.5, 1.5])).unwrap();
    assert_eq!(spool.samples(Source::Mic), 4);
    assert_eq!(spool.samples(Source::System), 0);
    let back = spool.read(Source::Mic, 1, 3).unwrap();
    assert!((back[0] - 0.5).abs() < 1e-3 && (back[1] + 0.5).abs() < 1e-3 && (back[2] - 1.0).abs() < 1e-3);

    spool.record(&Piece { source: Source::Mic, done: 4, lines: vec![line(Source::Mic, 0.0, "Hello.")] }).unwrap();
    // A crash in the middle of writing the next piece, then a later one.
    OpenOptions::new().append(true).open(spool.dir.join("pieces.jsonl")).unwrap().write_all(b"{\"source\":\"system\",\"do").unwrap();
    spool.record(&Piece { source: Source::System, done: 9, lines: vec![line(Source::System, 0.2, "Hi.")] }).unwrap();
    let again = Spool::open(&spool.dir).unwrap();
    assert_eq!(again.header.stamp, "2026-11-02 14.05");
    let (done, lines) = again.progress();
    assert_eq!(done, [4, 9]);
    assert_eq!(lines.iter().map(|line| line.text.as_str()).collect::<Vec<_>>(), ["Hello.", "Hi."]);

    // A recording left behind is offered back; one with nothing in it is cleared away.
    Spool::create(&root, Header { stamp: "2026-11-02 15.00".into(), since_ms: 2_000 }).unwrap();
    let found = leftovers(&root, &[]);
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].id.as_str(), found[0].since_ms), ("1700", 1_700));
    assert!(!root.join("2000").exists());
    assert!(leftovers(&root, &["1700".into()]).is_empty());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn a_stalled_stream_is_padded_to_the_meetings_clock() {
    let root = temp("clock");
    let job = Job::new(Spool::create(&root, Header { stamp: "2026-11-02 14.05".into(), since_ms: 1 }).unwrap(), true).unwrap();
    let job = Job { started: Instant::now() - Duration::from_secs(3), ..job };
    job.append(Source::System, &[0.1; 1600]);
    let len = job.len(Source::System);
    assert!((3 * RATE as u64..3 * RATE as u64 + 1700).contains(&len), "{len}");
    assert_eq!(job.spool.samples(Source::System), len);
    job.append(Source::System, &[0.1; 1600]); // on time: no padding
    assert_eq!(job.len(Source::System), len + 1600);
    job.end();
    assert!(job.writers.lock().unwrap().0.iter().all(Option::is_none));
    fs::remove_dir_all(root).unwrap();
  }
}
