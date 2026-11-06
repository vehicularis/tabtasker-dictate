//! The words after Whisper and before they are typed. The rules live in the engine; this reads the
//! hold's settings for them, and answers the native side's questions over C.
use crate::dictation::context::HoldContext;
use crate::settings;
pub use dictate_engine::text::{sticky_words, without_send};
use dictate_engine::text::{self, chars_at, Rules};
use std::ffi::{c_char, CStr, CString};

/// The text to type for `raw`, in the hold `ctx`; `live` for a draft while the key is still held.
pub fn finish(raw: &str, ctx: &HoldContext, live: bool) -> String {
  let settings = settings::get();
  let language = crate::dictation::speech::language(&ctx.request);
  let rules = Rules {
    style: settings.apps.style_for(&ctx.bundle_id).0, fillers: settings.dictation.remove_fillers,
    replacements: &settings.vocabulary.replacements, language: language.as_deref(), live,
  };
  text::finish(raw, &rules)
}

fn read(text: *const c_char) -> Option<String> {
  (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned())
}

/// learn.m's question about a field that changed after a dictation (see `correction`), with the
/// dictated range in UTF-16 units: writes the word into `word` and answers 0 for none, 1 for a word,
/// 2 for one that reads as a name.
#[no_mangle]
extern "C" fn dictate_correction(before: *const c_char, after: *const c_char, start: usize, length: usize, word: *mut c_char, capacity: usize) -> i32 {
  let (Some(before), Some(after)) = (read(before), read(after)) else { return 0 };
  if word.is_null() || capacity == 0 { return 0; }
  let Some((found, named)) = text::correction(&before, &after, chars_at(&before, start, length)) else { return 0 };
  let bytes = found.as_bytes();
  if bytes.len() >= capacity { return 0; }
  // The word and its NUL fit in the caller's `capacity` bytes.
  unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), word.cast(), bytes.len()); *word.add(bytes.len()) = 0; }
  if named { 2 } else { 1 }
}

/// learn.m's question before it learns from a pause: whether the caret, at UTF-16 offset `caret` of
/// `after`, is still in the word being typed over the dictated ones.
/// learn.m's question before it learns from a pause: whether the caret, at UTF-16 offset `caret` of
/// `after`, is still in the word being typed over the dictated ones.
#[no_mangle]
extern "C" fn dictate_learn_typing(before: *const c_char, after: *const c_char, caret: usize) -> bool {
  let (Some(before), Some(after)) = (read(before), read(after)) else { return false };
  text::typing(&before, &after, chars_at(&after, caret, 0).start)
}

/// live_next for dictate.m: the field's new words in the caller's `capacity` bytes and their length, or 0 to
/// leave the field as it is (or when they wouldn't fit).
#[no_mangle]
extern "C" fn dictate_live_next(typed: *const c_char, previous: *const c_char, now: *const c_char, out: *mut c_char, capacity: usize) -> usize {
  let (Some(typed), Some(previous), Some(now)) = (read(typed), read(previous), read(now)) else { return 0 };
  let next = text::live_next(&typed, &previous, &now);
  if out.is_null() || next.is_empty() || next.len() >= capacity { return 0; }
  // The words and their NUL fit in the caller's `capacity` bytes.
  unsafe { std::ptr::copy_nonoverlapping(next.as_ptr(), out.cast(), next.len()); *out.add(next.len()) = 0; }
  next.len()
}

/// A word learned from a correction: it waits in Settings › Vocabulary and the overlay offers it. It is
/// only ever added to the words on a yes.
#[no_mangle]
extern "C" fn dictate_learned(word: *const c_char) {
  let (Some(app), Some(word)) = (crate::dictation::speech::app(), read(word)) else { return };
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    use tauri::Emitter;
    let vocabulary = settings::get().vocabulary;
    let same = |other: &String| other.to_lowercase() == word.to_lowercase();
    if !vocabulary.learn || vocabulary.words.iter().any(same) { return; }
    if !vocabulary.suggestions.iter().any(same) {
      let suggestions: Vec<String> = std::iter::once(word.clone()).chain(vocabulary.suggestions).collect();
      if let Err(e) = settings::update(&app, &serde_json::json!({ "vocabulary": { "suggestions": suggestions } })) { log::warn!("vocabulary: {e}"); return; }
    }
    let _ = app.emit_to("overlay", "dictate-learned", serde_json::json!({ "word": word }));
  });
}

// ---------- the apps to give a style ----------

extern "C" {
  fn dictate_apps(known: *const c_char) -> *mut c_char;
  fn dictate_free(text: *mut c_char);
}

/// The apps running now and those used in the last month, and the installed apps among `known`, each
/// with its name and icon, for App styles.
#[tauri::command]
pub async fn list_apps(known: Vec<String>) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let known = CString::new(serde_json::to_string(&known).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let raw = unsafe { dictate_apps(known.as_ptr()) };
    if raw.is_null() { return Err("Couldn’t get the list of your apps.".to_owned()); }
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    unsafe { dictate_free(raw) };
    serde_json::from_str(&json).map_err(|e| e.to_string())
  }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_native_side_counts_in_utf16() {
    let (before, after) = (CString::new("🙂 to Cooper").unwrap(), CString::new("🙂 to Kube").unwrap());
    assert!(dictate_learn_typing(before.as_ptr(), after.as_ptr(), 10));
    assert!(!dictate_learn_typing(before.as_ptr(), after.as_ptr(), 2));
  }

  #[test]
  fn the_native_side_gets_the_word_in_its_buffer() {
    let (before, after) = (CString::new("deploy to Cooper Nettis").unwrap(), CString::new("deploy to kubernetes").unwrap());
    let mut word = [0 as c_char; 64];
    assert_eq!(dictate_correction(before.as_ptr(), after.as_ptr(), 0, 23, word.as_mut_ptr(), word.len()), 1);
    assert_eq!(unsafe { CStr::from_ptr(word.as_ptr()) }.to_str().unwrap(), "kubernetes");
    let named = CString::new("deploy to Kubernetes").unwrap();
    assert_eq!(dictate_correction(before.as_ptr(), named.as_ptr(), 0, 23, word.as_mut_ptr(), word.len()), 2);
    let mut small = [0 as c_char; 4];
    assert_eq!(dictate_correction(before.as_ptr(), after.as_ptr(), 0, 23, small.as_mut_ptr(), small.len()), 0);
    assert_eq!(dictate_correction(std::ptr::null(), after.as_ptr(), 0, 23, word.as_mut_ptr(), word.len()), 0);
  }

  #[test]
  fn apps_come_with_names_and_icons() {
    let known = CString::new(r#"["com.apple.Terminal", "com.example.not-installed"]"#).unwrap();
    let started = std::time::Instant::now();
    let raw = unsafe { dictate_apps(known.as_ptr()) };
    assert!(!raw.is_null());
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    unsafe { dictate_free(raw) };
    let apps: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
    println!("{} apps, {} bytes, in {:?}", apps.len(), json.len(), started.elapsed());
    let terminal = apps.iter().find(|app| app["bundleId"] == "com.apple.Terminal").expect("Terminal is on every Mac");
    assert_eq!(terminal["name"], "Terminal");
    assert!(terminal["icon"].as_str().is_some_and(|icon| icon.starts_with("data:image/png;base64,")));
    assert!(apps.iter().all(|app| app["bundleId"] != "com.example.not-installed" && app["name"].as_str().is_some_and(|name| !name.is_empty())));
  }
}
