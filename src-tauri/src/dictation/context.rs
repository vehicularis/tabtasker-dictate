//! What each hold is for: the native side says when a hold begins, in which mode and over which app,
//! and everything after Whisper reads it by the hold's request id.
use std::collections::VecDeque;
use std::ffi::{c_char, CStr, CString};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
  Dictate,
  Note,
  Command,
  HandsFree,
}

impl Mode {
  pub(crate) fn parse(mode: &str) -> Option<Self> {
    Some(match mode {
      "dictate" => Self::Dictate,
      "note" => Self::Note,
      "command" => Self::Command,
      "handsfree" => Self::HandsFree,
      _ => return None,
    })
  }
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Dictate => "dictate",
      Self::Note => "note",
      Self::Command => "command",
      Self::HandsFree => "handsfree",
    }
  }
  /// Typed into the focused field as it is said, so the text pipeline runs on it.
  pub fn types(&self) -> bool {
    matches!(self, Self::Dictate | Self::HandsFree)
  }
}

#[derive(Clone, Debug)]
pub struct HoldContext {
  pub request: String,
  pub mode: Mode,
  pub bundle_id: String,
  pub app_name: String,
}

impl HoldContext {
  pub fn new(request: &str, mode: Mode, bundle_id: &str, app_name: &str) -> Self {
    Self { request: request.to_owned(), mode, bundle_id: bundle_id.to_owned(), app_name: app_name.to_owned() }
  }
}

/// The newest holds; a hold that is never forgotten falls off the end.
static HOLDS: Mutex<VecDeque<HoldContext>> = Mutex::new(VecDeque::new());
const KEPT: usize = 16;

pub fn remember(context: HoldContext) {
  keep(&mut HOLDS.lock().unwrap_or_else(|e| e.into_inner()), context);
}

fn keep(holds: &mut VecDeque<HoldContext>, context: HoldContext) {
  holds.retain(|hold| hold.request != context.request);
  if holds.len() >= KEPT {
    holds.pop_front();
  }
  holds.push_back(context);
}

/// The hold `request`; one the native side never announced counts as plain dictation in no known app.
pub fn get(request: &str) -> HoldContext {
  let holds = HOLDS.lock().unwrap_or_else(|e| e.into_inner());
  holds.iter().find(|hold| hold.request == request).cloned().unwrap_or_else(|| HoldContext::new(request, Mode::Dictate, "", ""))
}

pub fn forget(request: &str) {
  HOLDS.lock().unwrap_or_else(|e| e.into_inner()).retain(|hold| hold.request != request);
}

extern "C" {
  fn dictate_app_name(bundle_id: *const c_char, output: *mut c_char, capacity: usize) -> bool;
}

fn text(text: *const c_char) -> String {
  if text.is_null() {
    String::new()
  } else {
    unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned()
  }
}

/// On the main thread, as a hold begins.
#[no_mangle]
extern "C" fn dictate_hold_begin(request: *const c_char, mode: *const c_char, bundle_id: *const c_char) {
  let (request, bundle_id) = (text(request), text(bundle_id));
  let Some(mode) = Mode::parse(&text(mode)) else { return };
  if request.is_empty() {
    return;
  }
  let mut name = vec![0u8; 256];
  let app_name = match CString::new(bundle_id.as_str()) {
    Ok(id) if !bundle_id.is_empty() && unsafe { dictate_app_name(id.as_ptr(), name.as_mut_ptr().cast(), name.len()) } => {
      CStr::from_bytes_until_nul(&name).map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
    }
    _ => String::new(),
  };
  remember(HoldContext::new(&request, mode, &bundle_id, &app_name));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_hold_is_found_by_its_request_until_forgotten() {
    remember(HoldContext::new("context-test", Mode::Note, "com.apple.Notes", "Notes"));
    assert_eq!(get("context-test").mode, Mode::Note);
    assert_eq!(get("context-test").app_name, "Notes");
    forget("context-test");
    assert_eq!(get("context-test").mode, Mode::Dictate);
    // On a deque of its own: flooding the shared one would drop holds that other tests rely on.
    let mut holds = VecDeque::new();
    for i in 0..40 {
      keep(&mut holds, HoldContext::new(&format!("context-many-{i}"), Mode::Command, "", ""));
    }
    assert_eq!(holds.len(), KEPT);
    assert_eq!(holds.back().map(|hold| hold.request.as_str()), Some("context-many-39"));
    assert_eq!(holds.front().map(|hold| hold.request.as_str()), Some("context-many-24"));
  }
}
