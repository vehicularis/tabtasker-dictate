//! Dictation history and the stats drawn from it: one JSON line per dictation, command or note in
//! `history.jsonl` in the app data folder. The numbers are kept for good; the words only as long as
//! History keeps them, and never with "Don't keep".
use crate::settings::{self, Keep};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, CString};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// One finished dictation, command or note. `text` is kept only while History keeps words.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
  pub at_ms: u64,
  pub mode: String,
  pub bundle_id: String,
  pub app_name: String,
  pub words: usize,
  pub seconds: f64,
  pub text: String,
}

impl Entry {
  /// An entry for `text` said now over `seconds`, in the hold `ctx`.
  pub fn new(ctx: &crate::context::HoldContext, text: &str, seconds: f64) -> Self {
    Self { at_ms: now_ms(), mode: ctx.mode.as_str().into(), bundle_id: ctx.bundle_id.clone(), app_name: ctx.app_name.clone(), words: text.split_whitespace().count(), seconds, text: text.to_owned() }
  }
}

fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

const DAY_MS: u64 = 86_400_000;
/// The typing speed time saved is counted against.
const TYPING_WPM: f64 = 40.0;
/// Days in the stats' chart, today last.
const CHART_DAYS: usize = 30;
const TOP_APPS: usize = 5;

// ---------- the file ----------

/// The entries in `path`, oldest first, and whether the file is clean. A line that isn't an entry (a
/// crash mid-write, an edit by hand) is skipped; a file without its last newline would glue the next
/// entry onto it, so it isn't clean either.
fn load(path: &Path) -> (Vec<Entry>, bool) {
  let Ok(bytes) = std::fs::read(path) else { return (Vec::new(), true) };
  let mut clean = bytes.is_empty() || bytes.ends_with(b"\n");
  let mut entries = Vec::new();
  for line in bytes.split(|byte| *byte == b'\n').filter(|line| !line.iter().all(u8::is_ascii_whitespace)) {
    match serde_json::from_slice::<Entry>(line) {
      Ok(entry) => entries.push(entry),
      Err(_) => clean = false,
    }
  }
  entries.sort_by_key(|entry| entry.at_ms);
  (entries, clean)
}

fn lines(entries: &[Entry]) -> Vec<u8> {
  let mut out = Vec::new();
  for entry in entries {
    if serde_json::to_writer(&mut out, entry).is_ok() { out.push(b'\n'); }
  }
  out
}

/// Written beside the file, then renamed over it: a crash leaves the old history or the new, never half.
fn rewrite(path: &Path, entries: &[Entry]) -> Result<(), String> {
  if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
  let temp = path.with_extension("jsonl.tmp");
  let written = std::fs::File::create(&temp).and_then(|mut file| { file.write_all(&lines(entries))?; file.sync_all() });
  if let Err(e) = written.and_then(|_| std::fs::rename(&temp, path)) {
    let _ = std::fs::remove_file(&temp);
    return Err(format!("couldn’t save: {e}"));
  }
  Ok(())
}

fn append(path: &Path, entry: &Entry) -> std::io::Result<()> {
  if let Some(dir) = path.parent() { std::fs::create_dir_all(dir)?; }
  std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(&lines(std::slice::from_ref(entry)))
}

// ---------- pruning ----------

/// Entries before this lose their words; `None` keeps them all.
fn cutoff(keep: Keep, now_ms: u64) -> Option<u64> {
  match keep {
    Keep::Off => Some(u64::MAX),
    Keep::Day => Some(now_ms.saturating_sub(DAY_MS)),
    Keep::Week => Some(now_ms.saturating_sub(7 * DAY_MS)),
    Keep::Month => Some(now_ms.saturating_sub(30 * DAY_MS)),
    Keep::Forever => None,
  }
}

/// Drops the words of entries older than `keep` allows, keeping their numbers. True when any changed.
fn prune(entries: &mut [Entry], keep: Keep, now_ms: u64) -> bool {
  let Some(before) = cutoff(keep, now_ms) else { return false };
  let mut changed = false;
  for entry in entries.iter_mut().filter(|entry| entry.at_ms < before && !entry.text.is_empty()) {
    entry.text.clear();
    changed = true;
  }
  changed
}

// ---------- local days ----------

/// macOS's `struct tm`: nine ints, then the offset from UTC in seconds and the zone's name.
#[repr(C)]
struct Tm { _fields: [i32; 9], gmtoff: std::ffi::c_long, _zone: *const c_char }
extern "C" {
  fn localtime_r(time: *const i64, out: *mut Tm) -> *mut Tm;
}

/// The day `at_ms` falls on in the Mac's time zone, as days since 1970-01-01 there. The offset is the
/// one in force at that moment, so days on either side of a daylight saving change stay whole.
pub fn local_day(at_ms: u64) -> i64 {
  let secs = (at_ms / 1000) as i64;
  let mut tm = Tm { _fields: [0; 9], gmtoff: 0, _zone: std::ptr::null() };
  let offset = if unsafe { localtime_r(&secs, &mut tm) }.is_null() { 0 } else { tm.gmtoff as i64 };
  (secs + offset).div_euclid(86_400)
}

// ---------- stats ----------

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWords { pub bundle_id: String, pub name: String, pub words: usize }

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
  pub dictations: usize,
  pub words_today: usize,
  pub words_total: usize,
  /// Words a minute over the time spent speaking; 0 before anything is said.
  pub wpm: f64,
  /// Typing the same words at 40 words a minute, less the time it took to say them.
  pub saved_seconds: f64,
  /// Days in a row with words, up to today, or up to yesterday while today has none yet.
  pub streak: u32,
  /// Today as a local day number (days since 1970-01-01 here); `days` ends on it.
  pub today: i64,
  /// Words on each of the last 30 days, oldest first.
  pub days: Vec<usize>,
  /// Where the most words went, most first.
  pub apps: Vec<AppWords>,
}

/// The stats of `entries` (oldest first) at `now_ms`, with `day` giving the local day of a moment.
fn stats(entries: &[Entry], now_ms: u64, day: impl Fn(u64) -> i64) -> Stats {
  let today = day(now_ms);
  let mut stats = Stats { today, days: vec![0; CHART_DAYS], ..Stats::default() };
  let (mut spoken_words, mut spoken_seconds) = (0usize, 0f64);
  let mut active = HashSet::new();
  let mut apps: HashMap<&str, AppWords> = HashMap::new();
  for entry in entries {
    let on = day(entry.at_ms);
    stats.dictations += 1;
    stats.words_total += entry.words;
    if on == today { stats.words_today += entry.words; }
    if let Some(ago) = usize::try_from(today - on).ok().filter(|ago| *ago < CHART_DAYS) { stats.days[CHART_DAYS - 1 - ago] += entry.words; }
    if entry.seconds.is_finite() && entry.seconds > 0.0 { spoken_words += entry.words; spoken_seconds += entry.seconds; }
    if entry.words > 0 { active.insert(on); }
    // A note goes to a file, not into the app in front.
    let key = if entry.bundle_id.is_empty() { entry.app_name.as_str() } else { entry.bundle_id.as_str() };
    if entry.mode != "note" && !key.is_empty() && entry.words > 0 {
      let app = apps.entry(key).or_insert_with(|| AppWords { bundle_id: entry.bundle_id.clone(), ..AppWords::default() });
      app.words += entry.words;
      if !entry.app_name.is_empty() { app.name = entry.app_name.clone(); } // the newest name it ran under
    }
  }
  if spoken_seconds > 0.0 { stats.wpm = spoken_words as f64 / (spoken_seconds / 60.0); }
  stats.saved_seconds = (stats.words_total as f64 / TYPING_WPM * 60.0 - spoken_seconds).max(0.0);
  let mut on = if active.contains(&today) { today } else { today - 1 };
  while active.contains(&on) { stats.streak += 1; on -= 1; }
  let mut apps: Vec<AppWords> = apps.into_values().map(|app| if app.name.is_empty() { AppWords { name: app.bundle_id.clone(), ..app } } else { app }).collect();
  apps.sort_by(|a, b| b.words.cmp(&a.words).then_with(|| a.name.cmp(&b.name)));
  apps.truncate(TOP_APPS);
  stats.apps = apps;
  stats
}

// ---------- the store ----------

// ponytail: every entry stays in memory and in one file (about 150 bytes each, so years of daily use
// is a few MB); fold old entries into daily totals if that ever shows.
#[derive(Default)]
struct Store {
  file: Option<PathBuf>,
  entries: Vec<Entry>,
  /// What the last prune went by: the setting and the day. Either changing prunes again.
  pruned: Option<(Keep, u64)>,
}

impl Store {
  fn save(&self) {
    if let Some(file) = &self.file {
      if let Err(e) = rewrite(file, &self.entries) { log::warn!("history: {e}"); }
    }
  }

  fn prune_now(&mut self, keep: Keep, now_ms: u64) {
    let by = Some((keep, now_ms / DAY_MS));
    if self.pruned == by { return; }
    self.pruned = by;
    if prune(&mut self.entries, keep, now_ms) { self.save(); }
  }

  /// Keeps `entry`, without its words when History keeps none, and answers it as kept.
  fn add(&mut self, mut entry: Entry, keep: Keep, now_ms: u64) -> Entry {
    self.prune_now(keep, now_ms);
    // The time is the entry's id, so two in the same millisecond still get one each.
    if let Some(newest) = self.entries.last() { entry.at_ms = entry.at_ms.max(newest.at_ms + 1); }
    if keep == Keep::Off { entry.text.clear(); }
    if let Some(file) = &self.file {
      if let Err(e) = append(file, &entry) { log::warn!("history: couldn’t save a dictation: {e}"); }
    }
    self.entries.push(entry.clone());
    entry
  }

  /// Forgets the words of the entry at `at_ms`, or of every entry; their numbers stay for the stats.
  fn forget(&mut self, at_ms: Option<u64>) {
    let mut changed = false;
    for entry in self.entries.iter_mut().filter(|entry| at_ms.is_none_or(|at| entry.at_ms == at) && !entry.text.is_empty()) {
      entry.text.clear();
      changed = true;
    }
    if changed { self.save(); }
  }

  /// The entries with words, newest first.
  fn kept(&self) -> Vec<Entry> { self.entries.iter().rev().filter(|entry| !entry.text.is_empty()).cloned().collect() }
}

static STORE: Mutex<Store> = Mutex::new(Store { file: None, entries: Vec::new(), pruned: None });
static APP: OnceLock<AppHandle> = OnceLock::new();
/// The newest entry, for Paste Last Transcript. It keeps the words even while History keeps none,
/// until the app quits or History is cleared.
static LAST: Mutex<Option<Entry>> = Mutex::new(None);

fn store() -> MutexGuard<'static, Store> { STORE.lock().unwrap_or_else(|e| e.into_inner()) }
fn last_slot() -> MutexGuard<'static, Option<Entry>> { LAST.lock().unwrap_or_else(|e| e.into_inner()) }
fn keep() -> Keep { settings::get().history.keep }

/// Reads the history at launch and prunes it, then checks every hour, so a day never passes without a prune.
pub fn init(app: &AppHandle) -> Result<(), String> {
  let file = app.path().app_data_dir().map_err(|e| e.to_string())?.join("history.jsonl");
  let (entries, clean) = load(&file);
  {
    let mut store = store();
    *store = Store { file: Some(file.clone()), entries, pruned: None };
    if !clean { log::warn!("history: left out lines in {} that aren’t dictations", file.display()); store.save(); }
    store.prune_now(keep(), now_ms());
    *last_slot() = store.entries.iter().rev().find(|entry| !entry.text.trim().is_empty()).cloned();
  }
  let _ = APP.set(app.clone());
  std::thread::spawn(|| loop {
    std::thread::sleep(std::time::Duration::from_secs(3600));
    store().prune_now(keep(), now_ms());
  });
  Ok(())
}

/// Keeps a finished dictation, command or note, and tells the History page. A hold that heard no
/// words isn't one.
pub fn record(entry: Entry) {
  if entry.words == 0 { return; }
  let kept = store().add(entry.clone(), keep(), now_ms());
  if !entry.text.trim().is_empty() { *last_slot() = Some(Entry { text: entry.text, ..kept.clone() }); }
  if let Some(app) = APP.get() { let _ = app.emit("dictate-history", serde_json::json!({ "entry": kept })); }
}

pub fn last() -> Option<Entry> { last_slot().clone() }

fn forget_last(at_ms: Option<u64>) {
  let mut last = last_slot();
  if last.as_ref().is_some_and(|entry| at_ms.is_none_or(|at| entry.at_ms == at)) { *last = None; }
}

// ---------- what the History page asks for ----------

/// The dictations whose words are kept, newest first.
#[tauri::command]
pub fn history_list() -> Vec<Entry> {
  let mut store = store();
  store.prune_now(keep(), now_ms());
  store.kept()
}

#[tauri::command]
pub fn history_stats() -> Stats {
  let mut store = store();
  store.prune_now(keep(), now_ms());
  stats(&store.entries, now_ms(), local_day)
}

/// Forgets what was said at `at`; it still counts in the stats.
#[tauri::command]
pub fn history_delete(at: u64) {
  store().forget(Some(at));
  forget_last(Some(at));
}

/// Forgets everything said; the stats stay.
#[tauri::command]
pub fn history_clear() {
  store().forget(None);
  forget_last(None);
}

extern "C" {
  fn dictate_history_type(text: *const c_char) -> i32;
}

/// Types what was said at `at` into the app that was in front before Settings.
#[tauri::command]
pub async fn history_type(app: AppHandle, at: u64) -> Result<(), String> {
  let text = store().entries.iter().find(|entry| entry.at_ms == at && !entry.text.is_empty()).map(|entry| entry.text.replace('\0', ""));
  let text = CString::new(text.ok_or("That dictation is no longer kept")?).map_err(|e| e.to_string())?;
  let (done, result) = tokio::sync::oneshot::channel();
  app.run_on_main_thread(move || { let _ = done.send(unsafe { dictate_history_type(text.as_ptr()) }); }).map_err(|e| e.to_string())?;
  match result.await.map_err(|e| e.to_string())? {
    0 => Ok(()),
    1 => Err("Turn on Accessibility to type".into()),
    _ => Err("Open the app to type into, then try again".into()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const H: u64 = 3_600_000;
  /// 2026-11-02 12:00 UTC.
  const NOON: u64 = 1_793_620_800_000;

  fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-history-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("history.jsonl")
  }

  fn said(at_ms: u64, words: usize, seconds: f64, app: &str) -> Entry {
    let text = vec!["word"; words].join(" ");
    Entry { at_ms, mode: "dictate".into(), bundle_id: format!("com.example.{}", app.to_lowercase()), app_name: app.into(), words, seconds, text }
  }

  /// Local days at a fixed offset from UTC, in hours.
  fn zone(hours: i64) -> impl Fn(u64) -> i64 { move |at_ms| (at_ms as i64 / 1000 + hours * 3600).div_euclid(86_400) }

  fn stats_of(entries: &[Entry]) -> Stats { stats(entries, NOON, zone(0)) }

  #[test]
  fn local_day_follows_the_mac() {
    assert_eq!(local_day(NOON) - local_day(NOON - DAY_MS), 1);
    assert!((local_day(NOON) - (NOON / DAY_MS) as i64).abs() <= 1);
  }

  #[test]
  fn pruning_drops_words_older_than_keep_and_keeps_numbers() {
    let mut entries = vec![said(NOON - 40 * DAY_MS, 3, 1.0, "Mail"), said(NOON - 10 * DAY_MS, 4, 1.0, "Mail"), said(NOON - 2 * DAY_MS, 5, 1.0, "Mail"), said(NOON - H, 6, 1.0, "Mail")];
    let pruned = |keep: Keep| {
      let mut entries = entries.clone();
      prune(&mut entries, keep, NOON);
      entries.iter().map(|entry| !entry.text.is_empty()).collect::<Vec<_>>()
    };
    assert_eq!(pruned(Keep::Forever), [true; 4]);
    assert_eq!(pruned(Keep::Month), [false, true, true, true]);
    assert_eq!(pruned(Keep::Week), [false, false, true, true]);
    assert_eq!(pruned(Keep::Day), [false, false, false, true]);
    assert_eq!(pruned(Keep::Off), [false; 4]);
    assert!(!prune(&mut entries.clone(), Keep::Forever, NOON));
    assert!(prune(&mut entries, Keep::Off, NOON));
    assert!(!prune(&mut entries, Keep::Off, NOON), "nothing left to drop");
    assert_eq!(entries.iter().map(|entry| entry.words).sum::<usize>(), 18);
  }

  #[test]
  fn the_store_prunes_each_day_and_when_keep_changes() {
    let file = temp("daily");
    let mut store = Store { file: Some(file.clone()), ..Store::default() };
    store.add(said(NOON - 2 * H, 2, 1.0, "Notes"), Keep::Day, NOON - 2 * H);
    store.prune_now(Keep::Day, NOON + 2 * H);
    assert_eq!(store.kept().len(), 1);
    store.prune_now(Keep::Day, NOON + DAY_MS);
    assert!(store.kept().is_empty(), "the next day prunes");
    assert!(load(&file).0[0].text.is_empty(), "and saves the prune");

    store.add(said(NOON + DAY_MS + H, 2, 1.0, "Notes"), Keep::Week, NOON + DAY_MS + H);
    assert_eq!(store.kept().len(), 1);
    store.prune_now(Keep::Off, NOON + DAY_MS + H);
    assert!(store.kept().is_empty(), "choosing Don't keep prunes at once");
    let _ = std::fs::remove_dir_all(file.parent().unwrap());
  }

  #[test]
  fn no_words_are_written_while_history_keeps_none() {
    let file = temp("off");
    let mut store = Store { file: Some(file.clone()), ..Store::default() };
    let kept = store.add(said(NOON, 3, 1.5, "Slack"), Keep::Off, NOON);
    assert!(kept.text.is_empty());
    assert_eq!(kept.words, 3);
    let saved = std::fs::read_to_string(&file).unwrap();
    assert!(!saved.contains("word "), "{saved}");
    assert_eq!(load(&file).0[0].words, 3);
    let _ = std::fs::remove_dir_all(file.parent().unwrap());
  }

  #[test]
  fn entries_round_trip_and_delete_keeps_the_numbers() {
    let file = temp("round-trip");
    let mut store = Store { file: Some(file.clone()), ..Store::default() };
    let first = store.add(said(NOON, 2, 1.0, "Mail"), Keep::Week, NOON);
    let second = store.add(Entry { text: "line one\nline \"two\" ✓".into(), ..said(NOON, 4, 2.0, "Mail") }, Keep::Week, NOON);
    assert_eq!(second.at_ms, first.at_ms + 1, "each entry its own time");
    assert_eq!(load(&file), (store.entries.clone(), true));

    store.forget(Some(first.at_ms));
    assert_eq!(store.kept(), vec![second]);
    assert_eq!(load(&file).0[0].text, "");
    store.forget(None);
    assert!(store.kept().is_empty());
    assert_eq!(load(&file).0.iter().map(|entry| entry.words).collect::<Vec<_>>(), [2, 4]);
    let _ = std::fs::remove_dir_all(file.parent().unwrap());
  }

  #[test]
  fn corrupt_lines_are_skipped() {
    let file = temp("corrupt");
    let newer = serde_json::to_string(&said(NOON, 2, 1.0, "Mail")).unwrap();
    let older = serde_json::to_string(&said(NOON - H, 1, 1.0, "Mail")).unwrap();
    std::fs::write(&file, format!("{newer}\nnot json\n\n{{\"atMs\":\"soon\"}}\n[1,2]\n\u{0}\n{older}\n{{\"atMs\":5,\"wor")).unwrap();
    let (entries, clean) = load(&file);
    assert!(!clean);
    assert_eq!(entries.iter().map(|entry| entry.at_ms).collect::<Vec<_>>(), [NOON - H, NOON], "oldest first");

    // Rewritten clean, so the next entry isn't glued to the cut-off line.
    let mut store = Store { file: Some(file.clone()), entries, pruned: None };
    store.save();
    store.add(said(NOON + H, 3, 1.0, "Mail"), Keep::Week, NOON + H);
    let (entries, clean) = load(&file);
    assert!(clean);
    assert_eq!(entries.len(), 3);

    // Unknown fields and missing ones are fine; a missing file is empty and clean.
    std::fs::write(&file, "{\"atMs\":7,\"words\":2,\"future\":true}\n").unwrap();
    assert_eq!(load(&file), (vec![Entry { at_ms: 7, words: 2, ..Entry::default() }], true));
    assert_eq!(load(&file.with_extension("missing")), (Vec::new(), true));
    let _ = std::fs::remove_dir_all(file.parent().unwrap());
  }

  #[test]
  fn stats_math() {
    let entries = vec![
      said(NOON - 3 * DAY_MS, 100, 40.0, "Mail"),
      said(NOON - H, 60, 20.0, "Slack"),
      said(NOON, 40, 0.0, "Slack"), // no speaking time: its words count, but not in the speed
      Entry { mode: "note".into(), ..said(NOON, 200, 60.0, "Mail") },
    ];
    let stats = stats_of(&entries);
    assert_eq!(stats.dictations, 4);
    assert_eq!(stats.words_total, 400);
    assert_eq!(stats.words_today, 300);
    assert_eq!(stats.wpm, 180.0, "360 words over 2 minutes");
    assert_eq!(stats.saved_seconds, 480.0, "10 minutes to type, 2 to say");
    assert_eq!(stats.days.len(), 30);
    assert_eq!((stats.days[29], stats.days[26]), (300, 100));
    assert_eq!(stats.days.iter().sum::<usize>(), 400);
    assert_eq!(stats.today, (NOON / DAY_MS) as i64);
    assert_eq!(stats.apps, vec![
      AppWords { bundle_id: "com.example.mail".into(), name: "Mail".into(), words: 100 },
      AppWords { bundle_id: "com.example.slack".into(), name: "Slack".into(), words: 100 },
    ], "a note counts for no app; a tie goes by name");
    assert_eq!(stats.streak, 1);

    let slow = stats_of(&[said(NOON, 2, 60.0, "Mail")]);
    assert_eq!((slow.wpm, slow.saved_seconds), (2.0, 0.0), "never less than nothing saved");
    let none = stats_of(&[]);
    assert_eq!((none.dictations, none.wpm, none.saved_seconds, none.streak, none.days.iter().sum::<usize>()), (0, 0.0, 0.0, 0, 0));
    let old = stats_of(&[said(NOON - 30 * DAY_MS, 9, 1.0, "Mail")]);
    assert_eq!((old.words_total, old.days.iter().sum::<usize>()), (9, 0), "the chart holds 30 days");
  }

  #[test]
  fn top_apps_are_capped_and_go_by_their_newest_name() {
    let mut entries: Vec<Entry> = (0..8).map(|i| said(NOON - (8 - i) * H, 10 + i as usize, 1.0, &format!("App{i}"))).collect();
    entries.push(Entry { app_name: String::new(), ..said(NOON, 30, 1.0, "Nameless") });
    entries.push(Entry { app_name: "App 7 Renamed".into(), ..said(NOON, 1, 1.0, "App7") });
    let apps = stats_of(&entries).apps;
    assert_eq!(apps.iter().map(|app| (app.name.as_str(), app.words)).collect::<Vec<_>>(),
      [("com.example.nameless", 30), ("App 7 Renamed", 18), ("App6", 16), ("App5", 15), ("App4", 14)]);
  }

  #[test]
  fn streaks_count_whole_days() {
    let days = |ago: &[u64]| ago.iter().map(|ago| said(NOON - ago * DAY_MS, 1, 1.0, "Mail")).collect::<Vec<_>>();
    assert_eq!(stats_of(&days(&[0, 1, 2, 4])).streak, 3);
    assert_eq!(stats_of(&days(&[1, 2, 3])).streak, 3, "today isn't over yet");
    assert_eq!(stats_of(&days(&[2, 3])).streak, 0, "a missed day ends it");
    assert_eq!(stats_of(&days(&[0, 0, 0])).streak, 1);
    assert_eq!(stats_of(&[said(NOON, 0, 1.0, "Mail")]).streak, 0, "nothing said isn't a day");
  }

  #[test]
  fn days_follow_the_time_zone() {
    // 23:30 UTC yesterday and today, and 00:30 UTC tomorrow, seen just after the last.
    let late = NOON + 11 * H + H / 2;
    let entries = vec![said(late - DAY_MS, 1, 1.0, "Mail"), said(late, 1, 1.0, "Mail"), said(late + H, 1, 1.0, "Mail")];
    let at = |hours| stats(&entries, late + H, zone(hours));
    // London in winter: three days.
    assert_eq!((at(0).words_today, at(0).streak), (1, 3));
    // San Francisco: the last two are the same afternoon.
    assert_eq!((at(-8).words_today, at(-8).streak), (2, 2));
    // Istanbul: the last two are the same early morning, a day later.
    assert_eq!((at(3).words_today, at(3).streak, at(3).today - at(-8).today), (2, 2, 1));
    assert_eq!(at(3).days[27..], [0, 1, 2]);

    // 23:30 local on each of the last 8 evenings, with the clocks going back an hour 4 days ago.
    let back = NOON - 4 * DAY_MS;
    let offset = |at_ms: u64| if at_ms < back { 2 } else { 1 };
    let evenings: Vec<Entry> = (0..8).map(|ago| {
      let summer = NOON - ago * DAY_MS + 9 * H + H / 2;
      said(if summer < back { summer } else { summer + H }, 1, 1.0, "Mail")
    }).collect();
    let stats = stats(&evenings, NOON + 10 * H + 3 * H / 4, |at_ms| zone(offset(at_ms))(at_ms));
    assert_eq!(stats.streak, 8);
    assert_eq!(stats.days[22..], [1; 8]);
  }
}
