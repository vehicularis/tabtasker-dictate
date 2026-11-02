//! Stickies: small notes that stay on the screen, each its own little window in one of the whiteboard's
//! colours, typed into or dictated into (hold the key with its text focused). They are kept in
//! `stickies.json` in the app data folder, saved whole on every change, and opened again at launch where
//! they were. A sticky can become a note in the notes folder, and is gone when closed.
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
  /// The window's frame, in points from the top left of the main screen.
  pub x: f64, pub y: f64, pub width: f64, pub height: f64,
  pub created_ms: u64, pub updated_ms: u64,
}
impl Default for Sticky {
  fn default() -> Self { Self { id: String::new(), text: String::new(), hue: "amber".into(), x: 120.0, y: 140.0, width: 240.0, height: 200.0, created_ms: 0, updated_ms: 0 } }
}

static SAVING: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |age| age.as_millis() as u64) }
fn file(app: &AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("stickies.json")) }
fn hue_or(name: Option<&str>, fallback: &str) -> String { name.filter(|hue| HUES.contains(hue)).unwrap_or(fallback).to_owned() }
fn label(id: &str) -> String { format!("{LABEL}{id}") }

/// Every sticky, from the file; an unreadable file is an empty list, never a crash at launch.
pub fn all(app: &AppHandle) -> Vec<Sticky> {
  let Ok(path) = file(app) else { return Vec::new() };
  let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
  let mut list: Vec<Sticky> = serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default().into_iter()
    .filter_map(|value| serde_json::from_value::<Sticky>(value).ok()).filter(|sticky| !sticky.id.is_empty()).collect();
  for sticky in &mut list { sticky.hue = hue_or(Some(&sticky.hue), "amber"); }
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
    .always_on_top(true).visible_on_all_workspaces(true).skip_taskbar(true)
    .resizable(true).min_inner_size(160.0, 120.0).inner_size(sticky.width, sticky.height).position(sticky.x, sticky.y)
    .accept_first_mouse(true)
    .build()?;
  window.set_focus()
}

/// At launch: every sticky back on the screen where it was.
pub fn show_all(app: &AppHandle) {
  for sticky in all(app) { if let Err(e) = open(app, &sticky) { log::warn!("sticky: {e}"); } }
}

/// A new sticky, placed a step down and right of the last one so they never pile up exactly.
pub fn create(app: &AppHandle, hue: Option<&str>, text: Option<&str>) -> Result<Sticky, String> {
  let mut list = all(app);
  if list.len() >= MAX { return Err(format!("That’s {MAX} stickies already. Close one, or save one as a note.")); }
  let mut bytes = [0u8; 6];
  ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).map_err(|_| "Couldn’t make a sticky.".to_owned())?;
  let last = list.last().cloned();
  let (x, y) = last.as_ref().map_or((120.0, 140.0), |last| (last.x + 28.0, last.y + 28.0));
  let now = now_ms();
  let sticky = Sticky {
    id: bytes.iter().map(|byte| format!("{byte:02x}")).collect(), text: text.unwrap_or_default().chars().take(MAX_TEXT).collect(),
    hue: hue_or(hue, &["amber", "sky", "sage", "coral", "violet", "teal"][list.len() % 6]), x, y, width: 240.0, height: 200.0, created_ms: now, updated_ms: now,
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
  if (sticky.x, sticky.y, sticky.width, sticky.height) == (position.x, position.y, size.width, size.height) { return; }
  sticky.x = position.x; sticky.y = position.y; sticky.width = size.width; sticky.height = size.height;
  if let Err(e) = write(app, &list) { log::warn!("sticky: {e}"); }
}

#[tauri::command]
pub fn sticky_list(app: AppHandle) -> Vec<Sticky> { all(&app) }

#[tauri::command]
pub fn sticky_get(app: AppHandle, id: String) -> Result<Sticky, String> {
  all(&app).into_iter().find(|sticky| sticky.id == id).ok_or_else(|| "That sticky is gone.".into())
}

/// From the menu, a shortcut or the Library: a new sticky on the screen, focused for typing.
#[tauri::command]
pub async fn sticky_new(app: AppHandle, hue: Option<String>, text: Option<String>) -> Result<Sticky, String> {
  let (done, made) = std::sync::mpsc::channel();
  let handle = app.clone();
  app.run_on_main_thread(move || { let _ = done.send(create(&handle, hue.as_deref(), text.as_deref())); }).map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || made.recv().map_err(|_| "Couldn’t make a sticky.".to_owned())?).await.map_err(|e| e.to_string())?
}

/// The sticky's own window: its words as they are typed, or a new colour.
#[tauri::command]
pub fn sticky_update(app: AppHandle, id: String, text: Option<String>, hue: Option<String>) -> Result<Sticky, String> {
  let mut list = all(&app);
  let sticky = list.iter_mut().find(|sticky| sticky.id == id).ok_or("That sticky is gone.")?;
  if let Some(text) = text { sticky.text = text.chars().take(MAX_TEXT).collect(); }
  if let Some(hue) = hue { sticky.hue = hue_or(Some(&hue), &sticky.hue.clone()); }
  sticky.updated_ms = now_ms();
  let kept = sticky.clone();
  changed(&app, &list)?;
  Ok(kept)
}

/// Closed: the sticky is gone, window and record both.
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
  let sticky = all(&app).into_iter().find(|sticky| sticky.id == id).ok_or("That sticky is gone.")?;
  if sticky.text.trim().is_empty() { return Err("Write something first.".into()); }
  let mut lines = sticky.text.trim().lines().map(str::trim).filter(|line| !line.is_empty());
  let title: String = lines.next().unwrap_or("Sticky").chars().take(80).collect();
  let path = crate::notes::save_note(app.clone(), title, sticky.text.clone(), stamp, Some(true)).await?;
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
  }
}
