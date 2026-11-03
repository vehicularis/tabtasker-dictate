//! The app around the native side: the overlay and the app's window, the menu bar item, the app menu,
//! the bridge to the pages, and the app's own log.
pub(crate) mod commands;
mod events;
pub(crate) mod logger;
pub(crate) mod menu;
pub(crate) mod windows;

use std::ffi::{c_char, c_void};
use std::sync::{atomic::AtomicBool, OnceLock};
use tauri::AppHandle;

const OVERLAY: &str = "overlay";
const MAIN: &str = "main";
pub(crate) static APP: OnceLock<AppHandle> = OnceLock::new();
/// This launch is the first and opened the full setup, so the overlay keeps its own setup card closed.
pub(crate) static FIRST_RUN: AtomicBool = AtomicBool::new(false);

extern "C" {
  fn dictate_settings_status(output: *mut c_char, capacity: usize) -> bool;
  fn dictate_set_enabled(enabled: bool);
  fn dictate_set_input(uid: *const c_char);
  fn dictate_open_at_login(set: i32) -> bool;
  fn dictate_request(kind: *const c_char);
  fn dictate_overlay_attach(window: *mut c_void);
  fn dictate_window_toolbar(window: *mut c_void);
  fn dictate_overlay_layout(json: *const c_char);
  fn dictate_type_text(text: *const c_char);
  fn dictate_meeting(action: *const c_char) -> bool;
  fn dictate_play_sound(name: *const c_char, volume: f64);
}
