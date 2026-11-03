//! Stickies: small notes that stay on the screen, each its own little window in one of the whiteboard's
//! colours, typed into or dictated into (hold the key with its text focused). They are kept in
//! `stickies.json` in the app data folder, saved whole on every change, and opened again at launch where
//! they were. Closing one takes it off the screen and keeps it, on the Stickies page, until it is shown again,
//! archived or deleted there. A sticky can become a note in the notes folder.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::{c_char, c_void, CString};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// The whiteboard's hues (boardColor.ts in TabTasker Business), by name.
pub const HUES: [&str; 8] = ["amber", "coral", "sage", "sky", "violet", "slate", "teal", "plum"];
const LABEL: &str = "sticky-";
const MAX: usize = 40;
const MAX_TEXT: usize = 20_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sticky {
  pub id: String,
  pub text: String,
  pub hue: String,
  /// The window's frame, in points from the top left of the main screen. `height` is the open height,
  /// kept while the sticky is folded to its bar.
  pub x: f64, pub y: f64, pub width: f64, pub height: f64,
  /// On top of every window (the default), or behind them like any window, out of the way.
  pub pinned: bool,
  /// Folded to its bar alone, its first words showing.
  pub folded: bool,
  /// Off the screen: closed from its own window, kept on the Stickies page to show again.
  pub closed: bool,
  /// In the Stickies page's archive, out of the way; off the screen too.
  pub archived: bool,
  /// The sticker's own look, as TabTasker Business's whiteboard sticker has it: a title line above the words
  /// (on or off, and its words), a tilt (none, slight, random: the degrees come from the id, so it never
  /// changes) and the weight of its type (regular, bold). A new sticky takes the last one's.
  pub title: String, pub titled: bool, pub tilt: String, pub weight: String,
  pub created_ms: u64, pub updated_ms: u64,
}
impl Default for Sticky {
  fn default() -> Self { Self { id: String::new(), text: String::new(), hue: "amber".into(), x: 120.0, y: 140.0, width: 240.0, height: 200.0, pinned: true, folded: false, closed: false, archived: false, title: String::new(), titled: false, tilt: "none".into(), weight: "bold".into(), created_ms: 0, updated_ms: 0 } }
}
/// A folded sticky's height: its band alone (sticky.css .sticky-band).
const FOLDED: f64 = 34.0;
/// Above the sheet, a clear strip of the window where the pill floats in: the window's, never the sticky's size.
pub(crate) const GUTTER: f64 = 44.0;
/// How far from the window's top the pill sits (sticky.css).
const PILL_TOP: f64 = 6.0;
pub const TILTS: [&str; 3] = ["none", "slight", "random"];
pub const WEIGHTS: [&str; 2] = ["regular", "bold"];
fn one_of<'a>(name: Option<&'a str>, allowed: &[&str], fallback: &'a str) -> String { name.filter(|v| allowed.contains(v)).unwrap_or(fallback).to_owned() }

static SAVING: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |age| age.as_millis() as u64) }
fn file(app: &AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("stickies.json")) }
fn hue_or(name: Option<&str>, fallback: &str) -> String { name.filter(|hue| HUES.contains(hue)).unwrap_or(fallback).to_owned() }
pub(crate) fn label(id: &str) -> String { format!("{LABEL}{id}") }

/// Every sticky, from the file; an unreadable file is an empty list, never a crash at launch.
pub fn all(app: &AppHandle) -> Vec<Sticky> {
  let Ok(path) = file(app) else { return Vec::new() };
  let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
  let mut list: Vec<Sticky> = serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default().into_iter()
    .filter_map(|value| serde_json::from_value::<Sticky>(value).ok()).filter(|sticky| !sticky.id.is_empty()).collect();
  for sticky in &mut list {
    sticky.hue = hue_or(Some(&sticky.hue), "amber");
    sticky.tilt = one_of(Some(&sticky.tilt), &TILTS, "none");
    sticky.weight = one_of(Some(&sticky.weight), &WEIGHTS, "bold");
  }
  list
}

/// Written whole, to a temp file first, so a crash mid-write never costs the stickies.
fn write(app: &AppHandle, list: &[Sticky]) -> Result<(), String> {
  let _held = SAVING.lock().unwrap_or_else(|e| e.into_inner());
  let path = file(app)?;
  if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
  let temp = path.with_extension("json.tmp");
  std::fs::write(&temp, serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

fn changed(app: &AppHandle, list: &[Sticky]) -> Result<(), String> {
  write(app, list)?;
  let _ = app.emit("dictate-stickies", serde_json::json!({ "count": list.len() }));
  Ok(())
}

/// The sticky's window, made if it isn't open; shown and brought forward if it is.
fn open(app: &AppHandle, sticky: &Sticky) -> tauri::Result<()> {
  if let Some(window) = app.get_webview_window(&label(&sticky.id)) { window.show()?; return window.set_focus(); }
  let window = WebviewWindowBuilder::new(app, label(&sticky.id), WebviewUrl::App(format!("sticky.html?id={}", sticky.id).into()))
    .title("Sticky")
    .decorations(false).transparent(true).shadow(true)
    .always_on_top(sticky.pinned).visible_on_all_workspaces(true).skip_taskbar(true)
    .resizable(!sticky.folded).min_inner_size(160.0, (if sticky.folded { FOLDED } else { 120.0 }) + GUTTER).inner_size(sticky.width, (if sticky.folded { FOLDED } else { sticky.height }) + GUTTER).position(sticky.x, sticky.y)
    .accept_first_mouse(true)
    .build()?;
  window.set_focus()
}

/// A sticky said aloud ("sticky: call Thomas"): made with the words, or the overlay told why not.
pub fn from_voice(app: &AppHandle, words: &str) {
  match create(app, None, Some(words)) {
    Ok(_) => { let _ = app.emit_to("overlay", "dictate-notice", serde_json::json!({ "message": if words.is_empty() { "Added a blank sticky to your screen." } else { "Saved that as a sticky." } })); }
    Err(e) => { let _ = app.emit_to("overlay", "dictate-notice", serde_json::json!({ "message": e })); }
  }
}

/// One sticky changed in the file, by `id`; the sticky as it is now.
fn change(app: &AppHandle, id: &str, edit: impl FnOnce(&mut Sticky)) -> Result<Sticky, String> {
  let mut list = all(app);
  let sticky = list.iter_mut().find(|sticky| sticky.id == id).ok_or("That sticky isn’t there any more.")?;
  edit(sticky);
  let sticky = sticky.clone();
  changed(app, &list)?;
  Ok(sticky)
}

/// Back on the screen and brought forward, from the Stickies page or the archive.
#[tauri::command]
pub fn sticky_show(app: AppHandle, id: String) -> Result<(), String> {
  let sticky = change(&app, &id, |sticky| { sticky.closed = false; sticky.archived = false; })?;
  open(&app, &sticky).map_err(|e| e.to_string())
}

/// Off the screen, kept: the sticky's own close button.
#[tauri::command]
pub fn sticky_close(app: AppHandle, id: String) -> Result<(), String> {
  change(&app, &id, |sticky| sticky.closed = true)?;
  if let Some(window) = app.get_webview_window(&label(&id)) { let _ = window.close(); }
  Ok(())
}

/// Into the archive, off the screen, or back out of it (still off the screen, ready to show).
#[tauri::command]
pub fn sticky_archive(app: AppHandle, id: String, archived: bool) -> Result<(), String> {
  change(&app, &id, |sticky| { sticky.archived = archived; sticky.closed = true; })?;
  if archived { if let Some(window) = app.get_webview_window(&label(&id)) { let _ = window.close(); } }
  Ok(())
}

/// At launch: every sticky that was on the screen, back where it was.
pub fn show_all(app: &AppHandle) {
  for sticky in all(app).into_iter().filter(on_screen) { if let Err(e) = open(app, &sticky) { log::warn!("sticky: {e}"); } }
}
fn on_screen(sticky: &Sticky) -> bool { !sticky.closed && !sticky.archived }

/// A new sticky, placed a step down and right of the last one so they never pile up exactly.
pub fn create(app: &AppHandle, hue: Option<&str>, text: Option<&str>) -> Result<Sticky, String> {
  let mut list = all(app);
  // The archive keeps what it is given; only the stickies in use count toward the limit.
  if list.iter().filter(|sticky| !sticky.archived).count() >= MAX { return Err(format!("You already have {MAX} stickies. Archive one or save it as a note to make room.")); }
  let mut bytes = [0u8; 6];
  ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).map_err(|_| "Couldn’t make a sticky.".to_owned())?;
  let last = list.last().cloned();
  let (x, y) = last.as_ref().map_or((120.0, 140.0), |last| (last.x + 28.0, last.y + 28.0));
  // The look of the sticky touched last is the look the new one starts with.
  let style = list.iter().filter(|sticky| !sticky.archived).max_by_key(|sticky| sticky.updated_ms).cloned().unwrap_or_default();
  let now = now_ms();
  let sticky = Sticky {
    id: bytes.iter().map(|byte| format!("{byte:02x}")).collect(), text: text.unwrap_or_default().chars().take(MAX_TEXT).collect(),
    hue: hue_or(hue, ["amber", "sky", "sage", "coral", "violet", "teal"][list.len() % 6]), x, y, width: style.width.max(160.0), height: style.height.max(120.0), pinned: true, folded: false, closed: false, archived: false,
    title: String::new(), titled: style.titled, tilt: style.tilt, weight: style.weight, created_ms: now, updated_ms: now,
  };
  list.push(sticky.clone());
  changed(app, &list)?;
  open(app, &sticky).map_err(|e| e.to_string())?;
  Ok(sticky)
}

/// The window moved or grew: its frame is kept, so it comes back there.
pub fn frame_changed(app: &AppHandle, window_label: &str) {
  let Some(id) = window_label.strip_prefix(LABEL) else { return };
  let Some(window) = app.get_webview_window(window_label) else { return };
  let (Ok(position), Ok(size), Ok(scale)) = (window.outer_position(), window.inner_size(), window.scale_factor()) else { return };
  let (position, size): (LogicalPosition<f64>, LogicalSize<f64>) = (position.to_logical(scale), size.to_logical(scale));
  let mut list = all(app);
  let Some(sticky) = list.iter_mut().find(|sticky| sticky.id == id) else { return };
  // Folded, the window is its band: the open height is kept for when it unfolds. The gutter is the window's.
  let height = if sticky.folded { sticky.height } else { size.height - GUTTER };
  if (sticky.x, sticky.y, sticky.width, sticky.height) == (position.x, position.y, size.width, height) { return; }
  sticky.x = position.x; sticky.y = position.y; sticky.width = size.width; sticky.height = height;
  if let Err(e) = write(app, &list) { log::warn!("sticky: {e}"); }
}

#[tauri::command]
pub fn sticky_list(app: AppHandle) -> Vec<Sticky> { all(&app) }

#[tauri::command]
pub fn sticky_get(app: AppHandle, id: String) -> Result<Sticky, String> {
  all(&app).into_iter().find(|sticky| sticky.id == id).ok_or_else(|| "That sticky isn’t there any more.".into())
}

/// From the menu, a shortcut or the Library: a new sticky on the screen, focused for typing.
#[tauri::command]
pub async fn sticky_new(app: AppHandle, hue: Option<String>, text: Option<String>) -> Result<Sticky, String> {
  let (done, made) = std::sync::mpsc::channel();
  let handle = app.clone();
  app.run_on_main_thread(move || { let _ = done.send(create(&handle, hue.as_deref(), text.as_deref())); }).map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || made.recv().map_err(|_| "Couldn’t make a sticky.".to_owned())?).await.map_err(|e| e.to_string())?
}

/// The sticky's own window: its words as they are typed, a new colour, or its look (title, tilt, weight).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn sticky_update(app: AppHandle, id: String, text: Option<String>, hue: Option<String>, title: Option<String>, titled: Option<bool>, tilt: Option<String>, weight: Option<String>) -> Result<Sticky, String> {
  let mut list = all(&app);
  let sticky = list.iter_mut().find(|sticky| sticky.id == id).ok_or("That sticky isn’t there any more.")?;
  if let Some(text) = text { sticky.text = text.chars().take(MAX_TEXT).collect(); }
  if let Some(hue) = hue { sticky.hue = hue_or(Some(&hue), &sticky.hue.clone()); }
  if let Some(title) = title { sticky.title = title.chars().take(120).collect(); }
  if let Some(titled) = titled { sticky.titled = titled; }
  if let Some(tilt) = tilt { sticky.tilt = one_of(Some(&tilt), &TILTS, &sticky.tilt.clone()); }
  if let Some(weight) = weight { sticky.weight = one_of(Some(&weight), &WEIGHTS, &sticky.weight.clone()); }
  sticky.updated_ms = now_ms();
  let kept = sticky.clone();
  changed(&app, &list)?;
  Ok(kept)
}

/// A size picked from the menu (small, medium, large): the window takes it now, unless folded, and keeps it.
#[tauri::command]
pub fn sticky_size(app: AppHandle, id: String, width: f64, height: f64) -> Result<Sticky, String> {
  let (width, height) = (width.clamp(160.0, 900.0), height.clamp(120.0, 900.0));
  let mut list = all(&app);
  let sticky = list.iter_mut().find(|sticky| sticky.id == id).ok_or("That sticky isn’t there any more.")?;
  sticky.width = width; sticky.height = height;
  let kept = sticky.clone();
  if !kept.folded { if let Some(window) = app.get_webview_window(&label(&id)) { window.set_size(LogicalSize::new(width, height + GUTTER)).map_err(|e| e.to_string())?; } }
  changed(&app, &list)?;
  Ok(kept)
}

extern "C" {
  fn dictate_sticky_watch(window: *mut c_void, id: *const c_char, gutter: f64, pill_width: f64, pill_top: f64);
  fn dictate_sticky_hold(window: *mut c_void, hold: bool);
}
/// The page's pill, measured, so the Mac knows where the window takes the mouse: over the sheet, and over the
/// pill while it is up (dictate.m). The page hears the pill rise and fall as `dictate-sticky-hover`.
#[tauri::command]
pub fn sticky_watch(app: AppHandle, id: String, pill_width: f64) -> Result<(), String> {
  let window = app.get_webview_window(&label(&id)).ok_or("That sticky isn’t on the screen.")?;
  let native = window.ns_window().map_err(|e| e.to_string())?;
  let name = CString::new(id).map_err(|e| e.to_string())?;
  unsafe { dictate_sticky_watch(native, name.as_ptr(), GUTTER, pill_width.clamp(40.0, 900.0), PILL_TOP) };
  Ok(())
}
/// The pill stays up, wherever the pointer is: its colours or menu are open, or the keyboard is in it.
#[tauri::command]
pub fn sticky_hold(app: AppHandle, id: String, hold: bool) -> Result<(), String> {
  let window = app.get_webview_window(&label(&id)).ok_or("That sticky isn’t on the screen.")?;
  let native = window.ns_window().map_err(|e| e.to_string())?;
  unsafe { dictate_sticky_hold(native, hold) };
  Ok(())
}

/// On top of everything, or behind other windows like any window: a sticky that is out of the way.
#[tauri::command]
pub fn sticky_pin(app: AppHandle, id: String, pinned: bool) -> Result<Sticky, String> {
  let mut list = all(&app);
  let sticky = list.iter_mut().find(|sticky| sticky.id == id).ok_or("That sticky isn’t there any more.")?;
  sticky.pinned = pinned;
  let kept = sticky.clone();
  if let Some(window) = app.get_webview_window(&label(&id)) { window.set_always_on_top(pinned).map_err(|e| e.to_string())?; }
  changed(&app, &list)?;
  Ok(kept)
}

/// Folded to its bar (its first words showing), or open again at the height it had.
#[tauri::command]
pub fn sticky_fold(app: AppHandle, id: String, folded: bool) -> Result<Sticky, String> {
  let mut list = all(&app);
  let sticky = list.iter_mut().find(|sticky| sticky.id == id).ok_or("That sticky isn’t there any more.")?;
  sticky.folded = folded;
  let kept = sticky.clone();
  if let Some(window) = app.get_webview_window(&label(&id)) {
    let height = (if folded { FOLDED } else { kept.height }) + GUTTER;
    window.set_resizable(!folded).and_then(|_| window.set_min_size(Some(LogicalSize::new(160.0, (if folded { FOLDED } else { 120.0 }) + GUTTER))))
      .and_then(|_| window.set_size(LogicalSize::new(kept.width, height))).map_err(|e| e.to_string())?;
  }
  changed(&app, &list)?;
  Ok(kept)
}

/// Deleted, from the Stickies page: window and record both, for good.
#[tauri::command]
pub fn sticky_remove(app: AppHandle, id: String) -> Result<(), String> {
  let list: Vec<Sticky> = all(&app).into_iter().filter(|sticky| sticky.id != id).collect();
  changed(&app, &list)?;
  if let Some(window) = app.get_webview_window(&label(&id)) { let _ = window.close(); }
  Ok(())
}

/// The sticky's words saved as a note (its first line the title), and the sticky gone.
#[tauri::command]
pub async fn sticky_to_note(app: AppHandle, id: String, stamp: String) -> Result<String, String> {
  let sticky = all(&app).into_iter().find(|sticky| sticky.id == id).ok_or("That sticky isn’t there any more.")?;
  if sticky.text.trim().is_empty() { return Err("Write something first.".into()); }
  let mut lines = sticky.text.trim().lines().map(str::trim).filter(|line| !line.is_empty());
  let title: String = lines.next().unwrap_or("Sticky").chars().take(80).collect();
  let path = crate::library::notes::save_note(app.clone(), title, sticky.text.clone(), stamp, Some(true)).await?;
  sticky_remove(app, id)?;
  Ok(path)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_sticky_keeps_a_known_hue_and_reads_back_from_an_older_file() {
    let old: Vec<Sticky> = serde_json::from_str(r#"[{ "id": "ab12", "text": "Call Maria", "hue": "lime", "x": 10, "y": 20 }, { "text": "no id" }]"#).unwrap();
    assert_eq!(old.len(), 2);
    assert_eq!((old[0].id.as_str(), old[0].width, old[0].height), ("ab12", 240.0, 200.0));
    assert_eq!(hue_or(Some("lime"), "amber"), "amber");
    assert_eq!(hue_or(Some("plum"), "amber"), "plum");
    assert_eq!(hue_or(None, "sky"), "sky");
    assert_eq!(label("ab12"), "sticky-ab12");
    assert!(!old[0].closed && !old[0].archived && on_screen(&old[0]), "an older file's stickies are all on the screen");
    assert!(!on_screen(&Sticky { closed: true, ..old[0].clone() }) && !on_screen(&Sticky { archived: true, ..old[0].clone() }));
  }
}
