//! The MCP server agents start as `tabtasker-dictate --mcp`: JSON-RPC 2.0 over stdio, one message per
//! line. It never starts the app, the microphone or the model. It reads the settings file again for
//! every request, so a change in Settings reaches an agent that is already running, and it answers only
//! from the notes and meetings folders and the dictation history.
//!
//! The Agents page's commands are here too: what is installed, and adding the server to Claude Code
//! and Claude Desktop.
use crate::library::notes;
use crate::settings::{Agents, Keep, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const NAME: &str = "tabtasker-dictate";
const PROTOCOL: &str = "2025-06-18";
const PROTOCOLS: [&str; 3] = [PROTOCOL, "2025-03-26", "2024-11-05"];
/// Larger files are not notes anyone dictated; reading them would only flood the agent.
const MAX_FILE: u64 = 2 << 20;
const MAX_TEXT: usize = 200_000;
/// How often a running server looks for a change in Settings that changes its tools.
const WATCH: Duration = Duration::from_secs(2);

// ---------- where things are ----------

fn home() -> Result<PathBuf, String> {
  std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from).ok_or_else(|| "Couldn’t find your home folder.".into())
}

/// The app data folder, as Tauri names it from the bundle identifier.
fn data_dir(home: &Path) -> PathBuf {
  home.join("Library/Application Support/com.tabtasker.dictate")
}

fn load_settings() -> Settings {
  home().map(|home| crate::settings::use_file(&data_dir(&home).join("settings.json"))).unwrap_or_default()
}

// ---------- the tools ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gate {
  Notes,
  Meetings,
  History,
  Write,
}

impl Gate {
  fn open(self, agents: &Agents) -> bool {
    agents.mcp
      && match self {
        Gate::Notes => agents.share_notes,
        Gate::Meetings => agents.share_meetings,
        Gate::History => agents.share_history,
        Gate::Write => agents.allow_write,
      }
  }
  fn refusal(self, agents: &Agents) -> &'static str {
    if !agents.mcp {
      return "TabTasker Dictate isn’t answering agents. The person can turn on Answer agents in TabTasker Dictate, Settings, Agents.";
    }
    match self {
      Gate::Notes => "Sharing notes is off. The person can turn on Notes in TabTasker Dictate, Settings, Agents.",
      Gate::Meetings => "Sharing meetings is off. The person can turn on Meetings in TabTasker Dictate, Settings, Agents.",
      Gate::History => "Sharing recent dictations is off. The person can turn on Recent dictations in TabTasker Dictate, Settings, Agents.",
      Gate::Write => "Writing notes is off. The person can turn on Write notes in TabTasker Dictate, Settings, Agents.",
    }
  }
}

const TOOLS: [(&str, Gate); 8] = [
  ("list_notes", Gate::Notes),
  ("read_note", Gate::Notes),
  ("search_notes", Gate::Notes),
  ("list_meetings", Gate::Meetings),
  ("read_meeting", Gate::Meetings),
  ("recent_dictations", Gate::History),
  ("create_note", Gate::Write),
  ("append_to_note", Gate::Write),
];

fn allowed(agents: &Agents) -> Vec<&'static str> {
  TOOLS.iter().filter(|(_, gate)| gate.open(agents)).map(|(name, _)| *name).collect()
}

fn definition(name: &str) -> Value {
  let limit =
    |default: u32, max: u32| json!({ "type": "integer", "minimum": 1, "maximum": max, "description": format!("How many to return, {default} when left out.") });
  let path = |what: &str| json!({ "type": "string", "description": format!("The {what}’s path, as {what}s are listed.") });
  let read = |title: &str| json!({ "title": title, "readOnlyHint": true, "openWorldHint": false });
  let (title, description, properties, required, annotations) = match name {
    "list_notes" => ("List notes",
      "Lists the person’s notes from TabTasker Dictate, newest first. Notes are spoken notes saved as Markdown files. Gives each note’s path (for read_note), title and when it last changed.",
      json!({ "limit": limit(50, 500) }), json!([]), read("List notes")),
    "read_note" => ("Read a note", "Reads one note in full, as Markdown.", json!({ "path": path("note") }), json!(["path"]), read("Read a note")),
    "search_notes" => ("Search notes",
      "Finds the notes that contain every word of the query in their title or text, ignoring case. Gives the matching notes, newest first, with the lines that match.",
      json!({ "query": { "type": "string", "description": "Words to look for." }, "limit": limit(20, 100) }), json!(["query"]), read("Search notes")),
    "list_meetings" => ("List meetings",
      "Lists recorded meetings, newest first. Each is a Markdown file with a transcript labelled by speaker and time, and a summary when one was made. Gives each meeting’s path (for read_meeting), title and when it last changed.",
      json!({ "limit": limit(50, 500) }), json!([]), read("List meetings")),
    "read_meeting" => ("Read a meeting", "Reads one meeting in full, as Markdown.", json!({ "path": path("meeting") }), json!(["path"]), read("Read a meeting")),
    "recent_dictations" => ("Recent dictations",
      "What the person dictated lately into other apps, newest first, with the app and the time. Only what TabTasker Dictate’s history still keeps.",
      json!({ "limit": limit(20, 200) }), json!([]), read("Recent dictations")),
    "create_note" => ("Create a note",
      "Saves a new Markdown note in the person’s notes folder. It never replaces a note: a title that is taken gets a new name. Gives the new note’s path.",
      json!({ "title": { "type": "string", "description": "A short title, used for the file name." }, "text": { "type": "string", "description": "The note, in Markdown." } }),
      json!(["text"]), json!({ "title": "Create a note", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false })),
    "append_to_note" => ("Add to a note",
      "Adds text to the end of an existing note, after a blank line. What the note already says is never changed.",
      json!({ "path": path("note"), "text": { "type": "string", "description": "The text to add, in Markdown." } }),
      json!(["path", "text"]), json!({ "title": "Add to a note", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false })),
    _ => unreachable!("every tool has a definition"),
  };
  json!({ "name": name, "title": title, "description": description, "annotations": annotations,
    "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false } })
}

fn result(text: String, error: bool) -> Value {
  json!({ "content": [{ "type": "text", "text": text }], "isError": error })
}

/// Structured results also go as text, for clients older than structuredContent.
fn structured(value: Value) -> Value {
  json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }], "structuredContent": value, "isError": false })
}

fn text_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
  match args.get(key) {
    Some(Value::String(text)) => Ok(text),
    Some(_) => Err(format!("“{key}” must be text.")),
    None => Err(format!("“{key}” is required.")),
  }
}

fn limit_arg(args: &Value, default: usize, max: usize) -> Result<usize, String> {
  match args.get("limit") {
    None | Some(Value::Null) => Ok(default),
    Some(value) => {
      value.as_f64().filter(|n| *n >= 1.0).map(|n| (n as usize).min(max)).ok_or_else(|| format!("“limit” must be a whole number from 1 to {max}."))
    }
  }
}

/// Runs one tool the settings allow. A problem the agent can fix comes back as `Err` with a sentence for it.
fn run_tool(name: &str, args: &Value, settings: &Settings) -> Result<Value, String> {
  // Resolved once, so paths shown to the agent and the meetings folder compare the same way.
  let real = |dir: PathBuf| dir.canonicalize().unwrap_or(dir);
  let (notes_dir, meetings_dir) = (real(notes::notes_dir()?), real(notes::meetings_dir()?));
  // Meetings saved inside the notes folder are not notes, so turning meetings off keeps them out of the note tools too.
  let skip = (meetings_dir != notes_dir && meetings_dir.starts_with(&notes_dir)).then_some(meetings_dir.as_path());
  if meetings_dir == notes_dir {
    one_folder(name, &settings.agents)?;
  }
  match name {
    "list_notes" | "list_meetings" => {
      let limit = limit_arg(args, 50, 500)?;
      let found = if name == "list_notes" { list(&notes_dir, skip, true)? } else { list(&meetings_dir, None, false)? };
      let key = if name == "list_notes" { "notes" } else { "meetings" };
      Ok(structured(json!({ "total": found.len(), key: found.iter().take(limit).map(Doc::json).collect::<Vec<_>>() })))
    }
    "read_note" => read(&resolve(&notes_dir, text_arg(args, "path")?, skip, false)?).map(|text| result(text, false)),
    "read_meeting" => read(&resolve(&meetings_dir, text_arg(args, "path")?, None, true)?).map(|text| result(text, false)),
    "search_notes" => {
      let query = text_arg(args, "query")?;
      let limit = limit_arg(args, 20, 100)?;
      let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
      if words.is_empty() || query.chars().count() > 200 {
        return Err("Give a few words to look for.".into());
      }
      Ok(structured(json!({ "query": query, "results": search(&notes_dir, skip, &words, limit)? })))
    }
    "recent_dictations" => {
      let limit = limit_arg(args, 20, 200)?;
      if settings.history.keep == Keep::Off {
        return Err(
          "TabTasker Dictate keeps no words in its history, so there are none to share. The person can change that in Settings, History & stats.".into(),
        );
      }
      Ok(structured(json!({ "dictations": dictations(&data_dir(&home()?).join("history.jsonl"), settings.history.keep, limit, now_ms()) })))
    }
    "create_note" => {
      let title = match args.get("title") {
        None | Some(Value::Null) => "",
        _ => text_arg(args, "title")?,
      };
      let text = text_arg(args, "text")?;
      if text.trim().is_empty() {
        return Err("“text” is empty.".into());
      }
      if text.chars().count() > MAX_TEXT || title.chars().count() > 200 {
        return Err("That note is too long.".into());
      }
      let path = notes::save_markdown(notes::Kind::Note, title.trim(), text, &stamp(now_ms() / 1000), &[])?;
      Ok(structured(json!({ "path": relative(&notes_dir, &real(path)), "saved": true })))
    }
    "append_to_note" => {
      let text = text_arg(args, "text")?;
      if text.trim().is_empty() {
        return Err("“text” is empty.".into());
      }
      if text.chars().count() > MAX_TEXT {
        return Err("That is too long to add at once.".into());
      }
      let file = resolve(&notes_dir, text_arg(args, "path")?, skip, false)?;
      append(&file, text)?;
      Ok(result(format!("Added to {}.", relative(&notes_dir, &file)), false))
    }
    _ => unreachable!("only known tools get here"),
  }
}

/// With meetings saved in the notes folder itself, a file there can be either, so the folder goes to
/// agents only when both notes and meetings are shared.
fn one_folder(name: &str, agents: &Agents) -> Result<(), String> {
  let (off, setting) = match name {
    "list_notes" | "read_note" | "search_notes" | "append_to_note" => (!agents.share_meetings, "Meetings"),
    "list_meetings" | "read_meeting" => (!agents.share_notes, "Notes"),
    _ => (false, ""),
  };
  if !off {
    return Ok(());
  }
  Err(format!("Meetings are saved in the notes folder, and sharing {} is off, so that folder isn’t shared. The person can turn on {setting} in TabTasker Dictate, Settings, Agents, or choose a separate meetings folder in Settings, Meetings.", setting.to_lowercase()))
}

/// What an agent can tell the person when macOS refuses a folder or file. Privacy controls charge the
/// access to the app that started this server, not to TabTasker Dictate.
const DENIED: &str = "macOS doesn’t let this agent open that folder. The person can allow the app the agent runs in (such as Claude, Terminal or their editor) in System Settings, Privacy & Security, Files and Folders.";

fn unreadable(e: &std::io::Error, otherwise: impl FnOnce() -> String) -> String {
  if e.kind() == std::io::ErrorKind::PermissionDenied {
    DENIED.into()
  } else {
    otherwise()
  }
}

// ---------- files, confined to their folder ----------

#[derive(Debug)]
struct Doc {
  path: String,
  title: String,
  modified_ms: u64,
  bytes: u64,
}

impl Doc {
  fn json(&self) -> Value {
    json!({ "path": self.path, "title": self.title, "modified": iso(self.modified_ms), "bytes": self.bytes })
  }
}

/// `path` under `root`, with forward slashes: what an agent passes back.
fn relative(root: &Path, path: &Path) -> String {
  path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned()
}

/// The Markdown files in `root` (and its folders when `deep`), newest first. Hidden files and folders,
/// symlinks and the `skip` folder are left out. A missing `root` has none; one macOS refuses is an error,
/// so a folder the agent can't open never reads as an empty one.
fn list(root: &Path, skip: Option<&Path>, deep: bool) -> Result<Vec<Doc>, String> {
  let mut found = Vec::new();
  let mut folders = vec![(root.to_path_buf(), 0)];
  let mut seen = 0;
  while let Some((folder, depth)) = folders.pop() {
    let entries = match std::fs::read_dir(&folder) {
      Ok(entries) => entries,
      Err(e) if folder == root && e.kind() != std::io::ErrorKind::NotFound => return Err(unreadable(&e, || format!("Couldn’t open the folder: {e}"))),
      Err(_) => continue,
    };
    for entry in entries.flatten() {
      seen += 1;
      if seen > 20_000 {
        break;
      }
      let path = entry.path();
      let Ok(kind) = entry.file_type() else { continue };
      if entry.file_name().to_string_lossy().starts_with('.') || kind.is_symlink() {
        continue;
      }
      if kind.is_dir() {
        if deep && depth < 8 && Some(path.as_path()) != skip {
          folders.push((path, depth + 1));
        }
      } else if kind.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) {
        let Ok(meta) = entry.metadata() else { continue };
        let modified_ms = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0, |since| since.as_millis() as u64);
        let title = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        found.push(Doc { path: relative(root, &path), title, modified_ms, bytes: meta.len() });
      }
    }
  }
  found.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.path.cmp(&b.path)));
  Ok(found)
}

/// The file `path` names inside `root`, resolved through every `..` and symlink first, so nothing
/// outside the folder can be reached. `flat` allows only files directly in `root`.
fn resolve(root: &Path, path: &str, skip: Option<&Path>, flat: bool) -> Result<PathBuf, String> {
  let path = path.trim();
  if path.is_empty() || path.contains('\0') {
    return Err("Give a path, as the list shows it.".into());
  }
  use std::io::ErrorKind::{NotADirectory, NotFound};
  let root = root.canonicalize().map_err(|e| match e.kind() {
    NotFound => "There are none yet: the folder doesn’t exist.".into(),
    _ => unreadable(&e, || format!("Couldn’t open the folder: {e}")),
  })?;
  let file = root.join(path).canonicalize().map_err(|e| match e.kind() {
    NotFound | NotADirectory => format!("There is nothing at “{path}”."),
    _ => unreadable(&e, || format!("Couldn’t open “{path}”: {e}")),
  })?;
  let inside = file.strip_prefix(&root).ok().filter(|rest| !rest.as_os_str().is_empty());
  let Some(rest) = inside else { return Err(format!("“{path}” is outside the folder agents can read.")) };
  if flat && rest.components().count() != 1 {
    return Err(format!("“{path}” is outside the folder agents can read."));
  }
  if rest.components().any(|part| part.as_os_str().to_string_lossy().starts_with('.')) {
    return Err(format!("There is nothing at “{path}”."));
  }
  if skip.and_then(|skip| skip.canonicalize().ok()).is_some_and(|skip| file.starts_with(skip)) {
    return Err(format!("“{path}” is a meeting, not a note."));
  }
  if !file.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) || !file.is_file() {
    return Err(format!("“{path}” isn’t a Markdown note."));
  }
  Ok(file)
}

fn read(file: &Path) -> Result<String, String> {
  let failed = |e: std::io::Error| unreadable(&e, || format!("Couldn’t read it: {e}"));
  let size = std::fs::metadata(file).map_err(failed)?.len();
  if size > MAX_FILE {
    return Err("That file is too large to read.".into());
  }
  let bytes = std::fs::read(file).map_err(failed)?;
  Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Every word in the title or the text; up to three matching lines from each note.
fn search(root: &Path, skip: Option<&Path>, words: &[String], limit: usize) -> Result<Vec<Value>, String> {
  let mut results = Vec::new();
  for file in list(root, skip, true)? {
    if results.len() == limit {
      break;
    }
    if file.bytes > MAX_FILE {
      continue;
    }
    let Ok(bytes) = std::fs::read(root.join(&file.path)) else { continue };
    let text = String::from_utf8_lossy(&bytes);
    let (title, lower) = (file.title.to_lowercase(), text.to_lowercase());
    if !words.iter().all(|word| title.contains(word.as_str()) || lower.contains(word.as_str())) {
      continue;
    }
    let lines: Vec<Value> = text
      .lines()
      .enumerate()
      .filter(|(_, line)| {
        let line = line.to_lowercase();
        words.iter().any(|word| line.contains(word.as_str()))
      })
      .take(3)
      .map(|(at, line)| json!({ "line": at + 1, "text": line.trim().chars().take(200).collect::<String>() }))
      .collect();
    let mut found = file.json();
    found["matches"] = Value::Array(lines);
    results.push(found);
  }
  Ok(results)
}

/// O_NOFOLLOW from <fcntl.h> on macOS: the file is opened only if it is still not a symlink.
const NO_FOLLOW: i32 = 0x0100;

/// Adds `text` after a blank line, through an append-only handle, so what is there can't be lost. Only
/// the note's last byte is read, however long it is.
fn append(file: &Path, text: &str) -> Result<(), String> {
  use std::io::{Seek, SeekFrom};
  use std::os::unix::fs::OpenOptionsExt;
  let mut handle = std::fs::OpenOptions::new()
    .read(true)
    .append(true)
    .custom_flags(NO_FOLLOW)
    .open(file)
    .map_err(|e| unreadable(&e, || format!("Couldn’t open the note: {e}")))?;
  let mut last = [0];
  let empty = handle.metadata().map_err(|e| e.to_string())?.len() == 0;
  if !empty {
    handle.seek(SeekFrom::End(-1)).and_then(|_| handle.read_exact(&mut last)).map_err(|e| format!("Couldn’t read the note: {e}"))?;
  }
  let gap = if empty {
    ""
  } else if last[0] == b'\n' {
    "\n"
  } else {
    "\n\n"
  };
  let addition = format!("{gap}{}\n", text.trim_end());
  handle.write_all(addition.as_bytes()).and_then(|_| handle.sync_all()).map_err(|e| format!("Couldn’t add to the note: {e}"))
}

/// The newest dictations History keeps the words of, as the stats page writes them to history.jsonl.
fn dictations(file: &Path, keep: Keep, limit: usize, now: u64) -> Vec<Value> {
  const DAY: u64 = 86_400_000;
  let since = match keep {
    Keep::Off => return Vec::new(),
    Keep::Day => now.saturating_sub(DAY),
    Keep::Week => now.saturating_sub(7 * DAY),
    Keep::Month => now.saturating_sub(30 * DAY),
    Keep::Forever => 0,
  };
  let Ok(handle) = std::fs::File::open(file) else { return Vec::new() };
  let mut newest = std::collections::VecDeque::with_capacity(limit + 1);
  for line in std::io::BufReader::new(handle).split(b'\n').map_while(Result::ok) {
    let Ok(entry) = serde_json::from_slice::<Value>(&line) else { continue };
    let (Some(at), Some(text)) = (entry["atMs"].as_u64(), entry["text"].as_str()) else { continue };
    if at < since || text.trim().is_empty() {
      continue;
    }
    newest
      .push_back(json!({ "at": iso(at), "app": entry["appName"].as_str().unwrap_or(""), "mode": entry["mode"].as_str().unwrap_or("dictate"), "text": text }));
    if newest.len() > limit {
      newest.pop_front();
    }
  }
  newest.into_iter().rev().collect()
}

// ---------- time, in the Mac's time zone ----------

fn local(secs: u64) -> crate::dictation::history::Tm {
  crate::dictation::history::local(secs as i64)
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

/// "2026-11-02T14:05:09+01:00"
fn iso(ms: u64) -> String {
  let tm = local(ms / 1000);
  let offset = tm.gmtoff / 60;
  format!(
    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
    tm.year + 1900,
    tm.mon + 1,
    tm.mday,
    tm.hour,
    tm.min,
    tm.sec,
    if offset < 0 { '-' } else { '+' },
    offset.abs() / 60,
    offset.abs() % 60
  )
}

/// The note stamp save_markdown takes: "2026-11-02 14.05".
fn stamp(secs: u64) -> String {
  let tm = local(secs);
  format!("{:04}-{:02}-{:02} {:02}.{:02}", tm.year + 1900, tm.mon + 1, tm.mday, tm.hour, tm.min)
}

// ---------- the protocol ----------

/// The last tool call, for the Agents page.
fn remember_call(tool: &str, client: &Client, ok: bool) {
  let Ok(home) = home() else { return };
  let dir = data_dir(&home);
  let call = json!({ "lastCall": { "atMs": now_ms(), "tool": tool, "client": client.name, "clientTitle": client.title, "ok": ok } });
  let _ = std::fs::create_dir_all(&dir).and_then(|_| write_atomic(&dir.join("agents.json"), &serde_json::to_vec_pretty(&call).unwrap_or_default()));
}

fn error(id: Value, code: i64, message: &str) -> Value {
  json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Who is asking, as the client's `clientInfo` says: its id, and the name it shows people when it gives one.
#[derive(Default)]
struct Client {
  name: String,
  title: Option<String>,
}

struct Session {
  client: Client,
  ready: Arc<AtomicBool>,
}

impl Session {
  /// The answer to one line from the client, or none for a notification.
  fn handle(&mut self, line: &[u8]) -> Option<Value> {
    let Ok(message) = serde_json::from_slice::<Value>(line) else { return Some(error(Value::Null, -32700, "Parse error")) };
    let Some(request) = message.as_object() else { return Some(error(Value::Null, -32600, "Invalid request: one JSON-RPC object per line")) };
    let id = request.get("id").cloned();
    let Some(method) = request.get("method").and_then(Value::as_str).filter(|_| request.get("jsonrpc") == Some(&json!("2.0"))) else {
      // A response to a request this server never sends.
      if id.is_some() && (request.contains_key("result") || request.contains_key("error")) {
        return None;
      }
      return Some(error(id.unwrap_or(Value::Null), -32600, "Invalid request"));
    };
    let Some(id) = id else {
      if method == "notifications/initialized" {
        self.ready.store(true, Ordering::SeqCst);
      }
      return None;
    };
    if !(id.is_string() || id.is_i64() || id.is_u64()) {
      return Some(error(Value::Null, -32600, "Invalid request: the id must be a string or a number"));
    }
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let answer = match method {
      "initialize" => Ok(self.initialize(&params)),
      "ping" => Ok(json!({})),
      "tools/list" => Ok(json!({ "tools": allowed(&load_settings().agents).into_iter().map(definition).collect::<Vec<_>>() })),
      "tools/call" => self.call(&params),
      _ => Err((-32601, format!("Method not found: {method}"))),
    };
    Some(match answer {
      Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
      Err((code, message)) => error(id, code, &message),
    })
  }

  fn initialize(&mut self, params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str().unwrap_or(PROTOCOL);
    let version = PROTOCOLS.iter().find(|known| **known == asked).copied().unwrap_or(PROTOCOL);
    let clean = |text: &Value| text.as_str().map(|text| text.chars().filter(|c| !c.is_control()).take(64).collect::<String>().trim().to_owned());
    self.client =
      Client { name: clean(&params["clientInfo"]["name"]).unwrap_or_default(), title: clean(&params["clientInfo"]["title"]).filter(|title| !title.is_empty()) };
    json!({
      "protocolVersion": version,
      "capabilities": { "tools": { "listChanged": true } },
      "serverInfo": { "name": NAME, "title": "TabTasker Dictate", "version": env!("CARGO_PKG_VERSION") },
      "instructions": "TabTasker Dictate keeps the person’s spoken notes, meeting transcripts and recent dictations on this Mac. Use these tools to find and read them, and to save notes when writing is on. The person chooses what agents can see and do in TabTasker Dictate, Settings, Agents: a tool that is missing is turned off there.",
    })
  }

  fn call(&self, params: &Value) -> Result<Value, (i64, String)> {
    let name = params["name"].as_str().ok_or((-32602, "Invalid params: “name” is required".to_string()))?;
    let args = match &params["arguments"] {
      Value::Null => json!({}),
      args @ Value::Object(_) => args.clone(),
      _ => return Err((-32602, "Invalid params: “arguments” must be an object".into())),
    };
    let (name, gate) = TOOLS.iter().find(|(tool, _)| *tool == name).copied().ok_or((-32602, format!("Unknown tool: {name}")))?;
    let settings = load_settings();
    let answer = if gate.open(&settings.agents) {
      run_tool(name, &args, &settings).unwrap_or_else(|problem| result(problem, true))
    } else {
      result(gate.refusal(&settings.agents).into(), true)
    };
    remember_call(name, &self.client, answer["isError"] == false);
    Ok(answer)
  }
}

fn send(output: &Mutex<impl Write>, message: &Value) -> std::io::Result<()> {
  let mut output = output.lock().unwrap_or_else(|e| e.into_inner());
  serde_json::to_writer(&mut *output, message)?;
  output.write_all(b"\n")?;
  output.flush()
}

/// Serves until the client closes `input`.
pub fn serve(mut input: impl BufRead, output: impl Write + Send + 'static) {
  let output = Arc::new(Mutex::new(output));
  let ready = Arc::new(AtomicBool::new(false));
  let mut session = Session { client: Client::default(), ready: ready.clone() };
  {
    // A change in Settings that adds or removes tools is told to the client, which then lists them again.
    let output = output.clone();
    std::thread::spawn(move || {
      let tools = || home().map(|home| allowed(&crate::settings::load_from(&data_dir(&home).join("settings.json")).agents)).unwrap_or_default();
      let mut known = tools();
      loop {
        std::thread::sleep(WATCH);
        let now = tools();
        if now == known {
          continue;
        }
        known = now;
        if ready.load(Ordering::SeqCst) && send(&output, &json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" })).is_err() {
          return;
        }
      }
    });
  }
  let mut line = Vec::new();
  loop {
    line.clear();
    match input.read_until(b'\n', &mut line) {
      Ok(0) | Err(_) => return,
      Ok(_) => {}
    }
    if line.iter().all(u8::is_ascii_whitespace) {
      continue;
    }
    if let Some(answer) = session.handle(&line) {
      if send(&output, &answer).is_err() {
        return;
      }
    }
  }
}

/// `tabtasker-dictate --mcp`.
pub fn main() {
  serve(std::io::stdin().lock(), std::io::stdout());
}

// ---------- adding the server to Claude ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Added {
  No,
  Yes,
  Elsewhere,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
  found: bool,
  added: Added,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsStatus {
  /// What an agent runs: this app's binary and `--mcp`.
  command: Vec<String>,
  claude_code: Install,
  claude_desktop: Install,
  last_call: Option<Value>,
  /// Why adding would point agents at a copy that goes away, when it would.
  problem: Option<String>,
}

fn exe() -> Result<PathBuf, String> {
  std::env::current_exe().map_err(|e| format!("Couldn’t find the app: {e}"))
}

/// macOS's struct statvfs, whose block and file counts are 32-bit.
#[repr(C)]
struct StatVfs {
  bsize: u64,
  frsize: u64,
  blocks: [u32; 3],
  files: [u32; 3],
  fsid: u64,
  flag: u64,
  namemax: u64,
}

extern "C" {
  fn statvfs(path: *const std::ffi::c_char, result: *mut StatVfs) -> i32;
  fn kill(pid: i32, signal: i32) -> i32;
}

/// Whether `path` is on a volume mounted read-only, as a disk image is. An app on any other volume,
/// such as an external drive, stays where it is.
fn read_only(path: &Path) -> bool {
  const ST_RDONLY: u64 = 1;
  let Ok(path) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else { return false };
  // SAFETY: `path` is NUL-terminated and StatVfs matches the struct statvfs only writes into.
  unsafe {
    let mut volume: StatVfs = std::mem::zeroed();
    statvfs(path.as_ptr(), &mut volume) == 0 && volume.flag & ST_RDONLY != 0
  }
}

/// A copy run from its disk image, or moved aside by Gatekeeper, is gone once that ends.
fn problem(exe: &Path) -> Option<String> {
  (exe.to_string_lossy().contains("/AppTranslocation/") || read_only(exe))
    .then(|| "Move TabTasker Dictate to Applications first, so agents can always find it.".into())
}

/// How an agent's config names this server: absent, this binary, or another copy of the app.
fn added(entry: Option<&Value>, exe: &Path) -> Added {
  match entry {
    None | Some(Value::Null) => Added::No,
    Some(entry) if entry["command"].as_str() == exe.to_str() && entry["args"] == json!(["--mcp"]) => Added::Yes,
    Some(_) => Added::Elsewhere,
  }
}

fn read_json(path: &Path) -> Option<Value> {
  std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn desktop_config(home: &Path) -> PathBuf {
  home.join("Library/Application Support/Claude/claude_desktop_config.json")
}

/// The claude CLI: the path set in Settings › Agents, then the login shell's PATH, then where its installers put it.
fn find_claude(home: &Path, configured: Option<&str>) -> Option<PathBuf> {
  if let Some(path) = configured.map(PathBuf::from).filter(|path| path.is_file()) {
    return Some(path);
  }
  let shell = std::env::var("SHELL").ok().filter(|shell| shell.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
  let which = run_for(Path::new(&shell), &["-lc", "command -v claude"], &[], Duration::from_secs(5))
    .ok()
    .and_then(|out| out.lines().map(str::trim).find(|line| line.starts_with('/')).map(PathBuf::from))
    .filter(|path| path.is_file());
  which.or_else(|| [home.join(".local/bin/claude"), "/opt/homebrew/bin/claude".into(), "/usr/local/bin/claude".into()].into_iter().find(|path| path.is_file()))
}

/// An unnamed file for a child's output. Unlike a pipe, nothing waits for whoever still holds it, such as
/// a background job a login shell started.
fn spool() -> std::io::Result<std::fs::File> {
  use std::os::unix::fs::OpenOptionsExt;
  static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
  let path = std::env::temp_dir().join(format!("tabtasker-dictate-{}-{}", std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed)));
  let file = std::fs::OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&path)?;
  std::fs::remove_file(&path)?;
  Ok(file)
}

fn spooled(mut file: std::fs::File) -> String {
  use std::io::{Seek, SeekFrom};
  let mut text = String::new();
  let _ = file.seek(SeekFrom::Start(0)).and_then(|_| file.take(1 << 20).read_to_string(&mut text));
  text
}

/// Runs `program` and gives what it printed, or a sentence from its error output when it fails. It
/// never takes longer than `limit`: the program and everything it started are stopped then.
fn run_for(program: &Path, args: &[&str], path: &[&Path], limit: Duration) -> Result<String, String> {
  use std::os::unix::process::CommandExt;
  use std::process::{Command, Stdio};
  let (out, err) = spool().and_then(|out| Ok((out, spool()?))).map_err(|e| format!("Couldn’t start {}: {e}", program.display()))?;
  let mut command = Command::new(program);
  let pipe = |file: &std::fs::File| file.try_clone().map(Stdio::from).map_err(|e| e.to_string());
  command.args(args).stdin(Stdio::null()).stdout(pipe(&out)?).stderr(pipe(&err)?).process_group(0);
  if !path.is_empty() {
    // An app started from the Dock has a bare PATH; a CLI written in Node needs its own folder on it.
    let mut dirs: Vec<PathBuf> = path.iter().map(|dir| dir.to_path_buf()).collect();
    dirs.extend(std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect::<Vec<_>>()).unwrap_or_default());
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    command.env("PATH", std::env::join_paths(dirs).map_err(|e| e.to_string())?);
  }
  let mut child = command.spawn().map_err(|e| format!("Couldn’t start {}: {e}", program.display()))?;
  let started = std::time::Instant::now();
  let status = loop {
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
      break status;
    }
    if started.elapsed() > limit {
      const SIGKILL: i32 = 9;
      // SAFETY: a plain syscall. The child leads its own process group, so this reaches only what it started.
      unsafe {
        kill(-(child.id() as i32), SIGKILL);
      }
      let _ = child.wait();
      return Err("It took too long to answer.".into());
    }
    std::thread::sleep(Duration::from_millis(50));
  };
  let (out, err) = (spooled(out), spooled(err));
  if status.success() {
    return Ok(out);
  }
  let said = err.lines().chain(out.lines()).map(str::trim).rfind(|line| !line.is_empty()).map(|line| line.chars().take(200).collect::<String>());
  Err(said.unwrap_or_else(|| format!("It stopped with code {}.", status.code().unwrap_or(-1))))
}

/// `claude mcp add` for the user, so every project has it. An entry for another copy of the app is replaced.
fn add_to_claude_code(cli: &Path, exe: &Path, now: Added) -> Result<(), String> {
  let dir = cli.parent().map(Path::to_path_buf).unwrap_or_default();
  let limit = Duration::from_secs(30);
  let failed = |e: String| format!("Claude Code couldn’t add it: {e}");
  match now {
    Added::Yes => return Ok(()),
    Added::Elsewhere => {
      run_for(cli, &["mcp", "remove", "--scope", "user", NAME], &[&dir], limit).map_err(failed)?;
    }
    Added::No => {}
  }
  let exe = exe.to_str().ok_or("Dictate is in a folder agents can’t use. Move it to Applications and try again.")?;
  run_for(cli, &["mcp", "add", "--scope", "user", NAME, "--", exe, "--mcp"], &[&dir], limit).map(|_| ()).map_err(failed)
}

/// Written beside `path` and renamed over it, so a crash leaves the old file or the new one. A symlink
/// stays a link: the file it points at is the one replaced, and it keeps its permissions, since a
/// config can hold secrets.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
  let mode = std::fs::metadata(&path).ok().map(|meta| meta.permissions());
  let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
  let temp = path.with_file_name(format!(".{name}.tabtasker-{}", std::process::id()));
  let written = std::fs::File::create(&temp)
    .and_then(|mut file| {
      if let Some(mode) = mode {
        file.set_permissions(mode)?;
      }
      file.write_all(bytes)?;
      file.sync_all()
    })
    .and_then(|_| std::fs::rename(&temp, &path));
  if written.is_err() {
    let _ = std::fs::remove_file(&temp);
  }
  written
}

/// Adds this server to Claude Desktop's `mcpServers`, keeping every other key and server. A copy of
/// the file as it was goes beside it first.
fn add_to_desktop(config: &Path, exe: &Path) -> Result<(), String> {
  let unreadable = "Claude Desktop’s settings file is damaged, so Dictate left it alone. Fix or remove it, then try again.";
  let (mut root, existed) = match std::fs::read(config) {
    Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => (json!({}), true),
    Ok(bytes) => (serde_json::from_slice::<Value>(&bytes).map_err(|_| unreadable)?, true),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (json!({}), false),
    Err(e) => return Err(format!("Couldn’t read Claude Desktop’s settings: {e}")),
  };
  let servers = root.as_object_mut().ok_or(unreadable)?.entry("mcpServers").or_insert_with(|| json!({}));
  let servers = servers.as_object_mut().ok_or("Claude Desktop’s settings aren’t laid out the way Dictate expects, so it left them alone.")?;
  if added(servers.get(NAME), exe) == Added::Yes {
    return Ok(());
  }
  // An entry of ours keeps anything added to it by hand, such as env.
  let entry = servers.entry(NAME).or_insert_with(|| json!({}));
  if !entry.is_object() {
    *entry = json!({});
  }
  entry["command"] = json!(exe);
  entry["args"] = json!(["--mcp"]);
  let dir = config.parent().ok_or("Couldn’t find Claude Desktop’s settings folder.")?;
  std::fs::create_dir_all(dir).map_err(|e| format!("Couldn’t make Claude Desktop’s settings folder: {e}"))?;
  if existed {
    let tm = local(now_ms() / 1000);
    let backup = format!("claude_desktop_config.json.backup-{:04}{:02}{:02}-{:02}{:02}{:02}", tm.year + 1900, tm.mon + 1, tm.mday, tm.hour, tm.min, tm.sec);
    std::fs::copy(config, dir.join(backup)).map_err(|e| format!("Couldn’t back up Claude Desktop’s settings, so Dictate didn’t change them: {e}"))?;
  }
  let mut json = serde_json::to_vec_pretty(&root).map_err(|e| e.to_string())?;
  json.push(b'\n');
  write_atomic(config, &json).map_err(|e| format!("Couldn’t save Claude Desktop’s settings: {e}"))
}

fn status_in(home: &Path, exe: &Path, configured: Option<&str>) -> AgentsStatus {
  let code = read_json(&home.join(".claude.json"));
  let desktop = read_json(&desktop_config(home));
  let desktop_found =
    desktop_config(home).parent().is_some_and(Path::is_dir) || Path::new("/Applications/Claude.app").is_dir() || home.join("Applications/Claude.app").is_dir();
  AgentsStatus {
    command: vec![exe.display().to_string(), "--mcp".into()],
    claude_code: Install { found: find_claude(home, configured).is_some(), added: added(code.as_ref().and_then(|code| code["mcpServers"].get(NAME)), exe) },
    claude_desktop: Install { found: desktop_found, added: added(desktop.as_ref().and_then(|desktop| desktop["mcpServers"].get(NAME)), exe) },
    last_call: read_json(&data_dir(home).join("agents.json")).map(|file| file["lastCall"].clone()).filter(|call| call.is_object()),
    problem: problem(exe),
  }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agents_status() -> Result<AgentsStatus, String> {
  blocking(|| Ok(status_in(&home()?, &exe()?, crate::settings::get().claude.claude_code.as_deref()))).await
}

/// Adds the server to `target`, `claudeCode` or `claudeDesktop`, and gives the status after.
#[tauri::command]
pub async fn agents_add(target: String) -> Result<AgentsStatus, String> {
  blocking(move || {
    let (home, exe) = (home()?, exe()?);
    if let Some(problem) = problem(&exe) {
      return Err(problem);
    }
    let configured = crate::settings::get().claude.claude_code;
    match target.as_str() {
      "claudeCode" => {
        let cli = find_claude(&home, configured.as_deref()).ok_or("Claude Code isn’t installed. If it is, set its path in Settings › Agents.")?;
        let now = added(read_json(&home.join(".claude.json")).as_ref().and_then(|code| code["mcpServers"].get(NAME)), &exe);
        add_to_claude_code(&cli, &exe, now)?;
      }
      "claudeDesktop" => add_to_desktop(&desktop_config(&home), &exe)?,
      _ => return Err("Unknown agent".into()),
    }
    Ok(status_in(&home, &exe, configured.as_deref()))
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-mcp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
  }

  fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
  }

  #[test]
  fn reads_stay_inside_the_folder() {
    let dir = temp("resolve");
    let (notes, meetings) = (dir.join("notes"), dir.join("notes/Meetings"));
    write(&notes.join("a.md"), "a");
    write(&notes.join("Projects/b.md"), "b");
    write(&notes.join(".obsidian/c.md"), "c");
    write(&notes.join("photo.png"), "p");
    write(&meetings.join("standup.md"), "m");
    write(&meetings.join("2025/old.md"), "o");
    write(&dir.join("secret.md"), "s");
    std::os::unix::fs::symlink(dir.join("secret.md"), notes.join("escape.md")).unwrap();
    std::os::unix::fs::symlink(&dir, notes.join("up")).unwrap();
    std::os::unix::fs::symlink(notes.join("a.md"), notes.join("alias.md")).unwrap();

    assert_eq!(resolve(&notes, "a.md", Some(&meetings), false).unwrap(), notes.join("a.md"));
    assert_eq!(resolve(&notes, "Projects/b.md", Some(&meetings), false).unwrap(), notes.join("Projects/b.md"));
    assert_eq!(resolve(&notes, notes.join("a.md").to_str().unwrap(), Some(&meetings), false).unwrap(), notes.join("a.md"));
    assert_eq!(resolve(&notes, "alias.md", Some(&meetings), false).unwrap(), notes.join("a.md")); // a symlink that stays inside
    for escape in ["../secret.md", "Projects/../../secret.md", "escape.md", "up/secret.md", "/etc/hosts", "", "..", ".", "./", "a.md\0"] {
      assert!(resolve(&notes, escape, Some(&meetings), false).is_err(), "{escape:?} got through");
    }
    assert!(resolve(&notes, dir.join("secret.md").to_str().unwrap(), None, false).is_err());
    assert!(resolve(&notes, ".obsidian/c.md", None, false).is_err());
    assert!(resolve(&notes, "photo.png", None, false).is_err());
    assert!(resolve(&notes, "Projects", None, false).is_err());
    assert!(resolve(&notes, "Meetings/standup.md", Some(&meetings), false).unwrap_err().contains("meeting"));
    assert_eq!(resolve(&meetings, "standup.md", None, true).unwrap(), meetings.join("standup.md"));
    assert!(resolve(&meetings, "2025/old.md", None, true).is_err());
    assert!(resolve(&meetings, "../a.md", None, true).is_err());
    assert!(resolve(&dir.join("missing"), "a.md", None, false).is_err());
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn listing_skips_hidden_files_symlinks_and_meetings() {
    let dir = temp("list");
    let notes = dir.join("notes");
    write(&notes.join("old.md"), "old");
    std::fs::File::options().write(true).open(notes.join("old.md")).unwrap().set_modified(SystemTime::now() - Duration::from_secs(60)).unwrap();
    write(&notes.join("Projects/new.MD"), "new");
    write(&notes.join(".trash/gone.md"), "x");
    write(&notes.join("Meetings/standup.md"), "m");
    write(&notes.join("photo.png"), "p");
    std::os::unix::fs::symlink(notes.join("old.md"), notes.join("link.md")).unwrap();
    std::os::unix::fs::symlink(&dir, notes.join("loop")).unwrap();
    let paths: Vec<String> = list(&notes, Some(&notes.join("Meetings")), true).unwrap().into_iter().map(|file| file.path).collect();
    assert_eq!(paths, ["Projects/new.MD", "old.md"]);
    let flat: Vec<String> = list(&notes, None, false).unwrap().into_iter().map(|file| file.path).collect();
    assert_eq!(flat, ["old.md"]);
    assert!(list(&dir.join("missing"), None, true).unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_folder_macos_refuses_is_never_an_empty_one() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp("denied");
    let notes = dir.join("notes");
    write(&notes.join("a.md"), "a");
    std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o000)).unwrap();
    let listed = list(&notes, None, true);
    let read = resolve(&notes, "a.md", None, false);
    let searched = search(&notes, None, &["a".into()], 5);
    std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(listed.unwrap_err(), DENIED);
    assert_eq!(read.unwrap_err(), DENIED);
    assert_eq!(searched.unwrap_err(), DENIED);
    assert_eq!(resolve(&dir.join("missing"), "a.md", None, false).unwrap_err(), "There are none yet: the folder doesn’t exist.");
    assert_eq!(resolve(&notes, "b.md", None, false).unwrap_err(), "There is nothing at “b.md”.");
    assert_eq!(resolve(&notes, "a.md/b.md", None, false).unwrap_err(), "There is nothing at “a.md/b.md”.");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn one_folder_for_notes_and_meetings_is_shared_only_with_both() {
    let both = Agents::default();
    let no_meetings = Agents { share_meetings: false, ..Agents::default() };
    let no_notes = Agents { share_notes: false, ..Agents::default() };
    for tool in ["list_notes", "read_note", "search_notes", "append_to_note", "list_meetings", "read_meeting", "create_note", "recent_dictations"] {
      assert!(one_folder(tool, &both).is_ok(), "{tool}");
    }
    for tool in ["list_notes", "read_note", "search_notes", "append_to_note"] {
      assert!(one_folder(tool, &no_meetings).unwrap_err().contains("turn on Meetings"), "{tool}");
      assert!(one_folder(tool, &no_notes).is_ok(), "{tool}");
    }
    for tool in ["list_meetings", "read_meeting"] {
      assert!(one_folder(tool, &no_notes).unwrap_err().contains("turn on Notes"), "{tool}");
      assert!(one_folder(tool, &no_meetings).is_ok(), "{tool}");
    }
    assert!(one_folder("create_note", &no_meetings).is_ok());
  }

  #[test]
  fn search_needs_every_word_and_shows_the_lines() {
    let dir = temp("search");
    write(&dir.join("Venue.md"), "# Venue\n\nCall the venue about Thursday.\nBook the band.\n");
    write(&dir.join("Other.md"), "Thursday lunch");
    let found = search(&dir, None, &["venue".into(), "thursday".into()], 10).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["path"], "Venue.md");
    assert_eq!(found[0]["matches"][0], json!({ "line": 1, "text": "# Venue" }));
    assert_eq!(found[0]["matches"][1], json!({ "line": 3, "text": "Call the venue about Thursday." }));
    assert_eq!(search(&dir, None, &["thursday".into()], 1).unwrap().len(), 1);
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn appending_keeps_what_is_there() {
    let dir = temp("append");
    write(&dir.join("a.md"), "# Plan\n\nOne");
    append(&dir.join("a.md"), "Two\n\n").unwrap();
    append(&dir.join("a.md"), "Three").unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "# Plan\n\nOne\n\nTwo\n\nThree\n");
    write(&dir.join("empty.md"), "");
    append(&dir.join("empty.md"), "First").unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("empty.md")).unwrap(), "First\n");
    std::fs::write(dir.join("outside.md"), "x").unwrap();
    std::os::unix::fs::symlink(dir.join("outside.md"), dir.join("link.md")).unwrap();
    assert!(append(&dir.join("link.md"), "no").is_err());
    assert_eq!(std::fs::read_to_string(dir.join("outside.md")).unwrap(), "x");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn dictations_are_the_newest_history_still_keeps() {
    let dir = temp("history");
    let now = 100 * 86_400_000;
    let line = |at: u64, text: &str| {
      json!({ "atMs": at, "mode": "dictate", "bundleId": "com.apple.mail", "appName": "Mail", "words": 2, "seconds": 1.0, "text": text }).to_string()
    };
    let file = dir.join("history.jsonl");
    std::fs::write(
      &file,
      [line(now - 8 * 86_400_000, "last week"), "{broken".into(), line(now - 1000, "older"), line(now - 10, ""), line(now - 5, "newest")].join("\n"),
    )
    .unwrap();
    let texts = |keep, limit| dictations(&file, keep, limit, now).iter().map(|entry| entry["text"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(texts(Keep::Week, 10), ["newest", "older"]);
    assert_eq!(texts(Keep::Forever, 10), ["newest", "older", "last week"]);
    assert_eq!(texts(Keep::Forever, 1), ["newest"]);
    assert!(texts(Keep::Off, 10).is_empty());
    assert_eq!(dictations(&file, Keep::Day, 1, now)[0]["app"], "Mail");
    assert!(dictations(&dir.join("missing"), Keep::Week, 5, now).is_empty());
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn claude_desktop_keeps_every_other_server_and_key() {
    let dir = temp("desktop");
    let config = dir.join("Claude/claude_desktop_config.json");
    let exe = Path::new("/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate");

    add_to_desktop(&config, exe).unwrap(); // no file yet: made, with no backup
    assert_eq!(read_json(&config).unwrap(), json!({ "mcpServers": { NAME: { "command": exe, "args": ["--mcp"] } } }));
    assert_eq!(std::fs::read_dir(dir.join("Claude")).unwrap().count(), 1);

    let theirs = json!({ "globalShortcut": "Alt+Space", "mcpServers": { "files": { "command": "npx", "args": ["files"] }, NAME: { "command": "/old/copy", "args": ["--mcp"], "env": { "A": "1" } } } });
    std::fs::write(&config, serde_json::to_vec(&theirs).unwrap()).unwrap();
    assert_eq!(added(read_json(&config).unwrap()["mcpServers"].get(NAME), exe), Added::Elsewhere);
    add_to_desktop(&config, exe).unwrap();
    let now = read_json(&config).unwrap();
    assert_eq!(now["globalShortcut"], "Alt+Space");
    assert_eq!(now["mcpServers"]["files"], theirs["mcpServers"]["files"]);
    assert_eq!(now["mcpServers"][NAME], json!({ "command": exe, "args": ["--mcp"], "env": { "A": "1" } }));
    let backups: Vec<_> =
      std::fs::read_dir(dir.join("Claude")).unwrap().flatten().filter(|entry| entry.file_name().to_string_lossy().contains(".backup-")).collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(read_json(&backups[0].path()).unwrap(), theirs);

    let before = std::fs::read(&config).unwrap();
    add_to_desktop(&config, exe).unwrap(); // already there: nothing written, no second backup
    assert_eq!(std::fs::read(&config).unwrap(), before);
    assert_eq!(std::fs::read_dir(dir.join("Claude")).unwrap().count(), 2);

    for broken in ["{ not json", "[1, 2]", r#"{ "mcpServers": [] }"#] {
      std::fs::write(&config, broken).unwrap();
      assert!(add_to_desktop(&config, exe).is_err(), "{broken}");
      assert_eq!(std::fs::read_to_string(&config).unwrap(), broken);
    }
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_linked_claude_desktop_config_stays_linked_and_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp("desktop-link");
    let (real, config) = (dir.join("dotfiles/claude_desktop_config.json"), dir.join("Claude/claude_desktop_config.json"));
    write(&real, r#"{ "mcpServers": {} }"#);
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &config).unwrap();
    add_to_desktop(&config, Path::new("/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate")).unwrap();
    assert!(config.symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(
      added(read_json(&real).unwrap()["mcpServers"].get(NAME), Path::new("/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate")),
      Added::Yes
    );
    assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_dir(dir.join("dotfiles")).unwrap().count(), 1, "no temp file left behind");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_program_is_never_waited_on_past_its_limit() {
    // A background job holding the output open, as a login profile can start, doesn't hold up the answer.
    let started = std::time::Instant::now();
    assert_eq!(run_for(Path::new("/bin/sh"), &["-c", "sleep 3 & echo /usr/bin/true"], &[], Duration::from_secs(2)).unwrap(), "/usr/bin/true\n");
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());

    // Past the limit, the program and what it started are stopped.
    let dir = temp("run");
    let pid = dir.join("pid");
    let script = format!("sleep 30 & echo $! > '{}'; sleep 30", pid.display());
    let started = std::time::Instant::now();
    assert_eq!(run_for(Path::new("/bin/sh"), &["-c", &script], &[], Duration::from_millis(500)).unwrap_err(), "It took too long to answer.");
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    let job: i32 = std::fs::read_to_string(&pid).unwrap().trim().parse().unwrap();
    // SAFETY: signal 0 only asks whether the process is there.
    let alive = || unsafe { kill(job, 0) == 0 };
    let gone = std::time::Instant::now();
    while alive() && gone.elapsed() < Duration::from_secs(2) {
      std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(), "the background job outlived the limit");

    assert_eq!(run_for(Path::new("/bin/sh"), &["-c", "echo nope >&2; exit 3"], &[], Duration::from_secs(5)).unwrap_err(), "nope");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn claude_code_is_told_once_and_an_old_entry_is_replaced() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp("cli");
    let log = dir.join("calls.txt");
    let cli = dir.join("claude");
    // A stand-in for the claude CLI: it notes its arguments, and fails when told to.
    std::fs::write(
      &cli,
      format!(
        "#!/bin/sh\nprintf '%s|' \"$@\" >> '{}'\necho >> '{}'\n[ -e '{}' ] && echo 'MCP server tabtasker-dictate already exists' >&2 && exit 1\nexit 0\n",
        log.display(),
        log.display(),
        dir.join("fail").display()
      ),
    )
    .unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    let exe = Path::new("/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate");

    add_to_claude_code(&cli, exe, Added::No).unwrap();
    add_to_claude_code(&cli, exe, Added::Yes).unwrap();
    add_to_claude_code(&cli, exe, Added::Elsewhere).unwrap();
    assert_eq!(std::fs::read_to_string(&log).unwrap(), format!(
      "mcp|add|--scope|user|tabtasker-dictate|--|{0}|--mcp|\nmcp|remove|--scope|user|tabtasker-dictate|\nmcp|add|--scope|user|tabtasker-dictate|--|{0}|--mcp|\n", exe.display()));

    std::fs::write(dir.join("fail"), "").unwrap();
    assert_eq!(add_to_claude_code(&cli, exe, Added::No).unwrap_err(), "Claude Code couldn’t add it: MCP server tabtasker-dictate already exists");
    assert_eq!(find_claude(&dir, Some(cli.to_str().unwrap())), Some(cli.clone()));
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn status_reads_both_configs_and_the_last_call() {
    let home = temp("status");
    let exe = Path::new("/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate");
    write(&home.join(".claude.json"), &json!({ "mcpServers": { NAME: { "type": "stdio", "command": exe, "args": ["--mcp"], "env": {} } } }).to_string());
    write(&desktop_config(&home), &json!({ "mcpServers": { NAME: { "command": "/Volumes/TabTasker Dictate/x", "args": ["--mcp"] } } }).to_string());
    write(&data_dir(&home).join("agents.json"), r#"{ "lastCall": { "atMs": 5, "tool": "read_note", "client": "claude-code", "ok": true } }"#);
    let status = status_in(&home, exe, None);
    assert_eq!(status.claude_code.added, Added::Yes);
    assert_eq!(status.claude_desktop.added, Added::Elsewhere);
    assert!(status.claude_desktop.found);
    assert_eq!(status.last_call.unwrap()["tool"], "read_note");
    assert_eq!(status.command, [exe.to_str().unwrap(), "--mcp"]);
    assert!(status.problem.is_none());
    // A read-only volume, as a disk image is mounted; the system volume is one too.
    assert!(problem(Path::new("/usr/bin/true")).is_some());
    assert!(problem(Path::new("/Volumes/External/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate")).is_none());
    assert!(problem(&home).is_none());
    assert!(problem(Path::new("/private/var/folders/x/AppTranslocation/y/d/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate")).is_some());
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn stamps_are_local_time() {
    assert!(stamp(0).len() == 16 && stamp(0).as_bytes()[10] == b' ' && stamp(0).as_bytes()[13] == b'.');
    let iso = iso(1_700_000_000_000);
    assert_eq!(iso.len(), 25);
    assert!(iso.starts_with("2023-11-1"));
  }
}
