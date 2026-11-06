//! The app's own log, `~/Library/Logs/TabTasker Dictate/dictate.log`: one line a message, Info and up,
//! from this crate (the native code's `dictate_log` lines included) and the speech engine alone, so a
//! problem on someone's Mac can be read after the fact. In a debug build the same lines go to the terminal.
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) struct FileLog(Mutex<Option<std::fs::File>>);

impl FileLog {
  pub(crate) fn open() -> Self {
    let file = std::env::var_os("HOME").map(PathBuf::from).and_then(|home| {
      let dir = home.join("Library/Logs/TabTasker Dictate");
      std::fs::create_dir_all(&dir).ok()?;
      let path = dir.join("dictate.log");
      // Kept to a few megabytes: a full log is moved aside and a new one started.
      if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 4 << 20) { let _ = std::fs::rename(&path, dir.join("dictate.old.log")); }
      std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
    });
    FileLog(Mutex::new(file))
  }
}

/// The time as "2026-11-02T13:05:09Z" from the seconds since 1970 (civil-from-days, Howard Hinnant).
fn utc_stamp(secs: u64) -> String {
  let (days, rest) = (secs / 86_400, secs % 86_400);
  let z = days as i64 + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
  let year = yoe + era * 400 + i64::from(month <= 2);
  format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

impl log::Log for FileLog {
  fn enabled(&self, meta: &log::Metadata) -> bool {
    meta.level() <= log::Level::Info && [env!("CARGO_CRATE_NAME"), "dictate_engine"].iter().any(|ours| meta.target().starts_with(ours))
  }
  fn log(&self, record: &log::Record) {
    if !self.enabled(record.metadata()) { return; }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |age| age.as_secs());
    let line = format!("{} {} {}\n", utc_stamp(now), record.level(), record.args());
    #[cfg(debug_assertions)] eprint!("{line}");
    if let Some(file) = &mut *self.0.lock().unwrap_or_else(|e| e.into_inner()) { use std::io::Write; let _ = file.write_all(line.as_bytes()); }
  }
  fn flush(&self) {}
}

#[cfg(test)]
mod tests {
  #[test]
  fn the_log_stamps_utc_time_from_seconds() {
    assert_eq!(super::utc_stamp(0), "1970-01-01T00:00:00Z");
    assert_eq!(super::utc_stamp(1_793_192_709), "2026-10-28T13:05:09Z");
    assert_eq!(super::utc_stamp(951_782_400), "2000-02-29T00:00:00Z", "a leap day");
  }

  #[test]
  fn the_log_keeps_the_app_and_the_engine_only() {
    use log::{Level, Log, Metadata};
    let log = super::FileLog(std::sync::Mutex::new(None));
    let kept = |target: &str, level: Level| log.enabled(&Metadata::builder().target(target).level(level).build());
    assert!(kept(concat!(env!("CARGO_CRATE_NAME"), "::dictation::speech"), Level::Info));
    assert!(kept("dictate_engine::pieces", Level::Warn), "the engine's lines, such as a skipped piece of a note");
    assert!(!kept("dictate_engine::pieces", Level::Debug));
    assert!(!kept("whisper_rs", Level::Info), "native logs can hold recognized words");
  }
}
