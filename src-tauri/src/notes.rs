//! Notes and meetings as Markdown files in a folder the person picks: one file each, or one a day.
use crate::settings::{self, Notes};
use std::ffi::{c_char, c_void, CStr, CString};
use std::io::Write;
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Note, Meeting }

/// A saved note, newest first in `recent`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef { pub path: PathBuf, pub title: String, pub modified_ms: u64 }

fn documents() -> Result<PathBuf, String> {
  let home = std::env::var_os("HOME").ok_or("Couldn’t find your home folder.")?;
  Ok(PathBuf::from(home).join("Documents").join("TabTasker Dictate"))
}

/// The notes folder: the one in Settings, or Documents/TabTasker Dictate.
pub fn notes_dir() -> Result<PathBuf, String> {
  settings::get().notes.folder.map_or_else(documents, |folder| Ok(PathBuf::from(folder)))
}

/// The meetings folder: the one in Settings, or Meetings inside the notes folder.
pub fn meetings_dir() -> Result<PathBuf, String> {
  settings::get().meetings.folder.map_or_else(|| Ok(notes_dir()?.join("Meetings")), |folder| Ok(PathBuf::from(folder)))
}

/// The Obsidian vault `dir` is in: the nearest folder, `dir` included, that holds a `.obsidian` folder.
/// Resolved first, so a link into a vault counts as the vault.
pub(crate) fn vault_of(dir: &Path) -> Option<PathBuf> {
  let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
  dir.ancestors().find(|folder| folder.join(".obsidian").is_dir()).map(Path::to_path_buf)
}

// ---------- names and contents ----------

/// When a note is made, from the page's local "YYYY-MM-DD HH.mm".
#[derive(Clone, Copy, Debug)]
pub(crate) struct Stamp<'a> { date: &'a str, hour: &'a str, minute: &'a str }

pub(crate) fn stamp(text: &str) -> Result<Stamp<'_>, String> {
  let bytes = text.as_bytes();
  let digits = |from: usize, to: usize| bytes[from..to].iter().all(u8::is_ascii_digit);
  let shaped = bytes.len() == 16 && bytes[4] == b'-' && bytes[7] == b'-' && bytes[10] == b' ' && bytes[13] == b'.'
    && digits(0, 4) && digits(5, 7) && digits(8, 10) && digits(11, 13) && digits(14, 16);
  if !shaped { return Err("Invalid date".into()); }
  Ok(Stamp { date: &text[..10], hour: &text[11..13], minute: &text[14..16] })
}

/// One line of what a Mac allows in a file name: no slash, colon or control character, no leading dot,
/// single spaces.
fn clean(text: &str) -> String {
  let text: String = text.chars().map(|c| if c == '/' || c == ':' || c.is_control() { ' ' } else { c }).collect();
  text.split_whitespace().collect::<Vec<_>>().join(" ").trim_start_matches(['.', ' ']).to_owned()
}

/// At most `bytes` of `text`, cut between letters.
fn cut(text: &str, bytes: usize) -> &str {
  let mut end = bytes.min(text.len());
  while !text.is_char_boundary(end) { end -= 1; }
  text[..end].trim_end()
}

/// The file name, without ".md", that `template` makes for a note called `title`. The title goes in last,
/// so braces in it are never read as tokens.
pub(crate) fn file_stem(template: &str, title: &str, at: Stamp) -> String {
  let title = clean(title);
  let title = match cut(&title, 120) { "" => "Note", title => title };
  let name = template.replace("{date}", at.date).replace("{time}", &format!("{}.{}", at.hour, at.minute)).replace("{title}", title);
  // APFS allows 255 bytes; the rest is room for " 99.md".
  match cut(&clean(&name), 200) { "" => "Note".into(), name => name.into() }
}

/// A YAML value as is when it can only read as text, otherwise quoted.
fn scalar(value: &str) -> String {
  let plain = value.chars().next().is_some_and(char::is_alphabetic)
    && value.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/'))
    && !["true", "false", "yes", "no", "on", "off", "null", "y", "n"].contains(&value.to_lowercase().as_str());
  if plain { value.into() } else { serde_json::Value::from(value).to_string() }
}

/// A tag as Obsidian reads one: no leading #, words joined by hyphens.
pub(crate) fn tag(text: &str) -> String { text.trim().trim_start_matches('#').split_whitespace().collect::<Vec<_>>().join("-") }

pub(crate) fn front_matter(at: Stamp, tags: &[String], extra: &[(String, String)]) -> String {
  let mut text = format!("---\ncreated: {}T{}:{}\n", at.date, at.hour, at.minute);
  let tags: Vec<String> = tags.iter().map(|one| tag(one)).filter(|one| !one.is_empty()).collect();
  if tags.is_empty() { text.push_str("tags: []\n"); }
  else { text.push_str("tags:\n"); for one in &tags { text.push_str(&format!("  - {}\n", scalar(one))); } }
  text.push_str("source: TabTasker Dictate\n");
  for (key, value) in extra {
    let usable = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') && !["created", "tags", "source"].contains(&key.as_str());
    if usable { text.push_str(&format!("{key}: {}\n", scalar(&value.split_whitespace().collect::<Vec<_>>().join(" ")))); }
  }
  text.push_str("---\n\n");
  text
}

/// What a note becomes before anything touches the disk: its file's name, what a new file starts with,
/// and the note itself. A daily note's file is named for the day and gets the note as a section.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Composed { pub stem: String, pub daily: bool, pub header: String, pub section: String }

pub(crate) fn compose(notes: &Notes, kind: Kind, title: &str, body: &str, actions: Option<&str>, at: Stamp, extra: &[(String, String)]) -> Composed {
  let daily = kind == Kind::Note && notes.daily_note;
  let header = if notes.frontmatter { front_matter(at, &notes.tags, extra) } else { String::new() };
  let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
  let actions = actions.map(str::trim).filter(|items| !items.is_empty());
  let (heading, below) = if daily {
    (format!("## {}:{}{}{title}\n\n", at.hour, at.minute, if title.is_empty() { "" } else { " " }), "###")
  } else {
    (if title.is_empty() { String::new() } else { format!("# {title}\n\n") }, "##")
  };
  let mut section = format!("{heading}{}\n", body.trim());
  if let Some(items) = actions { section.push_str(&format!("\n{below} Action items\n\n{items}\n")); }
  let stem = if daily { at.date.to_owned() } else { file_stem(&notes.file_name, &title, at) };
  Composed { stem, daily, header, section }
}

// ---------- writing ----------

/// macOS's O_NOFOLLOW: opening a link fails instead of opening what it points at.
const O_NOFOLLOW: i32 = 0x100;
const ELOOP: i32 = 62;

/// `{stem}.md`, then `{stem} 2.md` and on.
fn candidate(dir: &Path, stem: &str, n: usize) -> PathBuf {
  if n < 2 { dir.join(format!("{stem}.md")) } else { dir.join(format!("{stem} {n}.md")) }
}

/// Creates a new file for `bytes`, never opening one that exists: a name that is taken, even by a dangling
/// link (writing to its name would create the file it points at), moves on to the next.
fn write_new(dir: &Path, stem: &str, bytes: &[u8]) -> Result<PathBuf, String> {
  for n in 1..=100 {
    let path = candidate(dir, stem, n);
    if path.symlink_metadata().is_ok() { continue; }
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(mut file) => {
        return match file.write_all(bytes).and_then(|_| file.sync_all()) {
          Ok(()) => Ok(path),
          Err(e) => { let _ = std::fs::remove_file(&path); Err(format!("Couldn’t save the note: {e}")) }
        };
      }
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(e) => return Err(format!("Couldn’t save the note: {e}")),
    }
  }
  Err("Couldn’t find a free name for the note. Try another title.".into())
}

/// Adds the note to the day's file: the first of `{date}.md`, `{date} 2.md`… that is missing or a plain
/// file, so a link or a folder by that name is never written through. A new file starts with `header`.
fn append_daily(dir: &Path, note: &Composed) -> Result<PathBuf, String> {
  for n in 1..=100 {
    let path = candidate(dir, &note.stem, n);
    if path.symlink_metadata().is_ok_and(|meta| !meta.file_type().is_file()) { continue; }
    let file = std::fs::OpenOptions::new().read(true).append(true).create(true).custom_flags(O_NOFOLLOW).open(&path);
    let mut file = match file {
      Ok(file) => file,
      Err(e) if e.raw_os_error() == Some(ELOOP) => continue, // it became a link since
      Err(e) => return Err(format!("Couldn’t save the note: {e}")),
    };
    let len = file.metadata().map_err(|e| format!("Couldn’t save the note: {e}"))?.len();
    let mut text = String::new();
    if len == 0 { text.push_str(&note.header); } else {
      // One blank line between what is there and the new section.
      let mut tail = [0u8; 2];
      let read = if len >= 2 { file.read_at(&mut tail, len - 2).unwrap_or(0) } else { file.read_at(&mut tail[1..], 0).map_or(0, |_| 1) };
      text.push_str(match &tail[2 - read.min(2)..] { [.., b'\n', b'\n'] => "", [.., b'\n'] => "\n", _ => "\n\n" });
    }
    text.push_str(&note.section);
    file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| format!("Couldn’t save the note: {e}"))?;
    return Ok(path);
  }
  Err("Couldn’t find a free name for the note. Try another title.".into())
}

fn save(kind: Kind, title: &str, body: &str, actions: Option<&str>, stamp_text: &str, extra: &[(String, String)]) -> Result<PathBuf, String> {
  if body.trim().is_empty() { return Err("There’s nothing to save.".into()); }
  if body.chars().count() > 1_000_000 { return Err("This note is too long to save. Try splitting it in two.".into()); }
  let at = stamp(stamp_text)?;
  let dir = match kind { Kind::Note => notes_dir()?, Kind::Meeting => meetings_dir()? };
  std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t make the notes folder: {e}"))?;
  let note = compose(&settings::get().notes, kind, title, body, actions, at, extra);
  if note.daily { append_daily(&dir, &note) } else { write_new(&dir, &note.stem, format!("{}{}", note.header, note.section).as_bytes()) }
}

/// Saves `body` under `title` in the folder for `kind`: a new file named by the notes template, or for a
/// daily note a section in the day's file. `stamp` is the local time as "YYYY-MM-DD HH.mm";
/// `extra_front_matter` holds keys a caller adds to the front matter.
pub fn save_markdown(kind: Kind, title: &str, body: &str, stamp: &str, extra_front_matter: &[(String, String)]) -> Result<PathBuf, String> {
  save(kind, title, body, None, stamp, extra_front_matter)
}

// ---------- recent notes ----------

/// The `n` notes changed last in the notes folder.
pub fn recent(n: usize) -> Vec<NoteRef> {
  let Ok(dir) = notes_dir() else { return Vec::new() };
  recent_in(&dir, n)
}

fn recent_in(dir: &Path, n: usize) -> Vec<NoteRef> {
  let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
  let mut notes: Vec<NoteRef> = entries.filter_map(|entry| {
    let entry = entry.ok()?;
    let path = entry.path();
    if path.extension()? != "md" || entry.file_name().as_encoded_bytes().starts_with(b".") || !entry.file_type().ok()?.is_file() { return None; }
    let modified = entry.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(NoteRef { title: path.file_stem()?.to_string_lossy().into_owned(), path, modified_ms: modified })
  }).collect();
  notes.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.title.cmp(&b.title)));
  notes.truncate(n);
  notes
}

// ---------- the Library: every note and meeting, as the page lists them ----------

/// One file the Library shows: where it is, what it is called, when it last changed, and a taste of it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem { pub path: String, pub title: String, pub kind: &'static str, pub modified_ms: u64, pub words: usize, pub excerpt: String, pub archived: bool }

/// The folder archived notes and meetings move to, inside their own folder: still plain files, out of the list.
const ARCHIVE: &str = "Archive";

/// The text after any front matter.
fn past_front_matter(text: &str) -> &str {
  let Some(rest) = text.strip_prefix("---\n") else { return text };
  rest.find("\n---\n").map_or(text, |end| &rest[end + 5..])
}

/// A file's title: `title:` in its front matter, else its first heading, else its name.
pub(crate) fn title_of(text: &str, stem: &str) -> String {
  let front = text.strip_prefix("---\n").and_then(|rest| rest.find("\n---\n").map(|end| &rest[..end]));
  let in_front = front.and_then(|front| front.lines().find_map(|line| line.strip_prefix("title:")))
    .map(|title| title.trim().trim_matches(['"', '\'']).trim().to_owned()).filter(|title| !title.is_empty());
  let heading = past_front_matter(text).lines().map(str::trim).find(|line| line.starts_with('#'))
    .map(|line| line.trim_start_matches('#').trim().to_owned()).filter(|title| !title.is_empty());
  in_front.or(heading).unwrap_or_else(|| stem.to_owned())
}

/// The words of the body: front matter, headings and list marks left out.
fn body_words(text: &str) -> impl Iterator<Item = &str> {
  past_front_matter(text).lines().map(str::trim)
    .filter(|line| !line.is_empty() && !line.starts_with('#'))
    .flat_map(|line| line.trim_start_matches(['-', '*', '>', ' ']).trim_start_matches("[ ]").trim_start_matches("[x]").split_whitespace())
}

/// The first words of the body, to about 160 characters.
pub(crate) fn excerpt_of(text: &str) -> String {
  let mut out = String::new();
  for word in body_words(text) {
    if out.chars().count() + word.chars().count() > 160 { out.push('…'); break; }
    if !out.is_empty() { out.push(' '); }
    out.push_str(word);
  }
  out
}

fn library_in(dir: &Path, kind: &'static str, archived: bool, out: &mut Vec<LibraryItem>) {
  let Ok(entries) = std::fs::read_dir(dir) else { return };
  for entry in entries.flatten() {
    let path = entry.path();
    let Some(stem) = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()) else { continue };
    if path.extension().is_none_or(|ext| ext != "md") || stem.starts_with('.') || !entry.file_type().is_ok_and(|kind| kind.is_file()) { continue; }
    let Ok(meta) = entry.metadata() else { continue };
    if meta.len() > 8 << 20 { continue; } // not a note
    let modified = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0, |age| age.as_millis() as u64);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    out.push(LibraryItem { path: path.display().to_string(), title: title_of(&text, &stem), kind, modified_ms: modified, words: body_words(&text).count(), excerpt: excerpt_of(&text), archived });
  }
}

/// Every note and meeting file, newest first, the archived ones marked. Meetings saved inside the notes folder
/// (the default, `Meetings/`) are found once, as meetings: each folder, and its `Archive/`, is read at its top
/// level only.
pub fn library() -> Vec<LibraryItem> {
  let mut items = Vec::new();
  if let Ok(dir) = notes_dir() { library_in(&dir, "note", false, &mut items); library_in(&dir.join(ARCHIVE), "note", true, &mut items); }
  if let Ok(dir) = meetings_dir() { library_in(&dir, "meeting", false, &mut items); library_in(&dir.join(ARCHIVE), "meeting", true, &mut items); }
  items.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.title.cmp(&b.title)));
  items
}

/// `path` as a Markdown file inside the notes or meetings folder, resolved first so `..` or a link can't
/// reach outside them.
pub(crate) fn in_library(path: &str) -> Result<PathBuf, String> {
  let file = PathBuf::from(path).canonicalize().map_err(|_| "That file isn’t there any more.".to_owned())?;
  let folders = [notes_dir(), meetings_dir()].into_iter().flatten().filter_map(|dir| dir.canonicalize().ok());
  let inside = folders.into_iter().any(|dir| file.starts_with(dir));
  if !inside || file.extension().is_none_or(|ext| ext != "md") || !file.is_file() { return Err("Only a saved note or meeting can be opened here.".into()); }
  Ok(file)
}

#[tauri::command]
pub async fn library_list() -> Result<Vec<LibraryItem>, String> {
  tauri::async_runtime::spawn_blocking(library).await.map_err(|e| e.to_string())
}

/// Opens a note or meeting in whatever app the Mac opens Markdown with.
#[tauri::command]
pub fn library_open(path: String) -> Result<(), String> {
  let file = in_library(&path)?;
  std::process::Command::new("/usr/bin/open").arg(file).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------- the editor ----------

/// A note or meeting as the editor holds it: the title apart from the body, which is the file's Markdown
/// without its front matter or its heading.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDoc { pub path: String, pub title: String, pub body: String, pub kind: &'static str, pub modified_ms: u64 }

/// The front matter block, delimiters included, and what follows it.
fn split_front(text: &str) -> (&str, &str) {
  let Some(rest) = text.strip_prefix("---\n") else { return ("", text) };
  match rest.find("\n---\n") { Some(end) => (&text[..4 + end + 5], &rest[end + 5..]), None => ("", text) }
}

/// A leading `# Title` line, and the body after it.
fn split_heading(rest: &str) -> (Option<&str>, &str) {
  let rest = rest.trim_start_matches('\n');
  let first = rest.lines().next().unwrap_or("");
  match first.strip_prefix("# ") {
    Some(heading) if !heading.trim().is_empty() => (Some(heading.trim()), rest[first.len()..].trim_start_matches('\n')),
    _ => (None, rest),
  }
}

/// The front matter with its `title:` line following `title`: changed, or dropped when the title is gone.
fn retitled(front: &str, title: &str) -> String {
  if front.is_empty() || !front.lines().any(|line| line.starts_with("title:")) { return front.to_owned(); }
  let mut out = String::new();
  for line in front.split_inclusive('\n') {
    if line.starts_with("title:") { if !title.is_empty() { out.push_str(&format!("title: {}\n", scalar(title))); } } else { out.push_str(line); }
  }
  out
}

/// Whether `file` is in the meetings folder.
fn kind_of(file: &Path) -> &'static str {
  let in_meetings = meetings_dir().ok().and_then(|dir| dir.canonicalize().ok()).is_some_and(|dir| file.starts_with(dir));
  if in_meetings { "meeting" } else { "note" }
}

fn modified_ms(path: &Path) -> u64 {
  std::fs::metadata(path).ok().and_then(|meta| meta.modified().ok()).and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0, |age| age.as_millis() as u64)
}

/// The note at `path`, for the editor.
pub(crate) fn read_doc(path: &str) -> Result<NoteDoc, String> {
  let file = in_library(path)?;
  let text = std::fs::read_to_string(&file).map_err(|_| "That file isn’t there any more.".to_owned())?;
  let stem = file.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
  let (_, rest) = split_front(&text);
  let (heading, body) = split_heading(rest);
  let title = heading.map_or_else(|| title_of(&text, &stem), str::to_owned);
  Ok(NoteDoc { path: file.display().to_string(), title, body: body.trim_end().to_owned(), kind: kind_of(&file), modified_ms: modified_ms(&file) })
}

/// Writes the note back: its front matter as it was (`title:` kept in step), `# title`, then the body.
/// Written beside the file and moved into place, so a crash leaves the old note, never half a new one.
pub(crate) fn write_doc(path: &str, title: &str, body: &str) -> Result<u64, String> {
  let file = in_library(path)?;
  if body.chars().count() > 1_000_000 { return Err("This note is too long to save. Try splitting it in two.".into()); }
  let current = std::fs::read_to_string(&file).map_err(|_| "That file isn’t there any more.".to_owned())?;
  let (front, _) = split_front(&current);
  let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
  let mut text = retitled(front, &title);
  if !text.is_empty() { text.push('\n'); }
  if !title.is_empty() { text.push_str(&format!("# {title}\n\n")); }
  text.push_str(body.trim_end());
  text.push('\n');
  let dir = file.parent().ok_or("That file isn’t there any more.")?;
  let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
  let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
  let written = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)
    .and_then(|mut out| out.write_all(text.as_bytes()).and_then(|_| out.sync_all()))
    .and_then(|_| std::fs::rename(&temp, &file));
  if let Err(e) = written { let _ = std::fs::remove_file(&temp); return Err(format!("Couldn’t save the note: {e}")); }
  Ok(modified_ms(&file))
}

/// A new note file for the editor, with whatever words there are so far (none is fine): named by the
/// notes template, or a section in the day's note.
pub(crate) fn new_doc(title: &str, body: &str, stamp_text: &str) -> Result<PathBuf, String> {
  if body.chars().count() > 1_000_000 { return Err("This note is too long to save. Try splitting it in two.".into()); }
  let at = stamp(stamp_text)?;
  let dir = notes_dir()?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t make the notes folder: {e}"))?;
  let note = compose(&settings::get().notes, Kind::Note, title, body, None, at, &[]);
  if note.daily { append_daily(&dir, &note) } else { write_new(&dir, &note.stem, format!("{}{}", note.header, note.section).as_bytes()) }
}

/// Keeps a picture pasted or dropped into a note beside it, in `attachments/<the note's name>/`, and
/// answers the path the note refers to it by (relative, so the folder can move). `data` is the file's
/// bytes in base64; `name` a suggested file name (its extension is kept, the rest made safe).
#[tauri::command]
pub fn note_attach(path: String, name: String, data: String) -> Result<String, String> {
  use base64::Engine;
  let file = in_library(&path)?;
  let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "That picture couldn’t be read.".to_owned())?;
  if bytes.is_empty() { return Err("That picture is empty.".into()); }
  if bytes.len() > 25 << 20 { return Err("That picture is too big. A note can hold pictures up to 25 MB.".into()); }
  let dir = file.parent().ok_or("That file isn’t there any more.")?;
  let stem = file.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| "note".into());
  let folder = dir.join("attachments").join(clean(&stem));
  std::fs::create_dir_all(&folder).map_err(|e| format!("Couldn’t make a folder for the note’s pictures: {e}"))?;
  let suggested = Path::new(&name);
  let ext = suggested.extension().map(|ext| ext.to_string_lossy().to_lowercase()).filter(|ext| ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "pdf"].contains(&ext.as_str())).unwrap_or_else(|| "png".into());
  let base = clean(&suggested.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default());
  let base = if base.is_empty() { "picture".to_owned() } else { base };
  for n in 1..=1000 {
    let file_name = if n == 1 { format!("{base}.{ext}") } else { format!("{base} {n}.{ext}") };
    let target = folder.join(&file_name);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
      Ok(mut out) => {
        out.write_all(&bytes).and_then(|_| out.sync_all()).map_err(|e| format!("Couldn’t save the picture: {e}"))?;
        return Ok(format!("attachments/{}/{}", clean(&stem), file_name));
      }
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(e) => return Err(format!("Couldn’t save the picture: {e}")),
    }
  }
  Err("Couldn’t find a free name for the picture.".into())
}

/// `file` into the `Archive/` folder beside it, or back out to its folder, with its pictures (they live in
/// `attachments/<name>/` next to it and are linked by that relative path, so they move with it and keep their
/// folder name). Refused, with nothing moved, when the other side already has a file or a pictures folder of
/// that name. The file where it is now.
fn archive_move(file: &Path, archived: bool) -> Result<PathBuf, String> {
  let dir = file.parent().ok_or("That file isn’t there any more.")?;
  let inside = dir.file_name().is_some_and(|name| name == ARCHIVE);
  let target_dir = match (archived, inside) {
    (true, false) => dir.join(ARCHIVE),
    (false, true) => dir.parent().ok_or("That file isn’t there any more.")?.to_owned(),
    _ => return Ok(file.to_owned()),
  };
  let name = file.file_name().ok_or("That file isn’t there any more.")?;
  let stem = clean(&file.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default());
  let target = target_dir.join(name);
  let (pictures, pictures_to) = (dir.join("attachments").join(&stem), target_dir.join("attachments").join(&stem));
  let moving_pictures = !stem.is_empty() && pictures.is_dir();
  if target.symlink_metadata().is_ok() || (moving_pictures && pictures_to.symlink_metadata().is_ok()) {
    return Err(if archived { "There’s already one with this name in the archive. Rename this one first." } else { "There’s already one with this name. Rename this one first." }.into());
  }
  std::fs::create_dir_all(&target_dir).map_err(|e| format!("Couldn’t make the Archive folder: {e}"))?;
  if moving_pictures {
    if let Some(parent) = pictures_to.parent() { std::fs::create_dir_all(parent).map_err(|e| format!("Couldn’t move its pictures: {e}"))?; }
    std::fs::rename(&pictures, &pictures_to).map_err(|e| format!("Couldn’t move its pictures: {e}"))?;
  }
  if let Err(e) = std::fs::rename(file, &target) {
    if moving_pictures { let _ = std::fs::rename(&pictures_to, &pictures); }
    return Err(format!("Couldn’t move it: {e}"));
  }
  Ok(target)
}

/// A note or meeting into its folder's archive, or back out of it; where it is now.
#[tauri::command]
pub fn note_archive(path: String, archived: bool) -> Result<String, String> {
  Ok(archive_move(&in_library(&path)?, archived)?.display().to_string())
}

/// Moves a note or meeting to the Trash, under a name that is free there, where it can come back from.
#[tauri::command]
pub fn note_delete(path: String) -> Result<(), String> {
  let file = in_library(&path)?;
  let trash = PathBuf::from(std::env::var_os("HOME").ok_or("Couldn’t find your home folder.")?).join(".Trash");
  let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).ok_or("That file isn’t there any more.")?;
  let stem = name.strip_suffix(".md").unwrap_or(&name);
  for n in 1..=100 {
    let target = if n == 1 { trash.join(&name) } else { trash.join(format!("{stem} {n}.md")) };
    if target.symlink_metadata().is_ok() { continue; }
    return std::fs::rename(&file, &target).map_err(|e| format!("Couldn’t move it to the Trash: {e}"));
  }
  Err("Couldn’t move it to the Trash.".into())
}

#[tauri::command]
pub async fn note_read(path: String) -> Result<NoteDoc, String> {
  tauri::async_runtime::spawn_blocking(move || read_doc(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn note_write(path: String, title: String, body: String) -> Result<u64, String> {
  tauri::async_runtime::spawn_blocking(move || write_doc(&path, &title, &body)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn note_new(title: String, text: String, stamp: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || new_doc(&title, &text, &stamp).map(|path| path.display().to_string())).await.map_err(|e| e.to_string())?
}

/// Keeps the tray's Recent Notes in step with the folder, whatever changes it: Finder, Obsidian, a sync.
// ponytail: a scan of the folder's top level every 4 s; FSEvents if folders of many thousands of notes show up.
pub fn watch(app: &tauri::AppHandle) {
  let app = app.clone();
  let shown = |notes: Vec<NoteRef>| notes.into_iter().map(|note| note.path).collect::<Vec<_>>();
  let mut last = shown(recent(10));
  let spawned = std::thread::Builder::new().name("notes-watch".into()).spawn(move || loop {
    std::thread::sleep(Duration::from_secs(4));
    let now = shown(recent(10));
    if now != last { last = now; crate::recent_changed(&app); }
  });
  if let Err(e) = spawned { log::warn!("notes: can’t watch the folder: {e}"); }
}

// ---------- commands ----------

/// Claude's title, as one short line.
fn claude_title(text: &str) -> Option<String> {
  let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
  let line = line.trim_start_matches('#').trim().trim_matches(['"', '\'', '“', '”', '*', '`']).trim().trim_end_matches('.');
  let line: String = line.chars().take(80).collect();
  (!line.trim().is_empty()).then(|| line.trim().to_owned())
}

/// Saves a spoken note. With Claude connected it names the note and adds action items, as the notes
/// settings say; a title the person typed (`named`) stands. Each waits only as long as Claude's own
/// budget, and the note is saved as it is when Claude has nothing.
#[tauri::command]
pub async fn save_note(app: tauri::AppHandle, title: String, text: String, stamp: String, named: Option<bool>) -> Result<String, String> {
  if text.trim().is_empty() { return Err("There’s nothing to save.".into()); }
  self::stamp(&stamp)?;
  let path = tauri::async_runtime::spawn_blocking(move || {
    let settings = settings::get();
    let claude = settings.claude.enabled;
    let (title, actions) = std::thread::scope(|scope| {
      let naming = (claude && settings.notes.claude_title && !(named.unwrap_or(false) && !title.trim().is_empty())).then(|| scope.spawn(|| crate::ai::title(&text)));
      let listing = (claude && settings.notes.claude_actions).then(|| scope.spawn(|| crate::ai::summarize(crate::ai::Kind::Note, &text)));
      let title = naming.and_then(|job| job.join().ok().flatten()).and_then(|named| claude_title(&named)).unwrap_or(title);
      (title, listing.and_then(|job| job.join().ok().flatten()))
    });
    save(Kind::Note, &title, &text, actions.as_deref(), &stamp, &[])
  }).await.map_err(|e| e.to_string())??;
  crate::recent_changed(&app);
  Ok(path.display().to_string())
}

/// Shows the notes folder in Finder, with `file` selected when given.
#[tauri::command]
pub fn show_notes(file: Option<String>) -> Result<(), String> {
  let dir = notes_dir()?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let dir = dir.canonicalize().map_err(|e| e.to_string())?;
  let mut open = std::process::Command::new("/usr/bin/open");
  // Resolved first: `starts_with` compares components, so `<notes>/../x` would pass as written.
  match file.and_then(|file| PathBuf::from(file).canonicalize().ok()).filter(|file| file.starts_with(&dir)) {
    Some(file) => open.arg("-R").arg(file),
    None => open.arg(dir),
  };
  open.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder { path: String, vault: Option<String> }

/// The notes folder as it is now, and the name of the Obsidian vault it is in.
#[tauri::command]
pub fn notes_folder() -> Result<Folder, String> {
  let dir = notes_dir()?;
  let vault = vault_of(&dir).map(|vault| vault.file_name().map_or_else(|| vault.display().to_string(), |name| name.to_string_lossy().into_owned()));
  Ok(Folder { path: dir.display().to_string(), vault })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview { file_name: String, text: String }

/// The file a note would be saved as with `notes`, and what goes in it: the same code as saving.
#[tauri::command]
pub fn preview_note(notes: Notes, title: String, body: String, actions: Option<String>, stamp: String) -> Result<Preview, String> {
  let note = compose(&notes, Kind::Note, &title, &body, actions.as_deref(), self::stamp(&stamp)?, &[]);
  Ok(Preview { file_name: format!("{}.md", note.stem), text: format!("{}{}", note.header, note.section) })
}

extern "C" {
  fn dictate_choose_folder(window: *mut c_void, message: *const c_char, start: *const c_char, context: *mut c_void, done: extern "C" fn(*mut c_void, *const c_char));
}

type Chosen = tokio::sync::oneshot::Sender<Option<String>>;

extern "C" fn folder_chosen(context: *mut c_void, path: *const c_char) {
  let done = unsafe { Box::from_raw(context.cast::<Chosen>()) };
  let _ = done.send((!path.is_null()).then(|| unsafe { CStr::from_ptr(path) }.to_string_lossy().into_owned()));
}

/// The Mac's folder picker, as a sheet on the window that asks, opening at `start`. The chosen folder,
/// or None when the person cancels. `message` says what the folder is for.
#[tauri::command]
pub async fn choose_folder(window: tauri::WebviewWindow, message: Option<String>, start: Option<String>) -> Result<Option<String>, String> {
  let message = CString::new(message.unwrap_or_default()).map_err(|e| e.to_string())?;
  let start = start.filter(|start| Path::new(start).is_absolute()).map(CString::new).transpose().map_err(|e| e.to_string())?;
  let (done, chosen) = tokio::sync::oneshot::channel();
  let parent = window.clone();
  window.run_on_main_thread(move || {
    let native = parent.ns_window().unwrap_or(std::ptr::null_mut());
    let context = Box::into_raw(Box::new(done)).cast::<c_void>();
    unsafe { dictate_choose_folder(native, message.as_ptr(), start.as_ref().map_or(std::ptr::null(), |start| start.as_ptr()), context, folder_chosen) };
  }).map_err(|e| e.to_string())?;
  chosen.await.map_err(|_| "The folder picker closed".to_string())
}

#[cfg(test)]
mod tests {
  #[test]
  fn archiving_moves_the_file_and_its_pictures_into_archive_and_back() {
    let root = std::env::temp_dir().join(format!("dictate-archive-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("attachments/Plan")).unwrap();
    std::fs::write(root.join("Plan.md"), "![](attachments/Plan/a.png)").unwrap();
    std::fs::write(root.join("attachments/Plan/a.png"), "png").unwrap();
    let archived = archive_move(&root.join("Plan.md"), true).unwrap();
    assert_eq!(archived, root.join("Archive/Plan.md"));
    assert!(root.join("Archive/attachments/Plan/a.png").is_file() && !root.join("attachments/Plan").exists());
    assert_eq!(archive_move(&archived, true).unwrap(), archived, "archiving twice leaves it where it is");
    std::fs::write(root.join("Plan.md"), "a new one").unwrap();
    assert!(archive_move(&archived, false).is_err(), "never over a file of the same name");
    std::fs::remove_file(root.join("Plan.md")).unwrap();
    assert_eq!(archive_move(&archived, false).unwrap(), root.join("Plan.md"));
    assert!(root.join("attachments/Plan/a.png").is_file());
    let _ = std::fs::remove_dir_all(&root);
  }

  use super::*;

  #[test]
  fn a_note_splits_into_front_matter_title_and_body_and_writes_back_the_same_way() {
    let text = "---\ncreated: 2026-11-02T13:05\ntitle: Hello\ntags: []\n---\n\n# Hello\n\nFirst line.\n\n- [ ] Call them\n";
    let (front, rest) = split_front(text);
    assert_eq!(front, "---\ncreated: 2026-11-02T13:05\ntitle: Hello\ntags: []\n---\n");
    let (heading, body) = split_heading(rest);
    assert_eq!(heading, Some("Hello"));
    assert_eq!(body, "First line.\n\n- [ ] Call them\n");
    assert_eq!(retitled(front, "Hello again"), "---\ncreated: 2026-11-02T13:05\ntitle: \"Hello again\"\ntags: []\n---\n", "a title with a space is quoted, as every value with one is");
    assert_eq!(retitled(front, ""), "---\ncreated: 2026-11-02T13:05\ntags: []\n---\n");
    assert_eq!(retitled("---\ncreated: x\n---\n", "New"), "---\ncreated: x\n---\n", "no title line, none added");
    assert_eq!(split_front("# Plain\n\nWords\n"), ("", "# Plain\n\nWords\n"));
    assert_eq!(split_heading("Just words\n"), (None, "Just words\n"));
    assert_eq!(split_heading("\n\n# \n\nWords"), (None, "# \n\nWords"), "an empty heading is text");
  }

  #[test]
  fn the_library_lists_notes_and_meetings_by_title_newest_first() {
    let dir = std::env::temp_dir().join(format!("dictate-library-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("Meetings")).unwrap();
    std::fs::write(dir.join("2026-11-02 Venue.md"), "---\ncreated: 2026-11-02T09:41\ntitle: \"Call the venue\"\n---\n\n# Venue\n\nCall the venue about Thursday and ask for the bigger room.\n\n## Action items\n\n- [ ] Call them\n").unwrap();
    std::fs::write(dir.join("Plain.md"), "Just some words, no heading at all.\n").unwrap();
    std::fs::write(dir.join(".hidden.md"), "# Hidden\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "not markdown").unwrap();
    std::fs::write(dir.join("Meetings").join("Design review.md"), "# Design review\n\n**You** 00:00:01 Hello everyone\n").unwrap();
    let mut items = Vec::new();
    library_in(&dir, "note", false, &mut items);
    library_in(&dir.join("Meetings"), "meeting", false, &mut items);
    let mut titles: Vec<(&str, &str)> = items.iter().map(|item| (item.kind, item.title.as_str())).collect();
    titles.sort();
    assert_eq!(titles, vec![("meeting", "Design review"), ("note", "Call the venue"), ("note", "Plain")]);
    let venue = items.iter().find(|item| item.title == "Call the venue").unwrap();
    assert_eq!(venue.excerpt, "Call the venue about Thursday and ask for the bigger room. Call them");
    assert_eq!(venue.words, 13);
    assert_eq!(title_of("# Heading\n\nbody", "file"), "Heading");
    assert_eq!(title_of("no heading", "A file name"), "A file name");
    assert!(excerpt_of(&"word ".repeat(100)).ends_with('…'));
    let _ = std::fs::remove_dir_all(&dir);
  }

  const AT: &str = "2026-11-01 21.40";
  fn at() -> Stamp<'static> { stamp(AT).unwrap() }
  fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dictate-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }
  fn notes(change: impl FnOnce(&mut Notes)) -> Notes { let mut notes = Notes::default(); change(&mut notes); notes }

  #[test]
  fn stamps_are_exactly_date_and_time() {
    let at = at();
    assert_eq!((at.date, at.hour, at.minute), ("2026-11-01", "21", "40"));
    for bad in ["", "2026-11-01", "2026-11-01 21:40", "2026-11-01 21.4x", "2026-11-01T21.40", "../../../etc/x.md"] { assert!(stamp(bad).is_err(), "{bad}"); }
  }

  #[test]
  fn the_template_fills_its_tokens_and_cleans_the_name() {
    assert_eq!(file_stem("{date} {title}", "Call the venue: about Thursday", at()), "2026-11-01 Call the venue about Thursday");
    assert_eq!(file_stem("{date} {time} {title}", "Plan", at()), "2026-11-01 21.40 Plan");
    assert_eq!(file_stem("{title} ({date})", "Plan", at()), "Plan (2026-11-01)");
    assert_eq!(file_stem("{date} {title}", "  ", at()), "2026-11-01 Note");
    assert_eq!(file_stem("{title}", "", at()), "Note");
    assert_eq!(file_stem("{title}", "../../etc/passwd", at()), "etc passwd"); // a slash is never a folder, a dot never hides it
    assert_eq!(file_stem("{title}", "Line one\nline\ttwo", at()), "Line one line two");
    assert_eq!(file_stem("{title} {unknown}", "Plan", at()), "Plan {unknown}");
    assert_eq!(file_stem("{title}", "Say {date} out loud", at()), "Say {date} out loud"); // a title is never read as tokens
    let long = file_stem("{date} {title}", &"İstanbul ".repeat(60), at());
    assert!(long.len() <= 200 && long.starts_with("2026-11-01 İstanbul") && !long.ends_with(' '));
  }

  #[test]
  fn front_matter_carries_created_tags_and_source() {
    let tags = ["work", "#idea", "client work", "yes", "3d", "q: x"].map(String::from);
    let extra = [("type", "meeting"), ("tags", "x"), ("bad key", "x")].map(|(key, value)| (key.to_owned(), value.to_owned()));
    assert_eq!(front_matter(at(), &tags, &extra),
      "---\ncreated: 2026-11-01T21:40\ntags:\n  - work\n  - idea\n  - client-work\n  - \"yes\"\n  - \"3d\"\n  - \"q:-x\"\nsource: TabTasker Dictate\ntype: meeting\n---\n\n");
    assert_eq!(front_matter(at(), &[], &[]), "---\ncreated: 2026-11-01T21:40\ntags: []\nsource: TabTasker Dictate\n---\n\n");
  }

  #[test]
  fn a_note_is_composed_as_the_settings_say() {
    let note = compose(&notes(|n| n.tags = vec!["inbox".into()]), Kind::Note, "Plan", " Ask for the bigger room. \n", Some("- [ ] Call the venue"), at(), &[]);
    assert_eq!(note.stem, "2026-11-01 Plan");
    assert_eq!(format!("{}{}", note.header, note.section),
      "---\ncreated: 2026-11-01T21:40\ntags:\n  - inbox\nsource: TabTasker Dictate\n---\n\n# Plan\n\nAsk for the bigger room.\n\n## Action items\n\n- [ ] Call the venue\n");
    let plain = compose(&notes(|n| n.frontmatter = false), Kind::Note, "", "Words", Some("  "), at(), &[]);
    assert_eq!((plain.header.as_str(), plain.section.as_str()), ("", "Words\n"));
    let daily = compose(&notes(|n| n.daily_note = true), Kind::Note, "Plan", "Words", Some("- [ ] One"), at(), &[]);
    assert_eq!((daily.stem.as_str(), daily.daily), ("2026-11-01", true));
    assert_eq!(daily.section, "## 21:40 Plan\n\nWords\n\n### Action items\n\n- [ ] One\n");
    assert!(!compose(&notes(|n| n.daily_note = true), Kind::Meeting, "Standup", "Words", None, at(), &[]).daily); // a meeting is always its own file
  }

  #[test]
  fn a_note_file_never_overwrites_another_or_writes_through_a_link() {
    let dir = temp("notes-new");
    let target = dir.join("elsewhere.txt");
    std::os::unix::fs::symlink(&target, dir.join("2026-11-01 Plan.md")).unwrap();
    let saved = write_new(&dir, "2026-11-01 Plan", b"one").unwrap();
    assert_eq!(saved.file_name().unwrap(), "2026-11-01 Plan 2.md");
    assert!(!target.exists());
    let again = write_new(&dir, "2026-11-01 Plan", b"two").unwrap();
    assert_eq!(again.file_name().unwrap(), "2026-11-01 Plan 3.md");
    assert_eq!(std::fs::read(&saved).unwrap(), b"one");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_daily_note_appends_sections_and_starts_once_with_front_matter() {
    let dir = temp("notes-daily");
    let settings = notes(|n| n.daily_note = true);
    let path = append_daily(&dir, &compose(&settings, Kind::Note, "Plan", "One", None, at(), &[])).unwrap();
    assert_eq!(path.file_name().unwrap(), "2026-11-01.md");
    let later = compose(&settings, Kind::Note, "", "Two", None, stamp("2026-11-01 22.05").unwrap(), &[]);
    assert_eq!(append_daily(&dir, &later).unwrap(), path);
    assert_eq!(std::fs::read_to_string(&path).unwrap(),
      "---\ncreated: 2026-11-01T21:40\ntags: []\nsource: TabTasker Dictate\n---\n\n## 21:40 Plan\n\nOne\n\n## 22:05\n\nTwo\n");
    // A day's file the person wrote, without a final line break, gets a blank line before the section.
    std::fs::write(dir.join("2026-11-02.md"), "My own words").unwrap();
    append_daily(&dir, &compose(&settings, Kind::Note, "Plan", "Three", None, stamp("2026-11-02 08.00").unwrap(), &[])).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("2026-11-02.md")).unwrap(), "My own words\n\n## 08:00 Plan\n\nThree\n");
    std::fs::write(dir.join("2026-11-03.md"), "x").unwrap();
    append_daily(&dir, &compose(&settings, Kind::Note, "", "Four", None, stamp("2026-11-03 08.00").unwrap(), &[])).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("2026-11-03.md")).unwrap(), "x\n\n## 08:00\n\nFour\n");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_daily_note_never_writes_through_a_link_or_into_a_folder() {
    let dir = temp("notes-daily-link");
    let target = dir.join("elsewhere.md");
    std::fs::write(&target, "keep").unwrap();
    std::os::unix::fs::symlink(&target, dir.join("2026-11-01.md")).unwrap();
    std::fs::create_dir(dir.join("2026-11-01 2.md")).unwrap();
    let note = compose(&notes(|n| { n.daily_note = true; n.frontmatter = false; }), Kind::Note, "Plan", "One", None, at(), &[]);
    let path = append_daily(&dir, &note).unwrap();
    assert_eq!(path.file_name().unwrap(), "2026-11-01 3.md");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    assert_eq!(append_daily(&dir, &note).unwrap(), path); // and the same file the next time
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn a_vault_is_the_folder_itself_or_one_above_it() {
    let dir = temp("notes-vault");
    let vault = dir.join("Second Brain");
    std::fs::create_dir_all(vault.join(".obsidian")).unwrap();
    std::fs::create_dir_all(vault.join("Inbox/Voice")).unwrap();
    std::fs::create_dir_all(dir.join("Plain")).unwrap();
    std::fs::write(dir.join("Plain/.obsidian"), "a file, not a vault").unwrap();
    let vault = vault.canonicalize().unwrap();
    assert_eq!(vault_of(&dir.join("Second Brain")), Some(vault.clone()));
    assert_eq!(vault_of(&dir.join("Second Brain/Inbox/Voice")), Some(vault.clone()));
    assert!(vault_of(&dir.join("Second Brain/Inbox/Not yet made")).is_some_and(|found| found.ends_with("Second Brain"))); // made on the first save
    assert_eq!(vault_of(&dir.join("Plain")), None);
    std::os::unix::fs::symlink(dir.join("Second Brain/Inbox"), dir.join("Link")).unwrap();
    assert_eq!(vault_of(&dir.join("Link")), Some(vault));
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn claude_titles_are_one_short_line() {
    assert_eq!(claude_title("\n# “Venue for Thursday.”\nmore"), Some("Venue for Thursday".into()));
    assert!(claude_title(&"word ".repeat(40)).unwrap().chars().count() <= 80);
    assert_eq!(claude_title("  \n\"\" "), None);
  }

  #[test]
  fn recent_notes_are_markdown_files_newest_first() {
    let dir = temp("recent");
    std::fs::create_dir_all(dir.join("Meetings.md")).unwrap(); // a folder, even one named like a note, is not a note
    std::fs::write(dir.join("old.md"), "a").unwrap();
    std::fs::write(dir.join("photo.png"), "b").unwrap();
    std::fs::write(dir.join(".hidden.md"), "b").unwrap();
    let old = std::fs::File::options().write(true).open(dir.join("old.md")).unwrap();
    old.set_modified(std::time::SystemTime::now() - Duration::from_secs(60)).unwrap();
    std::fs::write(dir.join("new.md"), "c").unwrap();
    let titles: Vec<String> = recent_in(&dir, 10).into_iter().map(|note| note.title).collect();
    assert_eq!(titles, ["new", "old"]);
    assert_eq!(recent_in(&dir, 1).len(), 1);
    assert!(recent_in(&dir.join("missing"), 5).is_empty());
    std::fs::remove_dir_all(dir).unwrap();
  }
}
