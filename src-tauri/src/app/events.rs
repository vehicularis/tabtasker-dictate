//! What the native side tells the page, and the other calls it makes into the app.
use super::{commands, APP, OVERLAY};
use crate::dictation::{context, speech};
use crate::library::stickies;
use std::ffi::{c_char, CStr};
use tauri::Emitter;

pub(super) fn emit(event: &str, payload: serde_json::Value) {
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
/// The Dock sliding out over an edge, or back: the page steps the dots aside by `strip` points while it is out.
#[no_mangle]
extern "C" fn dictate_ui_dock(shown: bool, strip: f64, edge: *const c_char) {
  let edge = text(edge).unwrap_or_else(|| "bottom".to_owned());
  emit("dictate-dock", serde_json::json!({ "shown": shown, "strip": if strip.is_finite() { strip } else { 0.0 }, "edge": edge }));
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

/// Paste Last Transcript from its chord.
#[no_mangle]
extern "C" fn dictate_paste_last() {
  if let Some(app) = APP.get() { commands::paste_last(app.clone()); }
}
