//! TabTasker Dictate: hold fn to type with your voice anywhere, or take a long spoken note that is saved
//! as a Markdown file. Speech never leaves the Mac: Whisper runs locally on Metal.
//!
//! The native side (dictate.m) owns the fn key, the microphone and typing; speech.rs owns the model. This
//! file is the app around them: the overlay window, the menu bar item, and the bridge to the page.
mod speech;

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, RunEvent, WebviewUrl, WebviewWindowBuilder};

const OVERLAY: &str = "overlay";
static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" {
  fn dictate_init();
  fn dictate_settings_status(output: *mut c_char, capacity: usize) -> bool;
  fn dictate_set_enabled(enabled: bool);
  fn dictate_set_input(uid: *const c_char);
  fn dictate_request(kind: *const c_char);
  fn dictate_overlay_attach(window: *mut c_void);
  fn dictate_overlay_layout(json: *const c_char);
}

// ---------- what the native side tells the page ----------

fn emit(event: &str, payload: serde_json::Value) {
  if let Some(app) = APP.get() { let _ = app.emit_to(OVERLAY, event, payload); }
}
fn text(text: *const c_char) -> Option<String> {
  (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned())
}

#[no_mangle]
extern "C" fn dictate_ui_state(phase: *const c_char, level: f64, dictating: bool) {
  let Some(phase) = text(phase) else { return };
  if !level.is_finite() { return; }
  emit("dictate-state", serde_json::json!({ "phase": phase, "level": level.clamp(0.0, 1.0), "dictating": dictating }));
}
#[no_mangle]
extern "C" fn dictate_ui_error(message: *const c_char) {
  let Some(message) = text(message) else { return };
  if message != "unheard" { log::warn!("voice: {message}"); }
  emit("dictate-error", serde_json::json!({ "message": message }));
}
#[no_mangle]
extern "C" fn dictate_ui_notice(message: *const c_char) {
  if let Some(message) = text(message) { emit("dictate-notice", serde_json::json!({ "message": message })); }
}
#[no_mangle]
extern "C" fn dictate_ui_fn(down: bool) { emit("dictate-fn", serde_json::json!({ "down": down })); }
#[no_mangle]
extern "C" fn dictate_ui_said(words: *const c_char, dictated: bool, live: bool) {
  if let Some(words) = text(words) { emit("dictate-said", serde_json::json!({ "text": words, "dictated": dictated, "live": live })); }
}
/// A note is done: its words go to the review card.
#[no_mangle]
extern "C" fn dictate_ui_note(words: *const c_char) {
  if let Some(words) = text(words) { emit("dictate-note", serde_json::json!({ "text": words })); }
}
/// The pointer over the overlay's clickable parts, in page coordinates (null once it leaves them).
#[no_mangle]
extern "C" fn dictate_ui_pointer(over: bool, x: f64, y: f64) {
  let at = if over && x.is_finite() && y.is_finite() { serde_json::json!({ "x": x, "y": y }) } else { serde_json::Value::Null };
  emit("dictate-pointer", at);
}
/// A line for the app log: no speech, just what the microphone delivered.
#[no_mangle]
extern "C" fn dictate_log(line: *const c_char) {
  if let Some(line) = text(line) { log::info!("voice {line}"); }
}
#[no_mangle]
extern "C" fn dictate_cancel(request: *const c_char) {
  if let (Some(app), Some(id)) = (APP.get(), text(request)) { speech::cancel(app, &id); }
}

// ---------- what the page asks for ----------

/// Runs `work` on the main thread, where AppKit and the native voice state live.
async fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  let (done, result) = tokio::sync::oneshot::channel();
  app.run_on_main_thread(move || { let _ = done.send(work()); }).map_err(|e| e.to_string())?;
  result.await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn status(app: AppHandle) -> Result<serde_json::Value, String> {
  let json = on_main(&app, || {
    let mut output = vec![0u8; 16384];
    unsafe { dictate_settings_status(output.as_mut_ptr().cast(), output.len()) }.then(|| CStr::from_bytes_until_nul(&output).map(|text| text.to_string_lossy().into_owned()).ok()).flatten()
  }).await?.ok_or("Voice settings are unavailable")?;
  let mut value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
  value["notes"] = serde_json::Value::String(notes_dir()?.display().to_string());
  Ok(value)
}

#[tauri::command]
async fn set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
  on_main(&app, move || unsafe { dictate_set_enabled(enabled) }).await
}

/// The microphone picked in the menu, by its CoreAudio UID; none for the Mac's own input.
#[tauri::command]
async fn set_input(app: AppHandle, id: Option<String>) -> Result<(), String> {
  let id = id.map(CString::new).transpose().map_err(|e| e.to_string())?;
  on_main(&app, move || unsafe { dictate_set_input(id.as_ref().map_or(std::ptr::null(), |id| id.as_ptr())) }).await
}

/// Setup and recording actions: open macOS's microphone or Accessibility prompts, start or stop a note.
#[tauri::command]
async fn request(app: AppHandle, kind: String) -> Result<(), String> {
  if !matches!(kind.as_str(), "microphone" | "accessibility" | "keyboard" | "note") { return Err("Unknown request".into()); }
  let kind = CString::new(kind).map_err(|e| e.to_string())?;
  on_main(&app, move || unsafe { dictate_request(kind.as_ptr()) }).await
}

/// Where the page draws its glass (blur goes behind it) and which parts take clicks.
#[tauri::command]
fn layout(app: AppHandle, glass: Vec<[f64; 6]>, hit: Vec<[f64; 4]>, dark: Option<bool>) -> Result<(), String> {
  if glass.len() > 16 || hit.len() > 16 { return Err("Invalid layout".into()); }
  let json = CString::new(serde_json::json!({ "glass": glass, "hit": hit, "dark": dark.unwrap_or(true) }).to_string()).map_err(|e| e.to_string())?;
  app.run_on_main_thread(move || unsafe { dictate_overlay_layout(json.as_ptr()) }).map_err(|e| e.to_string())
}

/// Notes go to Documents/TabTasker Dictate, one Markdown file each.
fn notes_dir() -> Result<PathBuf, String> {
  let home = std::env::var_os("HOME").ok_or("No home folder")?;
  Ok(PathBuf::from(home).join("Documents").join("TabTasker Dictate"))
}

/// A file name from the note's title: what a Mac allows, short, never an existing note's.
fn note_path(dir: &std::path::Path, title: &str, stamp: &str) -> PathBuf {
  let clean: String = title.chars().map(|c| if c == '/' || c == ':' || c.is_control() { ' ' } else { c }).collect();
  let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
  let clean: String = clean.trim_start_matches('.').chars().take(80).collect();
  let base = if clean.is_empty() { format!("Note {stamp}") } else { format!("{stamp} {clean}") };
  let mut path = dir.join(format!("{base}.md"));
  let mut n = 2;
  while path.exists() { path = dir.join(format!("{base} {n}.md")); n += 1; }
  path
}

#[tauri::command]
fn save_note(title: String, text: String, stamp: String) -> Result<String, String> {
  if text.trim().is_empty() || text.chars().count() > 1_000_000 { return Err("Nothing to save".into()); }
  if !stamp.chars().all(|c| c.is_ascii_digit() || c == '-' || c == ' ' || c == '.') || stamp.len() > 20 { return Err("Invalid date".into()); }
  let dir = notes_dir()?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t make the notes folder: {e}"))?;
  let path = note_path(&dir, &title, &stamp);
  let heading = title.trim();
  let body = if heading.is_empty() { format!("{}\n", text.trim()) } else { format!("# {heading}\n\n{}\n", text.trim()) };
  std::fs::write(&path, body).map_err(|e| format!("Couldn’t save the note: {e}"))?;
  Ok(path.display().to_string())
}

/// Shows the notes folder in Finder, with `file` selected when given.
#[tauri::command]
fn show_notes(file: Option<String>) -> Result<(), String> {
  let dir = notes_dir()?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let mut open = std::process::Command::new("/usr/bin/open");
  match file.map(PathBuf::from).filter(|file| file.starts_with(&dir)) {
    Some(file) => open.arg("-R").arg(file),
    None => open.arg(dir),
  };
  open.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------- the app ----------

fn overlay(app: &AppHandle) -> tauri::Result<()> {
  let window = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("index.html".into()))
    .title("TabTasker Dictate")
    .decorations(false).transparent(true).shadow(false)
    .always_on_top(true).visible_on_all_workspaces(true).skip_taskbar(true).resizable(false).focused(false)
    .visible(false) // dictate.m shows it once the page has drawn the overlay
    .accept_first_mouse(true) // the overlay is never key while another app is in front
    .build()?;
  if let Ok(native) = window.ns_window() { unsafe { dictate_overlay_attach(native) }; }
  Ok(())
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
  let note = MenuItem::with_id(app, "note", "New Note", true, None::<&str>)?;
  let notes = MenuItem::with_id(app, "notes", "Show Notes in Finder", true, None::<&str>)?;
  let setup = MenuItem::with_id(app, "setup", "Set Up…", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Quit TabTasker Dictate", true, Some("CmdOrCtrl+Q"))?;
  let menu = Menu::with_items(app, &[&note, &notes, &PredefinedMenuItem::separator(app)?, &setup, &PredefinedMenuItem::separator(app)?, &quit])?;
  let mut builder = TrayIconBuilder::with_id("dictate").menu(&menu).tooltip("TabTasker Dictate").icon_as_template(true);
  if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }
  builder.on_menu_event(|app, event| match event.id().as_ref() {
    "note" => { let _ = app.run_on_main_thread(|| unsafe { dictate_request(c"note".as_ptr()) }); }
    "notes" => { let _ = show_notes(None); }
    "setup" => { let _ = app.emit_to(OVERLAY, "dictate-setup", ()); }
    "quit" => app.exit(0),
    _ => {}
  }).build(app)?;
  Ok(())
}

pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![status, set_enabled, set_input, request, layout, save_note, show_notes])
    .setup(|app| {
      app.set_activation_policy(tauri::ActivationPolicy::Accessory); // a menu bar app: no Dock icon
      let handle = app.handle().clone();
      APP.get_or_init(|| handle.clone());
      speech::init(&handle)?;
      unsafe { dictate_init() };
      overlay(&handle)?;
      tray(&handle)?;
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("TabTasker Dictate failed to start")
    .run(|app, event| if let RunEvent::Exit = event { speech::shutdown(app) });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_note_file_is_named_for_its_title_and_never_overwrites_another() {
    let dir = std::env::temp_dir().join(format!("dictate-notes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let first = note_path(&dir, "Call the venue: about Thursday", "2026-11-01 21.40");
    assert_eq!(first.file_name().unwrap(), "2026-11-01 21.40 Call the venue about Thursday.md");
    std::fs::write(&first, "x").unwrap();
    assert_eq!(note_path(&dir, "Call the venue: about Thursday", "2026-11-01 21.40").file_name().unwrap(), "2026-11-01 21.40 Call the venue about Thursday 2.md");
    assert_eq!(note_path(&dir, "../../etc/passwd", "2026-11-01 21.40").parent().unwrap(), dir); // a slash is never a folder
    assert_eq!(note_path(&dir, "  ", "2026-11-01 21.40").file_name().unwrap(), "Note 2026-11-01 21.40.md");
    std::fs::remove_dir_all(dir).unwrap();
  }
}
