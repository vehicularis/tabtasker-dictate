//! TabTasker Dictate: hold fn to type with your voice anywhere, or take a long spoken note that is saved
//! as a Markdown file. Speech never leaves the Mac: Whisper runs locally on Metal.
//!
//! The native side (native/dictate.m) owns the fn key, the microphone and typing; dictation/speech.rs owns
//! the model. app/ is the app around them: the overlay and the app's window, the menu bar item, the app
//! menu, and the bridge to the pages. This file starts it all and lists the commands the pages can call.
pub mod ai;
mod app;
pub mod dictation;
pub mod library;
pub mod meetings;
pub mod settings;

use ai::mcp;
use app::{commands, logger::FileLog, menu, updates, windows, APP, FIRST_RUN};
use dictation::{history, speech, text};
use library::{notes, stickies};
use std::sync::atomic::Ordering;
use tauri::{ActivationPolicy, AppHandle, Manager, RunEvent};

extern "C" {
  fn dictate_init();
}

/// The very first launch. The settings file is written so this happens once, and a Mac that still needs
/// its permissions gets the full setup window rather than the overlay's compact card.
fn first_run(app: &AppHandle, status: &serde_json::Value) {
  if let Err(e) = settings::update(app, &serde_json::json!({})) { log::warn!("settings: {e}"); }
  if status["microphone"] == "allowed" && status["accessibility"] == true { return; }
  FIRST_RUN.store(true, Ordering::Relaxed);
  if let Err(e) = windows::show_main(app, Some("setup")) { log::warn!("setup: {e}"); }
}

pub fn run() {
  if log::set_logger(Box::leak(Box::new(FileLog::open()))).is_ok() { log::set_max_level(log::LevelFilter::Info); } // one logger for the process's life
  log::info!("TabTasker Dictate {} starting", env!("CARGO_PKG_VERSION"));
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().default_version_comparator(|current, release| updates::newer(&current, &release.version)).build())
    .invoke_handler(tauri::generate_handler![
      commands::quit, commands::open_site,
      commands::status, commands::set_enabled, commands::set_input, commands::set_open_at_login, commands::request, commands::layout, commands::meeting, commands::open_app, commands::paste_last, commands::play_sound,
      notes::save_note, notes::show_notes, notes::notes_folder, notes::preview_note, notes::choose_folder, notes::library_list, notes::library_open,
      notes::note_read, notes::note_write, notes::note_new, notes::note_delete, notes::note_attach, commands::note_open,
      stickies::sticky_list, stickies::sticky_get, stickies::sticky_new, stickies::sticky_update, stickies::sticky_size, stickies::sticky_remove, stickies::sticky_to_note, stickies::sticky_show, stickies::sticky_close, stickies::sticky_archive, notes::note_archive, stickies::sticky_pin, stickies::sticky_fold, stickies::sticky_watch, stickies::sticky_hold, settings::get_settings, settings::update_settings, settings::reset_settings,
      speech::speech_models, speech::prepare_model, speech::vocabulary_fit, text::list_apps,
      history::history_list, history::history_stats, history::history_delete, history::history_clear, history::history_type,
      ai::claude_save_key, ai::claude_test, ai::claude_remove_key, ai::claude_open_console, ai::claude_insert, ai::claude_dismiss,
      ai::claude_code_find, ai::claude_code_set, ai::claude_connect_code, ai::claude_connect_local, ai::claude_connect_open_ai, ai::claude_disconnect, ai::claude_ask,
      mcp::agents_status, mcp::agents_add,
      meetings::meeting_state, meetings::meeting_recover, meetings::meeting_reveal, meetings::meeting_privacy,
      updates::update_state, updates::update_check, updates::update_restart,
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
      meetings::init(&handle)?;
      unsafe { dictate_init() };
      settings::apply(&handle, &settings::get());
      windows::overlay(&handle)?;
      handle.set_menu(menu::app_menu(&handle)?)?;
      let status = commands::status_json().and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok()).unwrap_or_default();
      menu::tray(&handle, status["enabled"] == true)?;
      notes::watch(&handle);
      stickies::show_all(&handle);
      updates::watch(&handle);
      if first { first_run(&handle, &status); }
      Ok(())
    })
    .on_menu_event(|app, event| menu::menu_event(app, event.id().as_ref()))
    .on_window_event(windows::window_event)
    .build(tauri::generate_context!())
    .expect("TabTasker Dictate failed to start")
    .run(|app, event| match event {
      RunEvent::Exit => speech::shutdown(app),
      // Opening the app again from Finder, Spotlight or the Dock: the way back with the menu bar icon hidden.
      RunEvent::Reopen { .. } => { if let Err(e) = windows::show_main(app, None) { log::warn!("settings: {e}"); } }
      _ => {}
    });
}
