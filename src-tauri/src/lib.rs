//! TabTasker Dictate: hold fn to type with your voice anywhere, or take a long spoken note that is saved
//! as a Markdown file. Speech never leaves the Mac: Whisper runs locally on Metal.
//!
//! The native side (dictate.m) owns the fn key, the microphone and typing; speech.rs owns the model. This
//! file is the app around them: the overlay and Settings windows, the menu bar item, the app menu, and
//! the bridge to the pages.
pub mod ai;
pub mod context;
pub mod history;
pub mod mcp;
pub mod meeting;
pub mod notes;
pub mod settings;
pub mod speech;
pub mod stickies;
pub mod text;

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{ActivationPolicy, AppHandle, Emitter, LogicalPosition, Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};

const OVERLAY: &str = "overlay";
const SETTINGS: &str = "settings";
/// A note's editor window: this, then a hash of the file's path.
const NOTE: &str = "note-";
/// The Settings window's pages, by the hash it opens on.
const ROUTES: &[&str] = &["general", "shortcuts", "dictation", "vocabulary", "apps", "library", "notes", "meetings", "claude", "agents", "history", "appearance", "about", "setup"];
static APP: OnceLock<AppHandle> = OnceLock::new();
/// This launch is the first and opened the full setup, so the overlay keeps its own setup card closed.
static FIRST_RUN: AtomicBool = AtomicBool::new(false);

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
  fn dictate_play_sound(name: *const c_char, volume: f64);
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
/// A global shortcut for something drawn by a page: a note to type or a question for Claude (the overlay
/// opens its card), or a sticky, which is a window of its own.
#[no_mangle]
extern "C" fn dictate_ui_open(what: *const c_char) {
  let Some(what) = text(what) else { return };
  if what == "sticky" {
    if let Some(app) = APP.get() { if let Err(e) = stickies::create(app, None, None) { emit("dictate-notice", serde_json::json!({ "message": e })); } }
    return;
  }
  emit("dictate-open", serde_json::json!({ "what": what }));
}
/// Hands-free listening locked by a double tap of the dictate key, or over.
#[no_mangle]
extern "C" fn dictate_ui_hands_free(locked: bool) {
  emit("dictate-hands-free", serde_json::json!({ "locked": locked }));
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
  value["firstRun"] = FIRST_RUN.load(Ordering::Relaxed).into();
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

/// Setup and recording actions: open macOS's microphone or Accessibility prompts, start or stop a note,
/// send or cancel hands-free listening.
#[tauri::command]
async fn request(app: AppHandle, kind: String) -> Result<(), String> {
  if !matches!(kind.as_str(), "microphone" | "accessibility" | "keyboard" | "note" | "send" | "cancel") { return Err("Unknown request".into()); }
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

/// A meeting from the menu or the dots: `start` or `stop`. False when nothing changed; an error says
/// why a meeting couldn't start.
#[tauri::command]
async fn meeting(app: AppHandle, action: String) -> Result<bool, String> {
  if !matches!(action.as_str(), "start" | "stop") { return Err("Unknown action".into()); }
  let action = CString::new(action).map_err(|e| e.to_string())?;
  let changed = on_main(&app, move || unsafe { dictate_meeting(action.as_ptr()) }).await?;
  match meeting::start_problem() { Some(why) if !changed => Err(why), _ => Ok(changed) }
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

/// Paste Last Transcript from its chord.
/// Dictation › Sounds: plays one of the Mac's sounds once, at `volume`, so a choice can be heard before it is kept.
#[tauri::command]
fn play_sound(app: AppHandle, name: String, volume: f64) -> Result<(), String> {
  if !settings::SOUNDS.contains(&name.as_str()) { return Err("That isn’t one of the Mac’s sounds.".into()); }
  let name = CString::new(name).map_err(|_| "Invalid sound".to_owned())?;
  let volume = if volume.is_finite() { volume.clamp(0.0, 1.0) } else { 0.3 };
  app.run_on_main_thread(move || unsafe { dictate_play_sound(name.as_ptr(), volume) }).map_err(|e| e.to_string())
}

#[no_mangle]
extern "C" fn dictate_paste_last() {
  if let Some(app) = APP.get() { paste_last(app.clone()); }
}

/// The tray's meeting item starts one, or stops the one recording.
fn start_meeting(app: &AppHandle) {
  let app = app.clone();
  let _ = app.clone().run_on_main_thread(move || {
    if !unsafe { dictate_meeting(c"toggle".as_ptr()) } {
      let why = meeting::start_problem().unwrap_or_else(|| "Couldn’t start the meeting".into());
      let _ = app.emit_to(OVERLAY, "dictate-notice", serde_json::json!({ "message": why }));
    }
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
    .title_bar_style(TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(LogicalPosition::new(12.0, 21.0)) // centred on the page's 38-point title strip: Tauri keeps the buttons 10 pt up inside a container it makes `y` taller, so their centre lands at y - 2
    .transparent(true) // the sidebar's vibrancy shows through the page
    .effects(EffectsBuilder::new().effect(Effect::Sidebar).state(EffectState::FollowsWindowActiveState).build())
    .build()?;
  window.set_focus()
}

/// A note or meeting in its own editor window, one per file: made on demand, brought forward if open.
/// Like Settings, it gives the app a Dock icon and a menu bar while it is open.
#[tauri::command]
fn note_open(app: AppHandle, path: String) -> Result<(), String> { show_note(&app, &path) }

fn show_note(app: &AppHandle, path: &str) -> Result<(), String> {
  let file = notes::in_library(path)?;
  let path = file.display().to_string();
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  std::hash::Hash::hash(&path, &mut hasher);
  let label = format!("{NOTE}{:016x}", std::hash::Hasher::finish(&hasher));
  app.set_activation_policy(ActivationPolicy::Regular).map_err(|e| e.to_string())?;
  if let Some(window) = app.get_webview_window(&label) {
    window.unminimize().and_then(|_| window.show()).and_then(|_| window.set_focus()).map_err(|e| e.to_string())?;
    return Ok(());
  }
  let title = notes::read_doc(&path).map(|doc| doc.title).unwrap_or_else(|_| "Note".into());
  let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("note.html?path={}", percent(&path)).into()))
    .title(if title.is_empty() { "Note".into() } else { title })
    .inner_size(760.0, 640.0).min_inner_size(440.0, 320.0).center()
    .title_bar_style(TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(LogicalPosition::new(12.0, 21.0)) // as Settings: centred on the page's 38-point strip
    .build().map_err(|e| e.to_string())?;
  window.set_focus().map_err(|e| e.to_string())
}

/// `text` as a URL query value: letters, digits and a path's own marks as they are, everything else as bytes.
fn percent(text: &str) -> String {
  text.bytes().map(|byte| if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect()
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
static MEETING: OnceLock<MenuItem<Wry>> = OnceLock::new();

/// The tray's meeting item says what it will do.
pub(crate) fn meeting_changed(recording: bool) {
  if let Some(item) = MEETING.get() { let _ = item.set_text(if recording { "Stop Meeting" } else { "Start Meeting" }); }
}

/// Rebuilds Recent Notes from the notes folder: after a save, or when the folder changes.
pub(crate) fn recent_changed(app: &AppHandle) {
  let Some((menu, files)) = RECENT.get() else { return };
  let notes = notes::recent(10);
  let handle = app.clone();
  // Off the main thread each menu call is its own trip there, so rebuilds from two threads could interleave
  // into duplicate items. On it, this runs at once and whole.
  let rebuilt = app.run_on_main_thread(move || {
    let app = &handle;
    let rebuild = || -> tauri::Result<()> {
      while menu.remove_at(0)?.is_some() {}
      if notes.is_empty() { return menu.append(&MenuItem::with_id(app, "recent-none", "No notes yet", false, None::<&str>)?); }
      for (i, note) in notes.iter().enumerate() { menu.append(&MenuItem::with_id(app, format!("recent:{i}"), &note.title, true, None::<&str>)?)?; }
      Ok(())
    };
    if let Err(e) = rebuild() { log::warn!("recent notes: {e}"); }
    *files.lock().unwrap_or_else(|e| e.into_inner()) = notes.into_iter().map(|note| note.path).collect();
  });
  if let Err(e) = rebuilt { log::warn!("recent notes: {e}"); }
}

/// The menu bar icon, shown or hidden from General as it changes.
/// General › Show in the Dock: the app as a regular one, with a Dock icon that opens Settings, or back to
/// the menu bar only (unless Settings is open, which keeps the Dock icon until it closes).
pub(crate) fn show_in_dock(app: &AppHandle, on: bool) {
  let windowed = app.webview_windows().keys().any(|label| label == SETTINGS || label.starts_with(NOTE));
  let policy = if on || windowed { ActivationPolicy::Regular } else { ActivationPolicy::Accessory };
  if let Err(e) = app.set_activation_policy(policy) { log::warn!("dock: {e}"); }
}

pub(crate) fn show_tray(app: &AppHandle, visible: bool) {
  if let Some(tray) = app.tray_by_id("dictate") {
    if let Err(e) = tray.set_visible(visible) { log::warn!("menu bar icon: {e}"); }
  }
}

fn show_paused(paused: bool) {
  if let Some(item) = PAUSED.get() { let _ = item.set_checked(paused); }
}

fn tray(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
  let separator = || PredefinedMenuItem::separator(app);
  let recent = Submenu::with_id(app, "recent", "Recent Notes", true)?;
  let paused = CheckMenuItem::with_id(app, "pause", "Pause Dictation", true, !enabled, None::<&str>)?;
  let meeting = MenuItem::with_id(app, "meeting", "Start Meeting", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[
    &MenuItem::with_id(app, "note", "Speak a Note", true, None::<&str>)?,
    &MenuItem::with_id(app, "write", "Write a Note", true, None::<&str>)?,
    &MenuItem::with_id(app, "sticky", "New Sticky", true, None::<&str>)?,
    &meeting,
    &MenuItem::with_id(app, "paste-last", "Paste Last Transcript", true, None::<&str>)?,
    &recent, &separator()?,
    &MenuItem::with_id(app, "library", "Library…", true, None::<&str>)?,
    &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
    &MenuItem::with_id(app, "setup", "Set Up…", true, None::<&str>)?,
    &MenuItem::with_id(app, "notes", "Show Notes in Finder", true, None::<&str>)?, &separator()?,
    &paused, &separator()?,
    &MenuItem::with_id(app, "quit", "Quit TabTasker Dictate", true, Some("CmdOrCtrl+Q"))?,
  ])?;
  let _ = RECENT.set((recent, Mutex::default()));
  let _ = PAUSED.set(paused);
  let _ = MEETING.set(meeting);
  recent_changed(app);
  // The mark alone, in black: macOS tints a template icon for the menu bar's light or dark look.
  let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
  let tray = TrayIconBuilder::with_id("dictate").menu(&menu).tooltip("TabTasker Dictate").icon(icon).icon_as_template(true).build(app)?;
  tray.set_visible(settings::get().general.menu_bar_icon)
}

/// The very first launch. The settings file is written so this happens once, and a Mac that still needs
/// its permissions gets the full setup window rather than the overlay's compact card.
fn first_run(app: &AppHandle, status: &serde_json::Value) {
  if let Err(e) = settings::update(app, &serde_json::json!({})) { log::warn!("settings: {e}"); }
  if status["microphone"] == "allowed" && status["accessibility"] == true { return; }
  FIRST_RUN.store(true, Ordering::Relaxed);
  if let Err(e) = show_settings(app, Some("setup")) { log::warn!("setup: {e}"); }
}

/// The tray's and the app menu's items, by id. Tauri hands every menu's events to one handler.
fn menu_event(app: &AppHandle, id: &str) {
  match id {
    "note" => { let _ = app.run_on_main_thread(|| unsafe { dictate_request(c"note".as_ptr()) }); }
    // The note card, with the keyboard in it; its Open in the editor button makes a file of it.
    "write" => emit("dictate-open", serde_json::json!({ "what": "writeNote" })),
    "sticky" => { if let Err(e) = stickies::create(app, None, None) { emit("dictate-notice", serde_json::json!({ "message": e })); } }
    "library" => { let _ = show_settings(app, Some("library")); }
    "meeting" => start_meeting(app),
    "paste-last" => paste_last(app.clone()),
    "notes" => { let _ = notes::show_notes(None); }
    "settings" => { let _ = show_settings(app, None); }
    "about" => { let _ = show_settings(app, Some("about")); }
    "setup" => { let _ = show_settings(app, Some("setup")); }
    // The item has already flipped its own check.
    "pause" => {
      let paused = PAUSED.get().and_then(|item| item.is_checked().ok()).unwrap_or(false);
      let _ = app.run_on_main_thread(move || unsafe { dictate_set_enabled(!paused) });
    }
    "quit" => app.exit(0),
    _ => {
      let Some(index) = id.strip_prefix("recent:").and_then(|i| i.parse::<usize>().ok()) else { return };
      let file = RECENT.get().and_then(|(_, files)| files.lock().unwrap_or_else(|e| e.into_inner()).get(index).cloned());
      // A recent note opens in the editor; one the editor can't take (moved out of the folder) goes to the Mac's default app.
      if let Some(file) = file { if show_note(app, &file.display().to_string()).is_err() { let _ = std::process::Command::new("/usr/bin/open").arg(file).spawn(); } }
    }
  }
}

// ---------- the log ----------

/// The app's own log, `~/Library/Logs/TabTasker Dictate/dictate.log`: one line a message, Info and up,
/// from this crate alone (the native code's `dictate_log` lines included), so a problem on someone's Mac
/// can be read after the fact. In a debug build the same lines go to the terminal.
struct FileLog(Mutex<Option<std::fs::File>>);

impl FileLog {
  fn open() -> Self {
    let file = std::env::var_os("HOME").map(PathBuf::from).and_then(|home| {
      let dir = home.join("Library/Logs/TabTasker Dictate");
      std::fs::create_dir_all(&dir).ok()?;
      let path = dir.join("dictate.log");
      // Kept to a few megabytes: a full log is moved aside and a new one started.
      if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 4 << 20) { let _ = std::fs::rename(&path, dir.join("dictate.old.log")); }
      std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
    });
    FileLog(Mutex::new(file))
  }
}

/// The time as "2026-11-02T13:05:09Z" from the seconds since 1970 (civil-from-days, Howard Hinnant).
fn utc_stamp(secs: u64) -> String {
  let (days, rest) = (secs / 86_400, secs % 86_400);
  let z = days as i64 + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
  let year = yoe + era * 400 + i64::from(month <= 2);
  format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

impl log::Log for FileLog {
  fn enabled(&self, meta: &log::Metadata) -> bool { meta.level() <= log::Level::Info && meta.target().starts_with(env!("CARGO_CRATE_NAME")) }
  fn log(&self, record: &log::Record) {
    if !self.enabled(record.metadata()) { return; }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |age| age.as_secs());
    let line = format!("{} {} {}\n", utc_stamp(now), record.level(), record.args());
    #[cfg(debug_assertions)] eprint!("{line}");
    if let Some(file) = &mut *self.0.lock().unwrap_or_else(|e| e.into_inner()) { use std::io::Write; let _ = file.write_all(line.as_bytes()); }
  }
  fn flush(&self) {}
}

#[cfg(test)]
mod log_tests {
  #[test]
  fn the_log_stamps_utc_time_from_seconds() {
    assert_eq!(super::utc_stamp(0), "1970-01-01T00:00:00Z");
    assert_eq!(super::utc_stamp(1_793_192_709), "2026-10-28T13:05:09Z");
    assert_eq!(super::utc_stamp(951_782_400), "2000-02-29T00:00:00Z", "a leap day");
  }
}

pub fn run() {
  if log::set_logger(Box::leak(Box::new(FileLog::open()))).is_ok() { log::set_max_level(log::LevelFilter::Info); } // one logger for the process's life
  log::info!("TabTasker Dictate {} starting", env!("CARGO_PKG_VERSION"));
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      status, set_enabled, set_input, set_open_at_login, request, layout, meeting, open_settings, paste_last, play_sound,
      notes::save_note, notes::show_notes, notes::notes_folder, notes::preview_note, notes::choose_folder, notes::library_list, notes::library_open,
      notes::note_read, notes::note_write, notes::note_new, note_open,
      stickies::sticky_list, stickies::sticky_get, stickies::sticky_new, stickies::sticky_update, stickies::sticky_remove, stickies::sticky_to_note, settings::get_settings, settings::update_settings, settings::reset_settings,
      speech::speech_models, speech::prepare_model, speech::vocabulary_fit, text::list_apps,
      history::history_list, history::history_stats, history::history_delete, history::history_clear, history::history_type,
      ai::claude_save_key, ai::claude_test, ai::claude_remove_key, ai::claude_open_console, ai::claude_insert, ai::claude_dismiss,
      ai::claude_code_find, ai::claude_code_set, ai::send_to_claude_code, ai::claude_connect_code, ai::claude_disconnect_code, ai::claude_ask,
      mcp::agents_status, mcp::agents_add,
      meeting::meeting_state, meeting::meeting_recover, meeting::meeting_reveal, meeting::meeting_privacy,
    ])
    .setup(|app| {
      app.set_activation_policy(ActivationPolicy::Accessory); // a menu bar app: no Dock icon
      let handle = app.handle().clone();
      APP.get_or_init(|| handle.clone());
      let first = handle.path().app_data_dir().is_ok_and(|dir| !dir.join("settings.json").exists());
      settings::init(&handle)?;
      history::init(&handle)?;
      ai::init(&handle);
      speech::init(&handle)?;
      meeting::init(&handle)?;
      unsafe { dictate_init() };
      settings::apply(&handle, &settings::get());
      overlay(&handle)?;
      handle.set_menu(app_menu(&handle)?)?;
      let status = status_json().and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok()).unwrap_or_default();
      tray(&handle, status["enabled"] == true)?;
      notes::watch(&handle);
      stickies::show_all(&handle);
      if first { first_run(&handle, &status); }
      Ok(())
    })
    .on_menu_event(|app, event| menu_event(app, event.id().as_ref()))
    .on_window_event(|window, event| {
      // Settings or the last note closed: back to the menu bar only, unless the Dock icon is wanted all along.
      if (window.label() == SETTINGS || window.label().starts_with(NOTE)) && matches!(event, WindowEvent::Destroyed) && !settings::get().general.show_in_dock {
        let app = window.app_handle();
        let others = app.webview_windows().keys().any(|label| label != window.label() && (label == SETTINGS || label.starts_with(NOTE)));
        if !others { let _ = app.set_activation_policy(ActivationPolicy::Accessory); }
      }
      // A sticky moved or resized comes back where it was left.
      if window.label().starts_with("sticky-") && matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) { stickies::frame_changed(window.app_handle(), window.label()); }
    })
    .build(tauri::generate_context!())
    .expect("TabTasker Dictate failed to start")
    .run(|app, event| match event {
      RunEvent::Exit => speech::shutdown(app),
      // Opening the app again from Finder, Spotlight or the Dock: the way back with the menu bar icon hidden.
      RunEvent::Reopen { .. } => { if let Err(e) = show_settings(app, None) { log::warn!("settings: {e}"); } }
      _ => {}
    });
}
