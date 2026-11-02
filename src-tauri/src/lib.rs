//! TabTasker Dictate: hold fn to type with your voice anywhere, or take a long spoken note that is saved
//! as a Markdown file. Speech never leaves the Mac: Whisper runs locally on Metal.
//!
//! The native side (dictate.m) owns the fn key, the microphone and typing; speech.rs owns the model. This
//! file is the app around them: the overlay and Settings windows, the menu bar item, the app menu, and
//! the bridge to the pages.
pub mod ai;
pub mod context;
pub mod history;
pub mod notes;
pub mod settings;
pub mod speech;
pub mod text;

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{ActivationPolicy, AppHandle, Emitter, LogicalPosition, Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};

const OVERLAY: &str = "overlay";
const SETTINGS: &str = "settings";
/// The Settings window's pages, by the hash it opens on.
const ROUTES: &[&str] = &["general", "shortcuts", "dictation", "vocabulary", "apps", "notes", "meetings", "claude", "agents", "history", "appearance", "about", "setup"];
static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" {
  fn dictate_init();
  fn dictate_settings_status(output: *mut c_char, capacity: usize) -> bool;
  fn dictate_set_enabled(enabled: bool);
  fn dictate_set_input(uid: *const c_char);
  fn dictate_open_at_login(set: i32) -> bool;
  fn dictate_request(kind: *const c_char);
  fn dictate_overlay_attach(window: *mut c_void);
  fn dictate_overlay_layout(json: *const c_char);
  fn dictate_type_text(text: *const c_char);
  fn dictate_meeting(action: *const c_char) -> bool;
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
/// To every window: setup in Settings tests the key too.
#[no_mangle]
extern "C" fn dictate_ui_fn(down: bool) {
  if let Some(app) = APP.get() { let _ = app.emit("dictate-fn", serde_json::json!({ "down": down })); }
}
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
  if let (Some(app), Some(id)) = (APP.get(), text(request)) { speech::cancel(app, &id); context::forget(&id); }
}

// ---------- what the pages ask for ----------

/// Runs `work` on the main thread, where AppKit and the native voice state live.
async fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  let (done, result) = tokio::sync::oneshot::channel();
  app.run_on_main_thread(move || { let _ = done.send(work()); }).map_err(|e| e.to_string())?;
  result.await.map_err(|e| e.to_string())
}

fn status_json() -> Option<String> {
  let mut output = vec![0u8; 16384];
  unsafe { dictate_settings_status(output.as_mut_ptr().cast(), output.len()) }.then(|| CStr::from_bytes_until_nul(&output).map(|text| text.to_string_lossy().into_owned()).ok()).flatten()
}

#[tauri::command]
async fn status(app: AppHandle) -> Result<serde_json::Value, String> {
  let json = on_main(&app, status_json).await?.ok_or("Voice settings are unavailable")?;
  let mut value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
  value["notes"] = serde_json::Value::String(notes::notes_dir()?.display().to_string());
  value["home"] = std::env::var("HOME").map_or(serde_json::Value::Null, serde_json::Value::String);
  show_paused(value["enabled"] == false);
  Ok(value)
}

#[tauri::command]
async fn set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
  on_main(&app, move || unsafe { dictate_set_enabled(enabled) }).await?;
  show_paused(!enabled);
  Ok(())
}

/// The microphone picked in the menu, by its CoreAudio UID; none for the Mac's own input.
#[tauri::command]
async fn set_input(app: AppHandle, id: Option<String>) -> Result<(), String> {
  let id = id.map(CString::new).transpose().map_err(|e| e.to_string())?;
  on_main(&app, move || unsafe { dictate_set_input(id.as_ref().map_or(std::ptr::null(), |id| id.as_ptr())) }).await
}

#[tauri::command]
async fn set_open_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
  on_main(&app, move || unsafe { dictate_open_at_login(enabled as i32) }).await
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

/// A meeting from the menu or the dots: `start` or `stop`. False when nothing changed.
#[tauri::command]
async fn meeting(app: AppHandle, action: String) -> Result<bool, String> {
  if !matches!(action.as_str(), "start" | "stop") { return Err("Unknown action".into()); }
  let action = CString::new(action).map_err(|e| e.to_string())?;
  on_main(&app, move || unsafe { dictate_meeting(action.as_ptr()) }).await
}

/// Opens the Settings window on `route`, or brings it forward on the page it shows when there is none.
#[tauri::command]
fn open_settings(app: AppHandle, route: Option<String>) -> Result<(), String> {
  show_settings(&app, route.as_deref()).map_err(|e| e.to_string())
}

/// Types the newest transcript again where the cursor is.
#[tauri::command]
fn paste_last(app: AppHandle) {
  match history::last() {
    Some(entry) => {
      let Ok(text) = CString::new(entry.text) else { return };
      let _ = app.run_on_main_thread(move || unsafe { dictate_type_text(text.as_ptr()) });
    }
    None => emit("dictate-notice", serde_json::json!({ "message": "Nothing to paste yet" })),
  }
}

fn start_meeting(app: &AppHandle) {
  let app = app.clone();
  let _ = app.clone().run_on_main_thread(move || {
    if !unsafe { dictate_meeting(c"start".as_ptr()) } { let _ = app.emit_to(OVERLAY, "dictate-notice", serde_json::json!({ "message": "Couldn’t start the meeting" })); }
  });
}

// ---------- the windows ----------

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

/// The Settings window, made on demand. While it is open the app has a Dock icon and a menu bar, like
/// any app with a window; closing it goes back to the menu bar only. With no `route`, an open window
/// keeps its page and a new one starts on General.
fn show_settings(app: &AppHandle, route: Option<&str>) -> tauri::Result<()> {
  let route = route.map(|route| if ROUTES.contains(&route) { route } else { "general" });
  app.set_activation_policy(ActivationPolicy::Regular)?;
  if let Some(window) = app.get_webview_window(SETTINGS) {
    if let Some(route) = route { window.eval(format!("location.hash = '#{route}'"))?; }
    window.unminimize()?;
    window.show()?;
    return window.set_focus();
  }
  let window = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App(format!("settings.html#{}", route.unwrap_or("general")).into()))
    .title("TabTasker Dictate")
    .inner_size(860.0, 620.0).min_inner_size(760.0, 540.0).center()
    .title_bar_style(TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(LogicalPosition::new(20.0, 22.0))
    .transparent(true) // the sidebar's vibrancy shows through the page
    .effects(EffectsBuilder::new().effect(Effect::Sidebar).state(EffectState::FollowsWindowActiveState).build())
    .build()?;
  window.set_focus()
}

// ---------- the menus ----------

/// The menu bar while Settings is open. Its shortcuts work whenever the app is active, and the Edit
/// items are what make ⌘C and ⌘V work in a web view at all.
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
  let separator = || PredefinedMenuItem::separator(app);
  let main = Submenu::with_items(app, "TabTasker Dictate", true, &[
    &MenuItem::with_id(app, "about", "About TabTasker Dictate", true, None::<&str>)?, &separator()?,
    &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?, &separator()?,
    &PredefinedMenuItem::services(app, None)?, &separator()?,
    &PredefinedMenuItem::hide(app, None)?, &PredefinedMenuItem::hide_others(app, None)?, &PredefinedMenuItem::show_all(app, None)?, &separator()?,
    &MenuItem::with_id(app, "quit", "Quit TabTasker Dictate", true, Some("CmdOrCtrl+Q"))?,
  ])?;
  let edit = Submenu::with_items(app, "Edit", true, &[
    &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?, &separator()?,
    &PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?,
    &PredefinedMenuItem::select_all(app, None)?,
  ])?;
  let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::close_window(app, None)?])?;
  window.set_as_windows_menu_for_nsapp()?;
  Menu::with_items(app, &[&main, &edit, &window])
}

/// The tray's Recent Notes, and the files its items open.
static RECENT: OnceLock<(Submenu<Wry>, Mutex<Vec<PathBuf>>)> = OnceLock::new();
static PAUSED: OnceLock<CheckMenuItem<Wry>> = OnceLock::new();

/// Rebuilds Recent Notes from the notes folder: after a save, or when the folder changes.
pub(crate) fn recent_changed(app: &AppHandle) {
  let Some((menu, files)) = RECENT.get() else { return };
  let notes = notes::recent(10);
  let rebuild = || -> tauri::Result<()> {
    while menu.remove_at(0)?.is_some() {}
    if notes.is_empty() { return menu.append(&MenuItem::with_id(app, "recent-none", "No notes yet", false, None::<&str>)?); }
    for (i, note) in notes.iter().enumerate() { menu.append(&MenuItem::with_id(app, format!("recent:{i}"), &note.title, true, None::<&str>)?)?; }
    Ok(())
  };
  if let Err(e) = rebuild() { log::warn!("recent notes: {e}"); }
  *files.lock().unwrap_or_else(|e| e.into_inner()) = notes.into_iter().map(|note| note.path).collect();
}

fn show_paused(paused: bool) {
  if let Some(item) = PAUSED.get() { let _ = item.set_checked(paused); }
}

fn tray(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
  let separator = || PredefinedMenuItem::separator(app);
  let recent = Submenu::with_id(app, "recent", "Recent Notes", true)?;
  let paused = CheckMenuItem::with_id(app, "pause", "Pause Dictation", true, !enabled, None::<&str>)?;
  let menu = Menu::with_items(app, &[
    &MenuItem::with_id(app, "note", "New Note", true, None::<&str>)?,
    &MenuItem::with_id(app, "meeting", "Start Meeting", true, None::<&str>)?,
    &MenuItem::with_id(app, "paste-last", "Paste Last Transcript", true, None::<&str>)?,
    &recent, &separator()?,
    &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
    &MenuItem::with_id(app, "setup", "Set Up…", true, None::<&str>)?,
    &MenuItem::with_id(app, "notes", "Show Notes in Finder", true, None::<&str>)?, &separator()?,
    &paused, &separator()?,
    &MenuItem::with_id(app, "quit", "Quit TabTasker Dictate", true, Some("CmdOrCtrl+Q"))?,
  ])?;
  let _ = RECENT.set((recent, Mutex::default()));
  let _ = PAUSED.set(paused);
  recent_changed(app);
  // The mark alone, in black: macOS tints a template icon for the menu bar's light or dark look.
  let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
  TrayIconBuilder::with_id("dictate").menu(&menu).tooltip("TabTasker Dictate").icon(icon).icon_as_template(true).build(app)?;
  Ok(())
}

/// The tray's and the app menu's items, by id. Tauri hands every menu's events to one handler.
fn menu_event(app: &AppHandle, id: &str) {
  match id {
    "note" => { let _ = app.run_on_main_thread(|| unsafe { dictate_request(c"note".as_ptr()) }); }
    "meeting" => start_meeting(app),
    "paste-last" => paste_last(app.clone()),
    "notes" => { let _ = notes::show_notes(None); }
    "settings" => { let _ = show_settings(app, None); }
    "about" => { let _ = show_settings(app, Some("about")); }
    "setup" => { let _ = app.emit_to(OVERLAY, "dictate-setup", ()); }
    // The item has already flipped its own check.
    "pause" => {
      let paused = PAUSED.get().and_then(|item| item.is_checked().ok()).unwrap_or(false);
      let _ = app.run_on_main_thread(move || unsafe { dictate_set_enabled(!paused) });
    }
    "quit" => app.exit(0),
    _ => {
      let Some(index) = id.strip_prefix("recent:").and_then(|i| i.parse::<usize>().ok()) else { return };
      let file = RECENT.get().and_then(|(_, files)| files.lock().unwrap_or_else(|e| e.into_inner()).get(index).cloned());
      if let Some(file) = file { let _ = std::process::Command::new("/usr/bin/open").arg(file).spawn(); }
    }
  }
}

pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      status, set_enabled, set_input, set_open_at_login, request, layout, meeting, open_settings, paste_last,
      notes::save_note, notes::show_notes, settings::get_settings, settings::update_settings, settings::reset_settings,
      speech::speech_models, speech::prepare_model, speech::vocabulary_fit, text::list_apps,
    ])
    .setup(|app| {
      app.set_activation_policy(ActivationPolicy::Accessory); // a menu bar app: no Dock icon
      let handle = app.handle().clone();
      APP.get_or_init(|| handle.clone());
      settings::init(&handle)?;
      speech::init(&handle)?;
      unsafe { dictate_init() };
      settings::apply(&handle, &settings::get());
      overlay(&handle)?;
      handle.set_menu(app_menu(&handle)?)?;
      let enabled = status_json().and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok()).is_some_and(|status| status["enabled"] == true);
      tray(&handle, enabled)?;
      Ok(())
    })
    .on_menu_event(|app, event| menu_event(app, event.id().as_ref()))
    .on_window_event(|window, event| {
      if window.label() == SETTINGS && matches!(event, WindowEvent::Destroyed) {
        let _ = window.app_handle().set_activation_policy(ActivationPolicy::Accessory);
      }
    })
    .build(tauri::generate_context!())
    .expect("TabTasker Dictate failed to start")
    .run(|app, event| if let RunEvent::Exit = event { speech::shutdown(app) });
}
