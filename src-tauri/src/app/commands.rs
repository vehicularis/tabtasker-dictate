//! What the pages ask for, beyond what each feature's own commands do.
use super::events::emit;
use super::{menu::show_paused, windows, FIRST_RUN};
use super::{dictate_meeting, dictate_open_at_login, dictate_overlay_layout, dictate_play_sound, dictate_request, dictate_set_enabled, dictate_set_input, dictate_settings_status, dictate_type_text};
use crate::dictation::history;
use crate::library::notes;
use crate::{meetings, settings};
use std::ffi::{CStr, CString};
use std::sync::atomic::Ordering;
use tauri::AppHandle;

/// Runs `work` on the main thread, where AppKit and the native voice state live.
async fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  let (done, result) = tokio::sync::oneshot::channel();
  app.run_on_main_thread(move || { let _ = done.send(work()); }).map_err(|e| e.to_string())?;
  result.await.map_err(|e| e.to_string())
}

pub(crate) fn status_json() -> Option<String> {
  let mut output = vec![0u8; 16384];
  unsafe { dictate_settings_status(output.as_mut_ptr().cast(), output.len()) }.then(|| CStr::from_bytes_until_nul(&output).map(|text| text.to_string_lossy().into_owned()).ok()).flatten()
}

#[tauri::command]
pub(crate) async fn status(app: AppHandle) -> Result<serde_json::Value, String> {
  let json = on_main(&app, status_json).await?.ok_or("Couldn’t load your settings. Quit Dictate and open it again.")?;
  let mut value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
  value["notes"] = serde_json::Value::String(notes::notes_dir()?.display().to_string());
  value["home"] = std::env::var("HOME").map_or(serde_json::Value::Null, serde_json::Value::String);
  value["firstRun"] = FIRST_RUN.load(Ordering::Relaxed).into();
  show_paused(value["enabled"] == false);
  Ok(value)
}

#[tauri::command]
pub(crate) async fn set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
  on_main(&app, move || unsafe { dictate_set_enabled(enabled) }).await?;
  show_paused(!enabled);
  Ok(())
}

/// The microphone picked in the menu, by its CoreAudio UID; none for the Mac's own input.
#[tauri::command]
pub(crate) async fn set_input(app: AppHandle, id: Option<String>) -> Result<(), String> {
  let id = id.map(CString::new).transpose().map_err(|e| e.to_string())?;
  on_main(&app, move || unsafe { dictate_set_input(id.as_ref().map_or(std::ptr::null(), |id| id.as_ptr())) }).await
}

#[tauri::command]
pub(crate) async fn set_open_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
  on_main(&app, move || unsafe { dictate_open_at_login(enabled as i32) }).await
}

/// Setup and recording actions: open macOS's microphone or Accessibility prompts, start or stop a note,
/// send or cancel hands-free listening.
#[tauri::command]
pub(crate) async fn request(app: AppHandle, kind: String) -> Result<(), String> {
  if !matches!(kind.as_str(), "microphone" | "accessibility" | "keyboard" | "note" | "send" | "cancel") { return Err("Unknown request".into()); }
  let kind = CString::new(kind).map_err(|e| e.to_string())?;
  on_main(&app, move || unsafe { dictate_request(kind.as_ptr()) }).await
}

/// Where the page draws its glass (blur goes behind it) and which parts take clicks.
#[tauri::command]
pub(crate) fn layout(app: AppHandle, glass: Vec<[f64; 6]>, hit: Vec<[f64; 4]>, dark: Option<bool>) -> Result<(), String> {
  if glass.len() > 16 || hit.len() > 16 { return Err("Invalid layout".into()); }
  let json = CString::new(serde_json::json!({ "glass": glass, "hit": hit, "dark": dark.unwrap_or(true) }).to_string()).map_err(|e| e.to_string())?;
  app.run_on_main_thread(move || unsafe { dictate_overlay_layout(json.as_ptr()) }).map_err(|e| e.to_string())
}

/// A meeting from the menu or the dots: `start` or `stop`. False when nothing changed; an error says
/// why a meeting couldn't start.
#[tauri::command]
pub(crate) async fn meeting(app: AppHandle, action: String) -> Result<bool, String> {
  if !matches!(action.as_str(), "start" | "stop") { return Err("Unknown action".into()); }
  let action = CString::new(action).map_err(|e| e.to_string())?;
  let changed = on_main(&app, move || unsafe { dictate_meeting(action.as_ptr()) }).await?;
  match meetings::start_problem() { Some(why) if !changed => Err(why), _ => Ok(changed) }
}

/// Opens the app's window at `route` (notes, meetings, stickies, ask, settings, settings/<page>, setup), or
/// brings it forward where it is when there is none.
#[tauri::command]
pub(crate) fn open_app(app: AppHandle, route: Option<String>) -> Result<(), String> {
  windows::show_main(&app, route.as_deref()).map_err(|e| e.to_string())
}

/// Types the newest transcript again where the cursor is.
#[tauri::command]
pub(crate) fn paste_last(app: AppHandle) {
  match history::last() {
    Some(entry) => {
      let Ok(text) = CString::new(entry.text) else { return };
      let _ = app.run_on_main_thread(move || unsafe { dictate_type_text(text.as_ptr()) });
    }
    None => emit("dictate-notice", serde_json::json!({ "message": "There’s nothing to paste yet." })),
  }
}

/// Dictation › Sounds: plays one of the Mac's sounds once, at `volume`, so a choice can be heard before it is kept.
#[tauri::command]
pub(crate) fn play_sound(app: AppHandle, name: String, volume: f64) -> Result<(), String> {
  if !settings::SOUNDS.contains(&name.as_str()) { return Err("That isn’t one of the Mac’s sounds.".into()); }
  let name = CString::new(name).map_err(|_| "Invalid sound".to_owned())?;
  let volume = if volume.is_finite() { volume.clamp(0.0, 1.0) } else { 0.3 };
  app.run_on_main_thread(move || unsafe { dictate_play_sound(name.as_ptr(), volume) }).map_err(|e| e.to_string())
}

/// Quit, from the dots' menu (the tray and the app menu have their own item).
#[tauri::command]
pub(crate) fn quit(app: AppHandle) { app.exit(0); }

/// A note or meeting, opened in the app's window on its own page.
#[tauri::command]
pub(crate) fn note_open(app: AppHandle, path: String) -> Result<(), String> { windows::show_note(&app, &path) }
