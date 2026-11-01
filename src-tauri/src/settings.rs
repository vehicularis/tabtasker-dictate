//! The settings store: one JSON file in the app data folder, read once at launch and written whole on
//! every change. A file from another version, or one edited by hand, loses only the fields it gets wrong.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
  pub version: u32,
  pub shortcuts: Shortcuts,
  pub dictation: Dictation,
  pub vocabulary: Vocabulary,
  pub apps: Apps,
  pub notes: Notes,
  pub meetings: Meetings,
  pub claude: Claude,
  pub agents: Agents,
  pub history: History,
  pub appearance: Appearance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DictateKey { Fn, RightCommand, RightOption, RightControl, RightShift }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandKey { Control, Option, Command, Shift, Off }

/// A global shortcut: a macOS virtual key code, NSEvent modifier mask bits, and how it reads ("⌥⌘N").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chord { pub key_code: u16, pub modifiers: u64, pub label: String }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
  pub dictate: DictateKey,
  pub hands_free: bool,
  pub command: CommandKey,
  pub note: Option<Chord>,
  pub meeting: Option<Chord>,
  pub paste_last: Option<Chord>,
}
impl Default for Shortcuts {
  fn default() -> Self { Self { dictate: DictateKey::Fn, hands_free: true, command: CommandKey::Control, note: None, meeting: None, paste_last: None } }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Model { Turbo, Small }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Dictation {
  /// `auto` or a Whisper language code.
  pub language: String,
  pub translate_to_english: bool,
  pub live_typing: bool,
  pub remove_fillers: bool,
  pub sounds: bool,
  pub model: Model,
}
impl Default for Dictation {
  fn default() -> Self { Self { language: "auto".into(), translate_to_english: false, live_typing: true, remove_fillers: true, sounds: true, model: Model::Turbo } }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replacement { pub from: String, pub to: String }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Vocabulary {
  pub words: Vec<String>,
  pub replacements: Vec<Replacement>,
  pub learn: bool,
  pub suggestions: Vec<String>,
}
impl Default for Vocabulary {
  fn default() -> Self { Self { words: Vec::new(), replacements: Vec::new(), learn: true, suggestions: Vec::new() } }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Style { #[default] Default, Casual, Formal, Code, Raw }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStyle { pub bundle_id: String, pub name: String, pub style: Style, #[serde(default)] pub polish: bool }

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Apps { pub styles: Vec<AppStyle>, pub default_style: Style }
impl Apps {
  /// The style for the app with `bundle_id`, and whether Claude polishes there.
  pub fn style_for(&self, bundle_id: &str) -> (Style, bool) {
    self.styles.iter().find(|app| app.bundle_id == bundle_id).map_or((self.default_style, false), |app| (app.style, app.polish))
  }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notes {
  /// None is ~/Documents/TabTasker Dictate.
  pub folder: Option<String>,
  pub file_name: String,
  pub frontmatter: bool,
  pub daily_note: bool,
  pub tags: Vec<String>,
  pub claude_title: bool,
  pub claude_actions: bool,
}
impl Default for Notes {
  fn default() -> Self { Self { folder: None, file_name: "{date} {title}".into(), frontmatter: true, daily_note: false, tags: Vec::new(), claude_title: true, claude_actions: false } }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Meetings {
  /// None is the Meetings folder inside the notes folder.
  pub folder: Option<String>,
  pub system_audio: bool,
  pub summarize: bool,
  pub you: String,
  pub others: String,
}
impl Default for Meetings {
  fn default() -> Self { Self { folder: None, system_audio: true, summarize: true, you: "You".into(), others: "Others".into() } }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClaudeModel {
  #[serde(rename = "claude-haiku-5-5")] Haiku,
  #[serde(rename = "claude-sonnet-5-5")] Sonnet,
  #[serde(rename = "claude-opus-5-5")] Opus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Claude {
  /// On only once a key is saved in the Keychain and tested.
  pub enabled: bool,
  pub model: ClaudeModel,
  pub commands: bool,
  pub claude_code: Option<String>,
  pub project_folder: Option<String>,
}
impl Default for Claude {
  fn default() -> Self { Self { enabled: false, model: ClaudeModel::Haiku, commands: true, claude_code: None, project_folder: None } }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Agents { pub mcp: bool, pub share_history: bool, pub share_notes: bool, pub share_meetings: bool, pub allow_write: bool }
impl Default for Agents {
  fn default() -> Self { Self { mcp: true, share_history: false, share_notes: true, share_meetings: true, allow_write: false } }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Keep { Off, Day, #[default] Week, Month, Forever }

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct History { pub keep: Keep }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme { #[default] System, Light, Dark }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge { #[default] Bottom, Left, Right }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Size { Small, #[default] Medium, Large }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Idle { #[default] Dots, Hidden }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance { pub theme: Theme, pub edge: Edge, pub size: Size, pub idle: Idle, pub hint: bool }
impl Default for Appearance {
  fn default() -> Self { Self { theme: Theme::System, edge: Edge::Bottom, size: Size::Medium, idle: Idle::Dots, hint: true } }
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      version: VERSION, shortcuts: Shortcuts::default(), dictation: Dictation::default(), vocabulary: Vocabulary::default(),
      apps: Apps { styles: default_styles(), default_style: Style::Default }, notes: Notes::default(), meetings: Meetings::default(),
      claude: Claude::default(), agents: Agents::default(), history: History::default(), appearance: Appearance::default(),
    }
  }
}

const VERSION: u32 = 1;
const MAX_LIST: usize = 500;
const MAX_WORD: usize = 64;
const MAX_TEXT: usize = 200;

fn default_styles() -> Vec<AppStyle> {
  let app = |bundle_id: &str, name: &str, style| AppStyle { bundle_id: bundle_id.into(), name: name.into(), style, polish: false };
  vec![
    app("com.apple.Terminal", "Terminal", Style::Code), app("com.googlecode.iterm2", "iTerm", Style::Code),
    app("com.mitchellh.ghostty", "Ghostty", Style::Code), app("dev.warp.Warp-Stable", "Warp", Style::Code),
    app("com.microsoft.VSCode", "Visual Studio Code", Style::Code), app("com.todesktop.230313mzl4w4u92", "Cursor", Style::Code),
    app("com.apple.dt.Xcode", "Xcode", Style::Code), app("dev.zed.Zed", "Zed", Style::Code),
    app("com.apple.MobileSMS", "Messages", Style::Casual), app("com.tinyspeck.slackmacgap", "Slack", Style::Casual),
    app("net.whatsapp.WhatsApp", "WhatsApp", Style::Casual), app("com.hnc.Discord", "Discord", Style::Casual),
    app("com.apple.mail", "Mail", Style::Formal), app("com.microsoft.Outlook", "Outlook", Style::Formal),
  ]
}

/// Characters, not bytes: a clamp never splits a letter.
fn clip(text: &str, max: usize) -> String { text.trim().chars().take(max).collect() }

fn clip_list(list: &mut Vec<String>, max_items: usize, max_chars: usize) {
  let mut seen = std::collections::HashSet::new();
  let clean: Vec<String> = list.iter().map(|item| clip(item, max_chars)).filter(|item| !item.is_empty() && seen.insert(item.to_lowercase())).take(max_items).collect();
  *list = clean;
}

impl Settings {
  /// What a value must be, beyond its type, for the whole to be accepted: folders are absolute paths
  /// and a chord has a key and a modifier.
  fn valid(&self) -> bool {
    let folder = |path: &Option<String>| path.as_deref().is_none_or(|path| Path::new(path).is_absolute() && !path.contains('\0'));
    let chord = |chord: &Option<Chord>| chord.as_ref().is_none_or(|chord| chord.key_code < 0x80 && chord.modifiers != 0 && !chord.label.trim().is_empty());
    let shortcuts = &self.shortcuts;
    folder(&self.notes.folder) && folder(&self.meetings.folder) && folder(&self.claude.claude_code) && folder(&self.claude.project_folder)
      && chord(&shortcuts.note) && chord(&shortcuts.meeting) && chord(&shortcuts.paste_last)
      && (self.dictation.language == "auto" || (self.dictation.language.len() <= 5 && self.dictation.language.chars().all(|c| c.is_ascii_lowercase())))
  }

  /// Lengths and lists cut to what the app handles; empty names back to their defaults.
  fn clamp(&mut self) {
    self.version = VERSION;
    let vocabulary = &mut self.vocabulary;
    clip_list(&mut vocabulary.words, MAX_LIST, MAX_WORD);
    clip_list(&mut vocabulary.suggestions, MAX_LIST, MAX_WORD);
    vocabulary.replacements.retain(|pair| !pair.from.trim().is_empty());
    vocabulary.replacements.truncate(MAX_LIST);
    for pair in &mut vocabulary.replacements { pair.from = clip(&pair.from, MAX_TEXT); pair.to = clip(&pair.to, MAX_TEXT); }
    let mut seen = std::collections::HashSet::new();
    self.apps.styles.retain(|app| !app.bundle_id.trim().is_empty() && seen.insert(app.bundle_id.clone()));
    self.apps.styles.truncate(MAX_LIST);
    for app in &mut self.apps.styles { app.bundle_id = clip(&app.bundle_id, MAX_TEXT); app.name = clip(&app.name, MAX_TEXT); }
    clip_list(&mut self.notes.tags, 50, MAX_WORD);
    self.notes.file_name = clip(&self.notes.file_name, MAX_TEXT);
    if self.notes.file_name.is_empty() { self.notes.file_name = Notes::default().file_name; }
    self.meetings.you = clip(&self.meetings.you, MAX_WORD);
    self.meetings.others = clip(&self.meetings.others, MAX_WORD);
    if self.meetings.you.is_empty() { self.meetings.you = Meetings::default().you; }
    if self.meetings.others.is_empty() { self.meetings.others = Meetings::default().others; }
    for chord in [&mut self.shortcuts.note, &mut self.shortcuts.meeting, &mut self.shortcuts.paste_last].into_iter().flatten() { chord.label = clip(&chord.label, 16); }
  }

  /// `patch` merged into these settings, one value at a time: a value of the wrong type, an unknown
  /// choice or an invalid path keeps the old value, and unknown keys are ignored.
  pub fn patched(&self, patch: &Value) -> Settings {
    let mut good = serde_json::to_value(self).unwrap_or(Value::Null);
    let mut leaves = Vec::new();
    collect(patch, &good, &mut Vec::new(), &mut leaves);
    for (path, value) in leaves {
      let mut trial = good.clone();
      if let Some(slot) = path.iter().try_fold(&mut trial, |node, key| node.get_mut(key)) { *slot = value; }
      if serde_json::from_value::<Settings>(trial.clone()).is_ok_and(|settings| settings.valid()) { good = trial; }
    }
    let mut settings: Settings = serde_json::from_value(good).unwrap_or_else(|_| self.clone());
    settings.clamp();
    settings
  }
}

/// The values of `patch` to try, by path: objects merge key by key into the known shape, anything else
/// (a list, a chord replacing null, a string) is tried whole.
fn collect(patch: &Value, base: &Value, path: &mut Vec<String>, leaves: &mut Vec<(Vec<String>, Value)>) {
  let (Some(patch), Some(base)) = (patch.as_object(), base.as_object()) else { return };
  for (key, value) in patch {
    let Some(known) = base.get(key) else { continue };
    path.push(key.clone());
    if value.is_object() && known.is_object() { collect(value, known, path, leaves); } else { leaves.push((path.clone(), value.clone())); }
    path.pop();
  }
}

/// The settings in `path`, field by field over the defaults; the defaults when it is missing or unreadable.
pub fn load_from(path: &Path) -> Settings {
  let saved = std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
  saved.map_or_else(Settings::default, |saved| Settings::default().patched(&saved))
}

/// Written beside the file, synced, then renamed over it: a crash leaves the old settings or the new, never half.
pub fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
  use std::io::Write;
  let dir = path.parent().ok_or("No settings folder")?;
  std::fs::create_dir_all(dir).map_err(|e| format!("Couldn’t make the settings folder: {e}"))?;
  let temp = path.with_extension("json.tmp");
  let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
  let written = std::fs::File::create(&temp).and_then(|mut file| { file.write_all(&json)?; file.sync_all() });
  if let Err(e) = written.and_then(|_| std::fs::rename(&temp, path)) {
    let _ = std::fs::remove_file(&temp);
    return Err(format!("Couldn’t save settings: {e}"));
  }
  Ok(())
}

static CURRENT: RwLock<Option<Settings>> = RwLock::new(None);
static FILE: OnceLock<PathBuf> = OnceLock::new();
/// One change at a time from read to save, so two quick changes never lose one another.
static WRITING: Mutex<()> = Mutex::new(());

/// The settings now. Before `init` (and in tests) the defaults.
pub fn get() -> Settings {
  CURRENT.read().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

pub fn init(app: &AppHandle) -> Result<(), String> {
  let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("settings.json");
  *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(load_from(&path));
  let _ = FILE.set(path);
  Ok(())
}

extern "C" {
  fn dictate_apply_settings(json: *const std::ffi::c_char);
}

/// Hands the settings to the native side (on the main thread) and to every window.
pub fn apply(app: &AppHandle, settings: &Settings) {
  if let Ok(json) = serde_json::to_string(settings).map(|json| std::ffi::CString::new(json).unwrap_or_default()) {
    let _ = app.run_on_main_thread(move || unsafe { dictate_apply_settings(json.as_ptr()) });
  }
  let _ = app.emit("dictate-settings", settings);
  crate::recent_changed(app); // the notes folder may have moved
}

fn replace(app: &AppHandle, next: impl FnOnce(&Settings) -> Settings) -> Result<Settings, String> {
  let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
  let settings = next(&get());
  if let Some(path) = FILE.get() { save_to(path, &settings)?; }
  *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
  apply(app, &settings);
  Ok(settings)
}

/// A change from Rust: the same path as the page's, so every window hears it.
pub fn update(app: &AppHandle, patch: &Value) -> Result<Settings, String> {
  replace(app, |current| current.patched(patch))
}

#[tauri::command]
pub fn get_settings() -> Settings { get() }

#[tauri::command]
pub fn update_settings(app: AppHandle, patch: Value) -> Result<Settings, String> {
  if !patch.is_object() { return Err("Invalid settings".into()); }
  update(&app, &patch)
}

/// Everything back to how it was on first launch.
#[tauri::command]
pub fn reset_settings(app: AppHandle) -> Result<Settings, String> {
  replace(&app, |_| Settings::default())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-settings-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn defaults_are_the_documented_ones_in_camel_case() {
    let value = serde_json::to_value(Settings::default()).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["shortcuts"], json!({ "dictate": "fn", "handsFree": true, "command": "control", "note": null, "meeting": null, "pasteLast": null }));
    assert_eq!(value["dictation"], json!({ "language": "auto", "translateToEnglish": false, "liveTyping": true, "removeFillers": true, "sounds": true, "model": "turbo" }));
    assert_eq!(value["vocabulary"], json!({ "words": [], "replacements": [], "learn": true, "suggestions": [] }));
    assert_eq!(value["apps"]["defaultStyle"], "default");
    assert!(value["apps"]["styles"].as_array().unwrap().iter().any(|app| app["bundleId"] == "com.apple.Terminal" && app["style"] == "code" && app["polish"] == false));
    assert_eq!(value["notes"], json!({ "folder": null, "fileName": "{date} {title}", "frontmatter": true, "dailyNote": false, "tags": [], "claudeTitle": true, "claudeActions": false }));
    assert_eq!(value["meetings"], json!({ "folder": null, "systemAudio": true, "summarize": true, "you": "You", "others": "Others" }));
    assert_eq!(value["claude"], json!({ "enabled": false, "model": "claude-haiku-5-5", "commands": true, "claudeCode": null, "projectFolder": null }));
    assert_eq!(value["agents"], json!({ "mcp": true, "shareHistory": false, "shareNotes": true, "shareMeetings": true, "allowWrite": false }));
    assert_eq!(value["history"], json!({ "keep": "week" }));
    assert_eq!(value["appearance"], json!({ "theme": "system", "edge": "bottom", "size": "medium", "idle": "dots", "hint": true }));
  }

  #[test]
  fn a_partial_patch_changes_only_what_it_names() {
    let before = Settings::default();
    let after = before.patched(&json!({ "appearance": { "edge": "left" }, "dictation": { "language": "tr" }, "shortcuts": { "note": { "keyCode": 45, "modifiers": 1_572_864, "label": "⌥⌘N" } } }));
    assert_eq!(after.appearance.edge, Edge::Left);
    assert_eq!(after.dictation.language, "tr");
    assert_eq!(after.shortcuts.note, Some(Chord { key_code: 45, modifiers: 1_572_864, label: "⌥⌘N".into() }));
    assert_eq!(after.appearance.theme, before.appearance.theme);
    assert_eq!(after.dictation.live_typing, before.dictation.live_typing);
    assert_eq!(after.apps, before.apps);
    // Clearing a chord is a null.
    assert_eq!(after.patched(&json!({ "shortcuts": { "note": null } })).shortcuts.note, None);
  }

  #[test]
  fn invalid_values_keep_the_old_value_and_lists_are_clamped() {
    let before = Settings::default().patched(&json!({ "appearance": { "theme": "dark" } }));
    let after = before.patched(&json!({
      "version": 7, "nonsense": true,
      "appearance": { "theme": "purple", "edge": 3, "hint": "yes", "size": "large" },
      "claude": { "model": "gpt-4" },
      "notes": { "folder": "relative/path", "fileName": "   " },
      "meetings": { "you": "" },
      "dictation": { "language": "../../x" },
      "shortcuts": { "meeting": { "keyCode": 45, "modifiers": 0, "label": "N" }, "pasteLast": { "keyCode": "v" } },
      "vocabulary": { "words": [" Can ", "can", "", "x".repeat(100)] },
    }));
    assert_eq!(after.version, 1);
    assert_eq!(after.appearance.theme, Theme::Dark);
    assert_eq!(after.appearance.edge, Edge::Bottom);
    assert!(after.appearance.hint);
    assert_eq!(after.appearance.size, Size::Large); // a valid value beside invalid ones still lands
    assert_eq!(after.claude.model, ClaudeModel::Haiku);
    assert_eq!(after.notes.folder, None);
    assert_eq!(after.notes.file_name, "{date} {title}");
    assert_eq!(after.meetings.you, "You");
    assert_eq!(after.dictation.language, "auto");
    assert_eq!(after.shortcuts.meeting, None);
    assert_eq!(after.shortcuts.paste_last, None);
    assert_eq!(after.vocabulary.words, vec!["Can".to_owned(), "x".repeat(64)]);
    let many: Vec<String> = (0..600).map(|i| format!("word{i}")).collect();
    assert_eq!(after.patched(&json!({ "vocabulary": { "words": many } })).vocabulary.words.len(), 500);
  }

  #[test]
  fn a_broken_or_foreign_file_falls_back_field_by_field() {
    let dir = temp("broken");
    let path = dir.join("settings.json");
    assert_eq!(load_from(&path), Settings::default());
    std::fs::write(&path, b"{ not json").unwrap();
    assert_eq!(load_from(&path), Settings::default());
    std::fs::write(&path, br#"{ "version": 9, "appearance": { "edge": "right", "theme": "sepia" }, "history": "forever", "future": 1 }"#).unwrap();
    let loaded = load_from(&path);
    assert_eq!(loaded.appearance.edge, Edge::Right);
    assert_eq!(loaded.appearance.theme, Theme::System);
    assert_eq!(loaded.history.keep, Keep::Week);
    assert_eq!(loaded.version, 1);
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn an_atomic_save_round_trips_and_leaves_no_temp_file() {
    let dir = temp("save");
    let path = dir.join("nested").join("settings.json");
    let settings = Settings::default().patched(&json!({ "vocabulary": { "words": ["Kubernetes", "İstanbul"], "replacements": [{ "from": "my email", "to": "can@example.com" }] }, "notes": { "folder": "/tmp/Notes" } }));
    save_to(&path, &settings).unwrap();
    assert_eq!(load_from(&path), settings);
    save_to(&path, &Settings::default()).unwrap();
    assert_eq!(load_from(&path), Settings::default());
    assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    std::fs::remove_dir_all(dir).unwrap();
  }
}
