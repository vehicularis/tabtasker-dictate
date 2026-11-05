//! The menus: the app menu, and the tray's menu under the menu bar icon.
use super::events::emit;
use super::windows::{show_main, show_note};
use super::{commands::paste_last, dictate_meeting, dictate_request, dictate_set_enabled, MAIN, OVERLAY};
use crate::library::{notes, stickies};
use crate::{meetings, settings};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The menu bar while the window is open. Its shortcuts work whenever the app is active, and the Edit
/// items are what make ⌘C and ⌘V work in a web view at all.
pub(crate) fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
  let separator = || PredefinedMenuItem::separator(app);
  let main = Submenu::with_items(app, "TabTasker | Dictate", true, &[
    &MenuItem::with_id(app, "about", "About TabTasker | Dictate", true, None::<&str>)?, &separator()?,
    &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?, &separator()?,
    &PredefinedMenuItem::services(app, None)?, &separator()?,
    &PredefinedMenuItem::hide(app, None)?, &PredefinedMenuItem::hide_others(app, None)?, &PredefinedMenuItem::show_all(app, None)?, &separator()?,
    &MenuItem::with_id(app, "quit", "Quit TabTasker | Dictate", true, Some("CmdOrCtrl+Q"))?,
  ])?;
  let edit = Submenu::with_items(app, "Edit", true, &[
    &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?, &separator()?,
    &PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?,
    &PredefinedMenuItem::select_all(app, None)?,
  ])?;
  // The tabs, as Business's menu bar has them: File opens and closes, Window walks and moves. The page takes
  // the same keys first (App.tsx); an item acts only on one it left, a sticky in front for one (Close Tab).
  let item = |id: &str, title: &str, keys: &str| MenuItem::with_id(app, id, title, true, Some(keys));
  let file = Submenu::with_items(app, "File", true, &[
    &item("tab:new", "New Tab", "CmdOrCtrl+T")?, &item("tab:reopen", "Reopen Closed Tab", "CmdOrCtrl+Shift+T")?, &separator()?,
    &item("tab:close", "Close Tab", "CmdOrCtrl+W")?, &item("tab:window", "Close Window", "CmdOrCtrl+Shift+W")?,
  ])?;
  let window = Submenu::with_items(app, "Window", true, &[
    &PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &separator()?,
    &item("tab:prev", "Show Previous Tab", "Ctrl+Shift+Tab")?, &item("tab:next", "Show Next Tab", "Ctrl+Tab")?, &separator()?,
    &item("tab:left", "Move Tab Left", "CmdOrCtrl+Alt+Shift+Left")?, &item("tab:right", "Move Tab Right", "CmdOrCtrl+Alt+Shift+Right")?,
  ])?;
  window.set_as_windows_menu_for_nsapp()?;
  Menu::with_items(app, &[&main, &file, &edit, &window])
}

/// The tray's Recent Notes, and the files its items open.
static RECENT: OnceLock<(Submenu<Wry>, Mutex<Vec<PathBuf>>)> = OnceLock::new();
static PAUSED: OnceLock<CheckMenuItem<Wry>> = OnceLock::new();
static MEETING: OnceLock<MenuItem<Wry>> = OnceLock::new();
static UPDATES: OnceLock<MenuItem<Wry>> = OnceLock::new();

/// The tray's update item says what it will do.
pub(crate) fn update_changed(ready: bool) {
  if let Some(item) = UPDATES.get() { let _ = item.set_text(if ready { "Restart to Update" } else { "Check for Updates…" }); }
}

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
pub(crate) fn show_tray(app: &AppHandle, visible: bool) {
  if let Some(tray) = app.tray_by_id("dictate") {
    if let Err(e) = tray.set_visible(visible) { log::warn!("menu bar icon: {e}"); }
  }
}

pub(super) fn show_paused(paused: bool) {
  if let Some(item) = PAUSED.get() { let _ = item.set_checked(paused); }
}

pub(crate) fn tray(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
  let separator = || PredefinedMenuItem::separator(app);
  let recent = Submenu::with_id(app, "recent", "Recent Notes", true)?;
  let paused = CheckMenuItem::with_id(app, "pause", "Pause Dictation", true, !enabled, None::<&str>)?;
  let meeting = MenuItem::with_id(app, "meeting", "Start Meeting", true, None::<&str>)?;
  let updates = MenuItem::with_id(app, "updates", "Check for Updates…", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[
    &MenuItem::with_id(app, "note", "Speak a Note", true, None::<&str>)?,
    &MenuItem::with_id(app, "write", "Write a Note", true, None::<&str>)?,
    &MenuItem::with_id(app, "sticky", "New Sticky", true, None::<&str>)?,
    &meeting,
    &MenuItem::with_id(app, "paste-last", "Paste Last Transcript", true, None::<&str>)?,
    &recent, &separator()?,
    &MenuItem::with_id(app, "open", "Open TabTasker | Dictate", true, None::<&str>)?,
    &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
    &MenuItem::with_id(app, "setup", "Set Up…", true, None::<&str>)?,
    &updates,
    &MenuItem::with_id(app, "notes", "Show Notes in Finder", true, None::<&str>)?, &separator()?,
    &paused, &separator()?,
    &MenuItem::with_id(app, "quit", "Quit TabTasker | Dictate", true, Some("CmdOrCtrl+Q"))?,
  ])?;
  let _ = RECENT.set((recent, Mutex::default()));
  let _ = PAUSED.set(paused);
  let _ = MEETING.set(meeting);
  let _ = UPDATES.set(updates);
  recent_changed(app);
  // The mark alone, in black: macOS tints a template icon for the menu bar's light or dark look.
  let icon = tauri::image::Image::from_bytes(include_bytes!("../../icons/tray@2x.png"))?;
  let tray = TrayIconBuilder::with_id("dictate").menu(&menu).tooltip("TabTasker | Dictate").icon(icon).icon_as_template(true).build(app)?;
  tray.set_visible(settings::get().general.menu_bar_icon)
}

/// The tray's meeting item starts one, or stops the one recording.
fn start_meeting(app: &AppHandle) {
  let app = app.clone();
  let _ = app.clone().run_on_main_thread(move || {
    if !unsafe { dictate_meeting(c"toggle".as_ptr()) } {
      let why = meetings::start_problem().unwrap_or_else(|| "Couldn’t start the meeting.".into());
      let _ = app.emit_to(OVERLAY, "dictate-notice", serde_json::json!({ "message": why }));
    }
  });
}

/// A tab item from the menu bar, for the window in front: a sticky closes (and is kept, as its own × keeps it),
/// the main window's page does the rest with its tabs.
fn tab_menu(app: &AppHandle, action: &str) {
  let front = app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false));
  if let Some(sticky) = front.as_ref().and_then(|window| window.label().strip_prefix("sticky-").map(str::to_owned)) {
    if action == "close" || action == "window" { let _ = stickies::sticky_close(app.clone(), sticky); }
    return;
  }
  if let Some(main) = app.get_webview_window(MAIN) {
    if action == "window" && front.as_ref().is_some_and(|window| window.label() == MAIN) { let _ = main.close(); return; }
    let _ = main.emit("dictate-tab", action);
  }
}

/// The tray's and the app menu's items, by id. Tauri hands every menu's events to one handler.
pub(crate) fn menu_event(app: &AppHandle, id: &str) {
  if let Some(action) = id.strip_prefix("tab:") { return tab_menu(app, action); }
  match id {
    "note" => { let _ = app.run_on_main_thread(|| unsafe { dictate_request(c"note".as_ptr()) }); }
    // The note card, with the keyboard in it; its Open in the editor button makes a file of it.
    "write" => emit("dictate-open", serde_json::json!({ "what": "writeNote" })),
    "sticky" => { if let Err(e) = stickies::create(app, None, None) { emit("dictate-notice", serde_json::json!({ "message": e })); } }
    "open" => { let _ = show_main(app, None); }
    "meeting" => start_meeting(app),
    "paste-last" => paste_last(app.clone()),
    "notes" => { let _ = notes::show_notes(None); }
    "settings" => { let _ = show_main(app, Some("settings")); }
    "about" => { let _ = show_main(app, Some("about")); }
    "setup" => { let _ = show_main(app, Some("setup")); }
    "updates" => super::updates::menu_item(app),
    // The item has already flipped its own check.
    "pause" => {
      let paused = PAUSED.get().and_then(|item| item.is_checked().ok()).unwrap_or(false);
      let _ = app.run_on_main_thread(move || unsafe { dictate_set_enabled(!paused) });
    }
    "quit" => app.exit(0),
    _ => {
      let Some(index) = id.strip_prefix("recent:").and_then(|i| i.parse::<usize>().ok()) else { return };
      let file = RECENT.get().and_then(|(_, files)| files.lock().unwrap_or_else(|e| e.into_inner()).get(index).cloned());
      // A recent note opens in the window; one it can't take (moved out of the folder) goes to the Mac's default app.
      if let Some(file) = file { if show_note(app, &file.display().to_string()).is_err() { let _ = std::process::Command::new("/usr/bin/open").arg(file).spawn(); } }
    }
  }
}
