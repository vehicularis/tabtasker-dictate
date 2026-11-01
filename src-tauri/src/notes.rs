//! Notes and meetings as Markdown files in a folder the person picks, one file each.
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Note, Meeting }

/// A saved note, newest first in `recent`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef { pub path: PathBuf, pub title: String, pub modified_ms: u64 }

fn documents() -> Result<PathBuf, String> {
  let home = std::env::var_os("HOME").ok_or("No home folder")?;
  Ok(PathBuf::from(home).join("Documents").join("TabTasker Dictate"))
}

/// The notes folder: the one in Settings, or Documents/TabTasker Dictate.
pub fn notes_dir() -> Result<PathBuf, String> {
  crate::settings::get().notes.folder.map_or_else(documents, |folder| Ok(PathBuf::from(folder)))
}

/// The meetings folder: the one in Settings, or Meetings inside the notes folder.
pub fn meetings_dir() -> Result<PathBuf, String> {
  crate::settings::get().meetings.folder.map_or_else(|| Ok(notes_dir()?.join("Meetings")), |folder| Ok(PathBuf::from(folder)))
}

/// A file name from the note's title: what a Mac allows, short, never an existing note's.
pub(crate) fn note_path(dir: &Path, title: &str, stamp: &str) -> PathBuf {
  let clean: String = title.chars().map(|c| if c == '/' || c == ':' || c.is_control() { ' ' } else { c }).collect();
  let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
  let clean: String = clean.trim_start_matches('.').chars().take(80).collect();
  let base = if clean.is_empty() { format!("Note {stamp}") } else { format!("{stamp} {clean}") };
  let mut path = dir.join(format!("{base}.md"));
  let mut n = 2;
  while path.exists() { path = dir.join(format!("{base} {n}.md")); n += 1; }
  path
}

/// Saves `body` under `title` as a new Markdown file in the folder for `kind`. `stamp` is the local
/// time as "YYYY-MM-DD HH.mm"; `extra_front_matter` holds keys a caller adds to the file's front matter.
pub fn save_markdown(kind: Kind, title: &str, body: &str, stamp: &str, _extra_front_matter: &[(String, String)]) -> Result<PathBuf, String> {
  if body.trim().is_empty() || body.chars().count() > 1_000_000 { return Err("Nothing to save".into()); }
  if !stamp.chars().all(|c| c.is_ascii_digit() || c == '-' || c == ' ' || c == '.') || stamp.len() > 20 { return Err("Invalid date".into()); }
  let dir = match kind { Kind::Note => notes_dir()?, Kind::Meeting => meetings_dir()? };
  std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t make the notes folder: {e}"))?;
  let path = note_path(&dir, title, stamp);
  let heading = title.trim();
  let text = if heading.is_empty() { format!("{}\n", body.trim()) } else { format!("# {heading}\n\n{}\n", body.trim()) };
  std::fs::write(&path, text).map_err(|e| format!("Couldn’t save the note: {e}"))?;
  Ok(path)
}

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
    if path.extension()? != "md" || !entry.file_type().ok()?.is_file() { return None; }
    let modified = entry.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(NoteRef { title: path.file_stem()?.to_string_lossy().into_owned(), path, modified_ms: modified })
  }).collect();
  notes.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.title.cmp(&b.title)));
  notes.truncate(n);
  notes
}

#[tauri::command]
pub fn save_note(app: tauri::AppHandle, title: String, text: String, stamp: String) -> Result<String, String> {
  let path = save_markdown(Kind::Note, &title, &text, &stamp, &[])?;
  crate::recent_changed(&app);
  Ok(path.display().to_string())
}

/// Shows the notes folder in Finder, with `file` selected when given.
#[tauri::command]
pub fn show_notes(file: Option<String>) -> Result<(), String> {
  let dir = notes_dir()?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let mut open = std::process::Command::new("/usr/bin/open");
  match file.map(PathBuf::from).filter(|file| file.starts_with(&dir)) {
    Some(file) => open.arg("-R").arg(file),
    None => open.arg(dir),
  };
  open.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_note_file_is_named_for_its_title_and_never_overwrites_another() {
    let dir = std::env::temp_dir().join(format!("dictate-notes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let first = note_path(&dir, "Call the venue: about Thursday", "2026-11-01 21.40");
    assert_eq!(first.file_name().unwrap(), "2026-11-01 21.40 Call the venue about Thursday.md");
    std::fs::write(&first, "x").unwrap();
    assert_eq!(note_path(&dir, "Call the venue: about Thursday", "2026-11-01 21.40").file_name().unwrap(), "2026-11-01 21.40 Call the venue about Thursday 2.md");
    assert_eq!(note_path(&dir, "../../etc/passwd", "2026-11-01 21.40").parent().unwrap(), dir); // a slash is never a folder
    assert_eq!(note_path(&dir, "  ", "2026-11-01 21.40").file_name().unwrap(), "Note 2026-11-01 21.40.md");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn recent_notes_are_markdown_files_newest_first() {
    let dir = std::env::temp_dir().join(format!("dictate-recent-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("Meetings.md")).unwrap(); // a folder, even one named like a note, is not a note
    std::fs::write(dir.join("old.md"), "a").unwrap();
    std::fs::write(dir.join("photo.png"), "b").unwrap();
    let old = std::fs::File::options().write(true).open(dir.join("old.md")).unwrap();
    old.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60)).unwrap();
    std::fs::write(dir.join("new.md"), "c").unwrap();
    let titles: Vec<String> = recent_in(&dir, 10).into_iter().map(|note| note.title).collect();
    assert_eq!(titles, ["new", "old"]);
    assert_eq!(recent_in(&dir, 1).len(), 1);
    assert!(recent_in(&dir.join("missing"), 5).is_empty());
    std::fs::remove_dir_all(dir).unwrap();
  }
}
