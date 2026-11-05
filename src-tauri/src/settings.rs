//! The settings store: one JSON file in the app data folder, read once at launch and written whole on
//! every change. A file from another version, or one edited by hand, loses only the fields it gets wrong.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
  pub version: u32,
  pub general: General,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct General {
  /// Hidden, the app is still reached by opening it again from Finder or Spotlight, or from the dots.
  pub menu_bar_icon: bool,
  /// An icon in the Dock as well, which opens Settings; otherwise only while Settings is open.
  pub show_in_dock: bool,
  /// Look for a new release now and then, download it and offer a restart (app/updates.rs).
  pub check_for_updates: bool,
}
impl Default for General {
  fn default() -> Self { Self { menu_bar_icon: true, show_in_dock: false, check_for_updates: true } }
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

const SHIFT: u64 = 1 << 17;
const CONTROL: u64 = 1 << 18;
const OPTION: u64 = 1 << 19;
const COMMAND: u64 = 1 << 20;
/// F1 to F20, which work as a shortcut on their own.
const FUNCTION_KEYS: [u16; 20] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90];

impl Chord {
  /// A key with ⌃, ⌥ or ⌘ (⇧ only beside them), or a function key alone, and no other modifier bits.
  pub fn valid(&self) -> bool {
    self.key_code < 0x80 && self.modifiers & !(SHIFT | CONTROL | OPTION | COMMAND) == 0 && !self.label.trim().is_empty()
      && (self.modifiers & (CONTROL | OPTION | COMMAND) != 0 || FUNCTION_KEYS.contains(&self.key_code))
  }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
  pub dictate: DictateKey,
  pub hands_free: bool,
  pub command: CommandKey,
  pub note: Option<Chord>,
  pub meeting: Option<Chord>,
  pub paste_last: Option<Chord>,
  /// A note to type, a sticky on the screen, and a typed question for Claude.
  pub write_note: Option<Chord>,
  pub sticky: Option<Chord>,
  pub ask: Option<Chord>,
}
impl Default for Shortcuts {
  fn default() -> Self {
    Self { dictate: DictateKey::Fn, hands_free: true, command: CommandKey::Control, note: None, meeting: None, paste_last: None, write_note: None, sticky: None, ask: None }
  }
}
impl Shortcuts {
  /// Every global chord, set or not, in the order the Shortcuts page lists them.
  pub fn chords(&self) -> [&Option<Chord>; 6] { [&self.note, &self.meeting, &self.paste_last, &self.write_note, &self.sticky, &self.ask] }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Model { Turbo, Small }

/// The Mac's own alert sounds, in /System/Library/Sounds, which the cues are chosen from.
pub const SOUNDS: [&str; 14] = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];
const DEFAULT_VOLUME: f64 = 0.3;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Dictation {
  /// `auto` or a Whisper language code.
  pub language: String,
  pub translate_to_english: bool,
  pub remove_fillers: bool,
  pub sounds: bool,
  /// 0 to 1, for both cues.
  pub sound_volume: f64,
  /// The cues as listening starts and stops, by name in `SOUNDS`.
  pub start_sound: String,
  pub stop_sound: String,
  pub model: Model,
}
impl Default for Dictation {
  fn default() -> Self {
    Self { language: "auto".into(), translate_to_english: false, remove_fillers: true, sounds: true, sound_volume: DEFAULT_VOLUME, start_sound: "Tink".into(), stop_sound: "Pop".into(), model: Model::Turbo }
  }
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
pub struct AppStyle {
  pub bundle_id: String, pub name: String, pub style: Style, #[serde(default)] pub polish: bool,
  /// Press Return once the words are typed, as sending a message. None is the app's own default: on in
  /// chat apps (`CHAT_APPS`), off elsewhere.
  #[serde(default)] pub send: Option<bool>,
}

/// Apps where what you dictate is a message to send, so Return follows the words unless the app's style
/// says otherwise.
pub const CHAT_APPS: [&str; 10] = [
  "com.tinyspeck.slackmacgap", "com.apple.MobileSMS", "net.whatsapp.WhatsApp", "com.microsoft.teams2", "com.microsoft.teams",
  "ru.keepcoder.Telegram", "com.tdesktop.Telegram", "com.hnc.Discord", "com.facebook.archon", "com.signal.desktop",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Apps { pub styles: Vec<AppStyle>, pub default_style: Style }
impl Apps {
  /// The style for the app with `bundle_id`, and whether Claude polishes there.
  pub fn style_for(&self, bundle_id: &str) -> (Style, bool) {
    self.styles.iter().find(|app| app.bundle_id.eq_ignore_ascii_case(bundle_id)).map_or((self.default_style, false), |app| (app.style, app.polish))
  }
  /// Whether Return follows the words in the app with `bundle_id`: its own setting, else on for chat apps.
  pub fn send_for(&self, bundle_id: &str) -> bool {
    let chosen = self.styles.iter().find(|app| app.bundle_id.eq_ignore_ascii_case(bundle_id)).and_then(|app| app.send);
    chosen.unwrap_or_else(|| CHAT_APPS.iter().any(|chat| chat.eq_ignore_ascii_case(bundle_id)))
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
  /// Each voice gets its own label (speaker diarization, two small models downloaded at the first meeting).
  pub speakers: bool,
  /// What the summary holds besides the summary itself.
  pub decisions: bool,
  pub action_items: bool,
}
impl Default for Meetings {
  fn default() -> Self { Self { folder: None, system_audio: true, summarize: true, you: "You".into(), others: "Others".into(), speakers: true, decisions: true, action_items: true } }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort { Low, Medium, High }
impl Effort {
  pub fn as_str(self) -> &'static str { match self { Self::Low => "low", Self::Medium => "medium", Self::High => "high" } }
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
  /// On only once the way to Claude works: a key saved in the Keychain and tested, or Claude Code signed
  /// in and tested. Pages can't set it and a loaded file never turns it on: only Rust does, through
  /// `update`, after a test or finding the key at launch.
  pub enabled: bool,
  /// Anthropic's API with the person's own key, or the Claude Code on this Mac with their Claude account.
  /// Set by Rust with `enabled`, as a connection is made; pages can't set it.
  pub via: ClaudeVia,
  pub model: ClaudeModel,
  /// How long Claude may think on each request: low is quickest (polish while typing), high the most careful.
  pub effort: Effort,
  pub commands: bool,
  pub claude_code: Option<String>,
  /// A model on this Mac behind Ollama's API (LM Studio speaks it too): where, and which.
  pub local_endpoint: String,
  pub local_model: String,
  /// Any service that speaks the OpenAI API (OpenAI, Mistral, Groq, OpenRouter, a hosted gateway): where, and
  /// which model; its key is in the Keychain under "openai".
  pub open_ai_endpoint: String,
  pub open_ai_model: String,
}
impl Default for Claude {
  fn default() -> Self { Self { enabled: false, via: ClaudeVia::Api, model: ClaudeModel::Haiku, effort: Effort::Medium, commands: true, claude_code: None, local_endpoint: "http://localhost:11434".into(), local_model: "llama3.2".into(), open_ai_endpoint: "https://api.openai.com".into(), open_ai_model: String::new() } }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeVia { Api, ClaudeCode, Local, OpenAi }

/// An address a key may be sent to: https, or http only to this Mac (localhost, 127.0.0.1, ::1), so the key never
/// crosses a network in the clear.
pub fn secure_endpoint(endpoint: &str) -> bool {
  if endpoint.len() > 200 || endpoint.contains(char::is_whitespace) { return false; }
  if let Some(rest) = endpoint.strip_prefix("https://") { return !rest.is_empty(); }
  let Some(rest) = endpoint.strip_prefix("http://") else { return false };
  let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
  let host = host.strip_prefix('[').map_or_else(|| host.split(':').next().unwrap_or_default(), |v6| v6.split(']').next().unwrap_or_default());
  matches!(host, "localhost" | "127.0.0.1" | "::1")
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

/// A button on the pill the dots open into. The pill keeps this order, whatever order they were picked in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PillButton { Note, Write, Sticky, Meeting, Library, Settings }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
  pub theme: Theme, pub edge: Edge, pub size: Size, pub idle: Idle, pub hint: bool,
  /// The buttons on the pill, in its order; never none.
  pub pill: Vec<PillButton>,
  /// How far the dots sit from the screen's edge, in points (0 to 120).
  pub margin: u32,
  /// Keep clear of the Dock and the menu bar (the screen's visible area), rather than the whole screen.
  pub avoid_dock: bool,
}
impl Default for Appearance {
  fn default() -> Self {
    use PillButton::*;
    Self { theme: Theme::System, edge: Edge::Right, size: Size::Medium, idle: Idle::Dots, hint: true, pill: vec![Note, Write, Sticky, Meeting, Library, Settings], margin: 8, avoid_dock: true }
  }
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      version: VERSION, general: General::default(), shortcuts: Shortcuts::default(), dictation: Dictation::default(), vocabulary: Vocabulary::default(),
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
  let app = |bundle_id: &str, name: &str, style| AppStyle { bundle_id: bundle_id.into(), name: name.into(), style, polish: false, send: None };
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
  /// What a value must be, beyond its type, for the whole to be accepted: folders are absolute paths,
  /// each chord is usable and none is taken twice, the file name is a name rather than a path, and the
  /// language is one Whisper knows.
  fn valid(&self) -> bool {
    let folder = |path: &Option<String>| path.as_deref().is_none_or(|path| Path::new(path).is_absolute() && !path.contains('\0'));
    let shortcuts = &self.shortcuts;
    let chords: Vec<&Chord> = shortcuts.chords().into_iter().flatten().collect();
    let distinct = chords.iter().enumerate().all(|(i, a)| chords[..i].iter().all(|b| (a.key_code, a.modifiers) != (b.key_code, b.modifiers)));
    let file_name = &self.notes.file_name;
    let language = &self.dictation.language;
    let local = &self.claude;
    folder(&self.notes.folder) && folder(&self.meetings.folder) && folder(&self.claude.claude_code)
      && (local.local_endpoint.starts_with("http://") || local.local_endpoint.starts_with("https://")) && local.local_endpoint.len() <= 200 && !local.local_endpoint.contains(char::is_whitespace)
      && !local.local_model.trim().is_empty() && local.local_model.len() <= 80
      && secure_endpoint(&local.open_ai_endpoint)
      && local.open_ai_model.len() <= 80
      && chords.iter().all(|chord| chord.valid()) && distinct
      && !file_name.contains(['/', ':', '\0']) && !file_name.trim_start().starts_with('.')
      && SOUNDS.contains(&self.dictation.start_sound.as_str()) && SOUNDS.contains(&self.dictation.stop_sound.as_str())
      && (language == "auto" || (0..=whisper_rs::get_lang_max_id()).any(|id| whisper_rs::get_lang_str(id) == Some(language.as_str())))
  }

  /// Lengths and lists cut to what the app handles; empty names back to their defaults.
  fn clamp(&mut self) {
    self.version = VERSION;
    let volume = &mut self.dictation.sound_volume;
    *volume = if volume.is_finite() { volume.clamp(0.0, 1.0) } else { DEFAULT_VOLUME };
    self.appearance.margin = self.appearance.margin.min(120);
    let pill = &mut self.appearance.pill;
    pill.sort();
    pill.dedup();
    if pill.is_empty() { *pill = Appearance::default().pill; }
    let vocabulary = &mut self.vocabulary;
    clip_list(&mut vocabulary.words, MAX_LIST, MAX_WORD);
    clip_list(&mut vocabulary.suggestions, MAX_LIST, MAX_WORD);
    for pair in &mut vocabulary.replacements { pair.from = clip(&pair.from, MAX_TEXT); pair.to = clip(&pair.to, MAX_TEXT); }
    vocabulary.replacements.retain(|pair| !pair.from.is_empty());
    vocabulary.replacements.truncate(MAX_LIST);
    // Trimmed before comparing, and without case: bundle ids are case-insensitive.
    for app in &mut self.apps.styles { app.bundle_id = clip(&app.bundle_id, MAX_TEXT); app.name = clip(&app.name, MAX_TEXT); }
    let mut seen = std::collections::HashSet::new();
    self.apps.styles.retain(|app| !app.bundle_id.is_empty() && seen.insert(app.bundle_id.to_lowercase()));
    self.apps.styles.truncate(MAX_LIST);
    clip_list(&mut self.notes.tags, 50, MAX_WORD);
    self.notes.file_name = clip(&self.notes.file_name, MAX_TEXT);
    if self.notes.file_name.is_empty() { self.notes.file_name = Notes::default().file_name; }
    self.meetings.you = clip(&self.meetings.you, MAX_WORD);
    self.meetings.others = clip(&self.meetings.others, MAX_WORD);
    if self.meetings.you.is_empty() { self.meetings.you = Meetings::default().you; }
    if self.meetings.others.is_empty() { self.meetings.others = Meetings::default().others; }
    for chord in [&mut self.shortcuts.note, &mut self.shortcuts.meeting, &mut self.shortcuts.paste_last, &mut self.shortcuts.write_note, &mut self.shortcuts.sticky, &mut self.shortcuts.ask].into_iter().flatten() { chord.label = clip(&chord.label, 16); }
  }

  /// `patch` merged into these settings, one value at a time: a value of the wrong type, an unknown
  /// choice or an invalid path keeps the old value, and unknown keys are ignored.
  pub fn patched(&self, patch: &Value) -> Settings { self.merged(patch).0 }

  /// `patched`, and whether any of `patch` was left out: a refused value, a list entry or an unknown key.
  fn merged(&self, patch: &Value) -> (Settings, bool) {
    let accepts = |trial: &Value| serde_json::from_value::<Settings>(trial.clone()).is_ok_and(|settings| settings.valid());
    let mut good = serde_json::to_value(self).unwrap_or(Value::Null);
    let mut leaves = Vec::new();
    let mut lost = collect(patch, &good, &mut Vec::new(), &mut leaves);
    for (path, value) in leaves {
      let trial = put(&good, &path, value.clone());
      if accepts(&trial) { good = trial; continue; }
      lost = true;
      // A list keeps the entries that are fine on their own, so one bad entry never costs the rest.
      let Value::Array(items) = value else { continue };
      let kept: Vec<Value> = items.into_iter().filter(|item| accepts(&put(&good, &path, Value::Array(vec![item.clone()])))).collect();
      let trial = put(&good, &path, Value::Array(kept));
      if accepts(&trial) { good = trial; }
    }
    let mut settings: Settings = serde_json::from_value(good).unwrap_or_else(|_| self.clone());
    settings.clamp();
    (settings, lost)
  }
}

fn put(base: &Value, path: &[String], value: Value) -> Value {
  let mut trial = base.clone();
  if let Some(slot) = path.iter().try_fold(&mut trial, |node, key| node.get_mut(key)) { *slot = value; }
  trial
}

/// The values of `patch` to try, by path: sections merge key by key, and each setting in them (a list,
/// a chord, a string) is tried whole, so a chord never mixes old and new keys. True when a key is unknown.
fn collect(patch: &Value, base: &Value, path: &mut Vec<String>, leaves: &mut Vec<(Vec<String>, Value)>) -> bool {
  let (Some(patch), Some(base)) = (patch.as_object(), base.as_object()) else { return false };
  let mut unknown = false;
  for (key, value) in patch {
    let Some(known) = base.get(key) else { unknown = true; continue };
    path.push(key.clone());
    if path.len() < 2 && value.is_object() && known.is_object() { unknown |= collect(value, known, path, leaves); } else { leaves.push((path.clone(), value.clone())); }
    path.pop();
  }
  unknown
}

/// The settings in `path`, field by field over the defaults; the defaults when it is missing or unreadable.
pub fn load_from(path: &Path) -> Settings { load(path).0 }

/// `load_from`, and whether the file holds anything this version couldn't keep, so it is worth saving
/// a copy of before it is replaced.
fn load(path: &Path) -> (Settings, bool) {
  let bytes = match std::fs::read(path) {
    Ok(bytes) => bytes,
    Err(e) => return (Settings::default(), e.kind() != std::io::ErrorKind::NotFound),
  };
  let Ok(saved) = serde_json::from_slice::<Value>(&bytes) else { return (Settings::default(), true) };
  let newer = saved.get("version").and_then(Value::as_u64).is_some_and(|version| version > VERSION.into());
  let (mut settings, lost) = Settings::default().merged(&saved);
  settings.claude.enabled = false;
  (settings, !saved.is_object() || newer || lost)
}

/// Copies the file as found at launch beside it, once, before the first save replaces it.
fn keep_aside(path: &Path) {
  let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs());
  let copy = path.with_extension(format!("json.bad-{stamp}"));
  match std::fs::copy(path, &copy) {
    Ok(_) => log::warn!("settings: kept the file as found at {}", copy.display()),
    Err(e) => log::warn!("settings: couldn’t keep a copy of the file as found: {e}"),
  }
}

/// Written beside the file, synced, then renamed over it: a crash leaves the old settings or the new, never half.
pub fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
  use std::io::Write;
  let dir = path.parent().ok_or("Couldn’t find the settings folder.")?;
  std::fs::create_dir_all(dir).map_err(|e| format!("Couldn’t make the settings folder: {e}"))?;
  let temp = path.with_extension("json.tmp");
  let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
  let written = std::fs::File::create(&temp).and_then(|mut file| { file.write_all(&json)?; file.sync_all() });
  if let Err(e) = written.and_then(|_| std::fs::rename(&temp, path)) {
    let _ = std::fs::remove_file(&temp);
    return Err(format!("Couldn’t save your settings: {e}"));
  }
  Ok(())
}

static CURRENT: RwLock<Option<Settings>> = RwLock::new(None);
static FILE: OnceLock<PathBuf> = OnceLock::new();
/// One change at a time from read to save, so two quick changes never lose one another.
static WRITING: Mutex<()> = Mutex::new(());
/// The file at launch had values this version couldn't keep, and no copy of it is made yet.
static DAMAGED: AtomicBool = AtomicBool::new(false);

/// The settings now. Before `init` (and in tests) the defaults.
pub fn get() -> Settings {
  CURRENT.read().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

/// The settings in `path` made current for a process that never saves them, such as the MCP server,
/// which reads them again for every request so a change in the app reaches it.
pub fn use_file(path: &Path) -> Settings {
  let settings = load_from(path);
  *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
  settings
}

pub fn init(app: &AppHandle) -> Result<(), String> {
  let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("settings.json");
  let (settings, damaged) = load(&path);
  if damaged { log::warn!("settings: {} has values this version can’t use; they are left out", path.display()); }
  DAMAGED.store(damaged && path.exists(), Ordering::SeqCst);
  *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(settings);
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
  // Settings' sidebar is native vibrancy, which follows the app's appearance, not the page's theme.
  app.set_theme(match settings.appearance.theme { Theme::System => None, Theme::Light => Some(tauri::Theme::Light), Theme::Dark => Some(tauri::Theme::Dark) });
  let _ = app.emit("dictate-settings", settings);
  crate::app::menu::show_tray(app, settings.general.menu_bar_icon);
  crate::app::windows::show_in_dock(app, settings.general.show_in_dock);
  crate::app::menu::recent_changed(app); // the notes folder may have moved
}

fn replace(app: &AppHandle, next: impl FnOnce(&Settings) -> Settings) -> Result<Settings, String> {
  let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
  let settings = next(&get());
  if let Some(path) = FILE.get() {
    if DAMAGED.swap(false, Ordering::SeqCst) { keep_aside(path); }
    save_to(path, &settings)?;
  }
  *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
  apply(app, &settings);
  Ok(settings)
}

/// A change from Rust: the same path as the page's, so every window hears it. Unlike a page's, it can
/// turn Claude on.
pub fn update(app: &AppHandle, patch: &Value) -> Result<Settings, String> {
  replace(app, |current| current.patched(patch))
}

#[tauri::command]
pub fn get_settings() -> Settings { get() }

#[tauri::command]
pub fn update_settings(app: AppHandle, mut patch: Value) -> Result<Settings, String> {
  if !patch.is_object() { return Err("Invalid settings".into()); }
  // The OpenAI-compatible address and model go with the key: only `claude_connect_open_ai` sets them, so a page can
  // never point a saved key at another host.
  if let Some(claude) = patch.get_mut("claude").and_then(Value::as_object_mut) { claude.remove("enabled"); claude.remove("via"); claude.remove("openAiEndpoint"); claude.remove("openAiModel"); }
  update(&app, &patch)
}

/// Everything back to how it was on first launch. The Anthropic key is no setting: it stays in the
/// Keychain, so Claude stays connected as it was, now and at the next launch.
#[tauri::command]
pub fn reset_settings(app: AppHandle) -> Result<Settings, String> {
  replace(&app, |current| {
    let mut fresh = Settings::default();
    fresh.claude.enabled = current.claude.enabled;
    fresh
  })
}

#[cfg(test)]
mod tests {
  #[test]
  fn the_pill_keeps_its_order_once_each_and_never_goes_empty() {
    let picked = Settings::default().patched(&json!({ "appearance": { "pill": ["settings", "note", "note", "sticky"] } }));
    assert_eq!(picked.appearance.pill, vec![PillButton::Note, PillButton::Sticky, PillButton::Settings]);
    let none = Settings::default().patched(&json!({ "appearance": { "pill": [] } }));
    assert_eq!(none.appearance.pill, Appearance::default().pill);
  }

  use super::*;
  use serde_json::json;

  fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-settings-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn the_cues_are_the_macs_own_sounds_at_a_volume_between_silent_and_full() {
    let base = Settings::default();
    let chosen = base.patched(&json!({ "dictation": { "startSound": "Glass", "stopSound": "Submarine", "soundVolume": 0.75 } }));
    assert_eq!((chosen.dictation.start_sound.as_str(), chosen.dictation.stop_sound.as_str(), chosen.dictation.sound_volume), ("Glass", "Submarine", 0.75));
    // A name that isn't one of the Mac's sounds keeps the old one; a volume past the ends is brought back.
    let refused = chosen.patched(&json!({ "dictation": { "startSound": "../Evil", "stopSound": "", "soundVolume": 4.5 } }));
    assert_eq!((refused.dictation.start_sound.as_str(), refused.dictation.stop_sound.as_str(), refused.dictation.sound_volume), ("Glass", "Submarine", 1.0));
    assert_eq!(chosen.patched(&json!({ "dictation": { "soundVolume": -2 } })).dictation.sound_volume, 0.0);
    assert_eq!(chosen.patched(&json!({ "dictation": { "soundVolume": "loud" } })).dictation.sound_volume, 0.75);
    for name in SOUNDS { assert!(Path::new(&format!("/System/Library/Sounds/{name}.aiff")).is_file(), "{name}"); }
  }

  #[test]
  fn return_follows_the_words_in_chat_apps_unless_the_app_says_otherwise() {
    let base = Settings::default();
    assert!(base.apps.send_for("com.tinyspeck.slackmacgap") && base.apps.send_for("COM.APPLE.MobileSMS"));
    assert!(!base.apps.send_for("com.apple.mail") && !base.apps.send_for(""));
    let chosen = base.patched(&json!({ "apps": { "styles": [
      { "bundleId": "com.tinyspeck.slackmacgap", "name": "Slack", "style": "casual", "polish": false, "send": false },
      { "bundleId": "com.apple.mail", "name": "Mail", "style": "formal", "polish": false, "send": true },
      { "bundleId": "com.apple.Notes", "name": "Notes", "style": "default", "polish": false },
    ] } }));
    assert!(!chosen.apps.send_for("com.tinyspeck.slackmacgap") && chosen.apps.send_for("com.apple.mail") && !chosen.apps.send_for("com.apple.Notes"));
    assert_eq!(serde_json::to_value(&chosen.apps.styles[2]).unwrap()["send"], Value::Null); // an older file's entry keeps the default
  }

  #[test]
  fn only_rust_chooses_how_claude_is_reached() {
    let base = Settings::default();
    assert_eq!(base.patched(&json!({ "claude": { "via": "claudeCode" } })).claude.via, ClaudeVia::ClaudeCode);
    assert_eq!(base.patched(&json!({ "claude": { "via": "carrier pigeon" } })).claude.via, ClaudeVia::Api);
    // What a page sends loses `enabled` and `via` before it is applied (update_settings), as the mock does too.
    let mut page = json!({ "claude": { "enabled": true, "via": "claudeCode", "model": "claude-opus-5-5" } });
    if let Some(claude) = page.get_mut("claude").and_then(Value::as_object_mut) { claude.remove("enabled"); claude.remove("via"); }
    assert_eq!(page, json!({ "claude": { "model": "claude-opus-5-5" } }));
  }

  #[test]
  fn a_key_only_goes_over_https_or_to_this_mac() {
    assert!(secure_endpoint("https://api.openai.com"));
    assert!(secure_endpoint("https://openrouter.ai/api"));
    assert!(secure_endpoint("http://localhost:1234"));
    assert!(secure_endpoint("http://127.0.0.1:8080/v1"));
    assert!(secure_endpoint("http://[::1]:8080"));
    assert!(!secure_endpoint("http://api.openai.com"));
    assert!(!secure_endpoint("http://192.168.1.10:1234"));
    assert!(!secure_endpoint("http://localhost.evil.com"));
    assert!(!secure_endpoint("ftp://localhost"));
    assert!(!secure_endpoint("https://"));
    assert!(!secure_endpoint("https://a b"));
  }

  #[test]
  fn defaults_are_the_documented_ones_in_camel_case() {
    let value = serde_json::to_value(Settings::default()).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["general"], json!({ "menuBarIcon": true, "showInDock": false, "checkForUpdates": true }));
    assert_eq!(value["shortcuts"], json!({ "dictate": "fn", "handsFree": true, "command": "control", "note": null, "meeting": null, "pasteLast": null, "writeNote": null, "sticky": null, "ask": null }));
    assert_eq!(value["dictation"], json!({ "language": "auto", "translateToEnglish": false, "removeFillers": true, "sounds": true, "soundVolume": 0.3, "startSound": "Tink", "stopSound": "Pop", "model": "turbo" }));
    assert_eq!(value["vocabulary"], json!({ "words": [], "replacements": [], "learn": true, "suggestions": [] }));
    assert_eq!(value["apps"]["defaultStyle"], "default");
    assert!(value["apps"]["styles"].as_array().unwrap().iter().any(|app| app["bundleId"] == "com.apple.Terminal" && app["style"] == "code" && app["polish"] == false));
    assert_eq!(value["notes"], json!({ "folder": null, "fileName": "{date} {title}", "frontmatter": true, "dailyNote": false, "tags": [], "claudeTitle": true, "claudeActions": false }));
    assert_eq!(value["meetings"], json!({ "folder": null, "systemAudio": true, "summarize": true, "you": "You", "others": "Others", "speakers": true, "decisions": true, "actionItems": true }));
    assert_eq!(value["claude"], json!({ "enabled": false, "via": "api", "model": "claude-haiku-5-5", "effort": "medium", "commands": true, "claudeCode": null, "localEndpoint": "http://localhost:11434", "localModel": "llama3.2", "openAiEndpoint": "https://api.openai.com", "openAiModel": "" }));
    assert_eq!(value["agents"], json!({ "mcp": true, "shareHistory": false, "shareNotes": true, "shareMeetings": true, "allowWrite": false }));
    assert_eq!(value["history"], json!({ "keep": "week" }));
    assert_eq!(value["appearance"], json!({ "theme": "system", "edge": "right", "size": "medium", "idle": "dots", "hint": true, "pill": ["note", "write", "sticky", "meeting", "library", "settings"], "margin": 8, "avoidDock": true }));
  }

  #[test]
  fn a_partial_patch_changes_only_what_it_names() {
    let before = Settings::default();
    let after = before.patched(&json!({ "appearance": { "edge": "left" }, "dictation": { "language": "tr" }, "shortcuts": { "note": { "keyCode": 45, "modifiers": 1_572_864, "label": "⌥⌘N" } } }));
    assert_eq!(after.appearance.edge, Edge::Left);
    assert_eq!(after.dictation.language, "tr");
    assert_eq!(after.shortcuts.note, Some(Chord { key_code: 45, modifiers: 1_572_864, label: "⌥⌘N".into() }));
    assert_eq!(after.appearance.theme, before.appearance.theme);
    assert_eq!(after.dictation.remove_fillers, before.dictation.remove_fillers);
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
      "general": { "menuBarIcon": "no" },
      "claude": { "model": "gpt-4" },
      "notes": { "folder": "relative/path", "fileName": "   " },
      "meetings": { "you": "" },
      "dictation": { "language": "../../x" },
      "shortcuts": { "meeting": { "keyCode": 45, "modifiers": 0, "label": "N" }, "pasteLast": { "keyCode": "v" } },
      "vocabulary": { "words": [" Can ", "can", "", "x".repeat(100)] },
    }));
    assert_eq!(after.version, 1);
    assert_eq!(after.appearance.theme, Theme::Dark);
    assert_eq!(after.appearance.edge, Edge::Right); // the default, since the one given was no edge
    assert!(after.appearance.hint);
    assert!(after.general.menu_bar_icon);
    assert!(!after.patched(&json!({ "general": { "menuBarIcon": false } })).general.menu_bar_icon);
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
  fn chords_are_usable_and_never_taken_twice() {
    let chord = |key_code: u16, modifiers: u64| json!({ "keyCode": key_code, "modifiers": modifiers, "label": "x" });
    let note = |patch: Value| Settings::default().patched(&json!({ "shortcuts": { "note": patch } })).shortcuts.note.map(|chord| (chord.key_code, chord.modifiers));
    assert_eq!(note(chord(96, 0)), Some((96, 0))); // F5 alone
    assert_eq!(note(chord(96, SHIFT)), Some((96, SHIFT)));
    assert_eq!(note(chord(45, SHIFT)), None); // ⇧N would take a capital letter
    assert_eq!(note(chord(45, 1)), None);
    assert_eq!(note(chord(45, 1 << 16)), None); // Caps Lock is not a modifier here
    assert_eq!(note(chord(45, COMMAND | 1 << 16)), None);
    assert_eq!(note(chord(45, COMMAND | OPTION)), Some((45, COMMAND | OPTION)));
    let taken = Settings::default().patched(&json!({ "shortcuts": { "note": chord(45, COMMAND | OPTION) } }));
    let after = taken.patched(&json!({ "shortcuts": { "meeting": chord(45, COMMAND | OPTION), "pasteLast": chord(9, COMMAND | OPTION) } }));
    assert_eq!(after.shortcuts.meeting, None);
    assert_eq!(after.shortcuts.paste_last.map(|chord| chord.key_code), Some(9));
    // A new chord replaces the old one whole, never mixing their keys and labels.
    let moved = taken.patched(&json!({ "shortcuts": { "note": { "keyCode": 96, "modifiers": 0, "label": "F5" } } })).shortcuts.note.unwrap();
    assert_eq!((moved.key_code, moved.modifiers, moved.label.as_str()), (96, 0, "F5"));
  }

  #[test]
  fn languages_file_names_and_claude_are_checked() {
    let language = |code: &str| Settings::default().patched(&json!({ "dictation": { "language": code } })).dictation.language;
    for bad in ["", "x", "zzzzz", "english", "EN"] { assert_eq!(language(bad), "auto", "{bad}"); }
    assert_eq!(language("tr"), "tr");
    assert_eq!(language("haw"), "haw");
    let file_name = |name: &str| Settings::default().patched(&json!({ "notes": { "fileName": name } })).notes.file_name;
    for bad in ["../../../Library/LaunchAgents/{title}", "a/b", "{date}: {title}", ".{title}"] { assert_eq!(file_name(bad), "{date} {title}", "{bad}"); }
    assert_eq!(file_name("{date} {time} {title}"), "{date} {time} {title}");
    // Only Rust turns Claude on; a patch from a page can't.
    assert!(Settings::default().patched(&json!({ "claude": { "enabled": true } })).claude.enabled);
  }

  #[test]
  fn app_styles_are_one_per_app_and_a_bad_entry_drops_only_itself() {
    let after = Settings::default().patched(&json!({ "apps": { "styles": [
      { "bundleId": "com.a", "name": "A", "style": "code" }, { "bundleId": " com.a", "name": "A", "style": "formal" },
      { "bundleId": "COM.A", "name": "A", "style": "raw" }, { "bundleId": "com.b", "name": "B", "style": "markdown" },
      { "bundleId": "com.c", "style": "casual" }, { "bundleId": "com.d", "name": "D", "style": "casual" },
    ] } }));
    let styles: Vec<(&str, Style)> = after.apps.styles.iter().map(|app| (app.bundle_id.as_str(), app.style)).collect();
    assert_eq!(styles, [("com.a", Style::Code), ("com.d", Style::Casual)]);
    assert_eq!(after.apps.style_for("Com.A"), (Style::Code, false));
    let replacements = Settings::default().patched(&json!({ "vocabulary": { "replacements": [{ "from": "a", "to": "b" }, { "from": "c" }] } })).vocabulary.replacements;
    assert_eq!(replacements, [Replacement { from: "a".into(), to: "b".into() }]);
  }

  #[test]
  fn a_file_this_version_cannot_keep_is_flagged_and_copied_aside() {
    let dir = temp("damaged");
    let path = dir.join("settings.json");
    assert!(!load(&path).1); // missing is just a first launch
    std::fs::write(&path, br#"{ "version": 1, "appearance": { "edge": "left" "#).unwrap();
    assert_eq!(load(&path), (Settings::default(), true));
    std::fs::write(&path, br#"{ "version": 2, "appearance": { "edge": "left" } }"#).unwrap();
    assert!(load(&path).1);
    std::fs::write(&path, br#"{ "version": 1, "appearance": { "edge": "left" }, "claude": { "enabled": true } }"#).unwrap();
    let (loaded, damaged) = load(&path);
    assert!(!damaged);
    assert_eq!(loaded.appearance.edge, Edge::Left);
    assert!(!loaded.claude.enabled); // a copied file never turns Claude on
    save_to(&path, &Settings::default()).unwrap();
    assert!(!load(&path).1); // what this version writes, it keeps
    keep_aside(&path);
    let copies: Vec<String> = std::fs::read_dir(&dir).unwrap().filter_map(|entry| entry.ok()?.file_name().into_string().ok()).filter(|name| name.starts_with("settings.json.bad-")).collect();
    assert_eq!(copies.len(), 1);
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
