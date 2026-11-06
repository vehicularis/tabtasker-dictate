//! Updates, as Sparkle gives other Mac apps. Now and then (General › Updates, on by default) Dictate asks GitHub
//! for the release marked Latest, downloads a newer one in the background and checks its signature against the
//! public key in tauri.conf.json, then offers a quiet restart. A restart never cuts short a hold, a hands-free
//! session, a spoken note or a meeting.
use super::menu;
use crate::{meetings, settings};
use semver::Version;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// What Settings, the pill and the menu bar item show.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct State {
  /// The version running.
  current: String,
  /// Checking, or downloading `version`.
  busy: bool,
  /// A newer release: downloading while `busy`, there to install once `ready`.
  version: Option<String>,
  ready: bool,
  /// The last check found nothing newer.
  latest: bool,
  /// Why the last check, download or install failed, in words for the page.
  problem: Option<String>,
}

static STATE: Mutex<State> = Mutex::new(State { current: String::new(), busy: false, version: None, ready: false, latest: false, problem: None });
/// The update downloaded and verified, kept until the restart installs it.
static READY: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
/// The voice code is busy: anything but idle is a hold, a hands-free session or a spoken note.
static HEARING: AtomicBool = AtomicBool::new(false);
// ponytail: six hours of the Mac being awake (tokio's clock stops in sleep); a menu bar app runs for weeks.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Only a newer final release: never an older one (a stale or replayed manifest), never a pre-release.
pub(crate) fn newer(current: &Version, offered: &Version) -> bool {
  offered.pre.is_empty() && offered > current
}

/// Why a restart has to wait, if it does: it never cuts short a hold, a hands-free session or a spoken note, nor a
/// meeting that is recording or still being saved.
fn wait_for(hearing: bool, meeting: bool) -> Option<&'static str> {
  if meeting {
    Some("Dictate can restart once your meeting is saved.")
  } else if hearing {
    Some("Dictate can restart once you’ve finished talking.")
  } else {
    None
  }
}

/// The voice code's phase, from its state reports: idle, listening, transcribing or sending.
pub(crate) fn heard(phase: &str) {
  HEARING.store(phase != "idle", Ordering::Relaxed);
}

pub(crate) fn state() -> State {
  State { current: env!("CARGO_PKG_VERSION").into(), ..lock(&STATE).clone() }
}

fn set(app: &AppHandle, change: impl FnOnce(&mut State)) {
  change(&mut lock(&STATE));
  let state = state();
  menu::update_changed(state.ready);
  let _ = app.emit("dictate-update", &state);
}

/// What a check asked for from a menu says once it has an answer.
fn told(state: &State) -> String {
  match (&state.problem, &state.version) {
    (Some(problem), _) => problem.clone(),
    (None, Some(version)) if state.ready => format!("TabTasker Dictate {version} is ready. Restart to update."),
    (None, Some(version)) => format!("Downloading TabTasker Dictate {version}. Dictate offers a restart when it’s ready."),
    (None, None) if state.latest => format!("You’re up to date. {} is the newest version.", state.current),
    (None, None) => "Already checking for updates.".into(),
  }
}

/// Asks for the latest release once, unless a check or download is already going or an update is ready, and
/// downloads a newer one in the background. Answers as soon as the check does.
async fn check(app: &AppHandle) -> State {
  {
    let mut state = lock(&STATE);
    if state.busy || state.ready {
      drop(state);
      return self::state();
    }
    *state = State { busy: true, ..State::default() };
  }
  let _ = app.emit("dictate-update", state());
  let found = match app.updater() {
    Ok(updater) => updater.check().await,
    Err(e) => Err(e),
  };
  match found {
    Ok(None) => set(app, |state| {
      state.busy = false;
      state.latest = true;
    }),
    Ok(Some(update)) => {
      set(app, |state| state.version = Some(update.version.clone()));
      let app = app.clone();
      tauri::async_runtime::spawn(async move {
        match update.download(|_, _| {}, || {}).await {
          Ok(bytes) => {
            *lock(&READY) = Some((update, bytes));
            set(&app, |state| {
              state.busy = false;
              state.ready = true;
            });
          }
          Err(e) => {
            log::warn!("updates: download: {e}");
            set(&app, |state| {
              state.busy = false;
              state.problem = Some("Couldn’t download the update. Dictate tries again later.".into());
            });
          }
        }
      });
    }
    Err(e) => {
      log::warn!("updates: check: {e}");
      set(app, |state| {
        state.busy = false;
        state.problem = Some("Couldn’t check for updates. Check you’re online and try again.".into());
      });
    }
  }
  state()
}

/// The checks General asks for: a minute after launch, then every six hours.
pub(crate) fn watch(app: &AppHandle) {
  if cfg!(debug_assertions) {
    return;
  } // a build from source isn't a release to update
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(Duration::from_secs(60)).await;
    loop {
      if settings::get().general.check_for_updates {
        check(&app).await;
      }
      tokio::time::sleep(EVERY).await;
    }
  });
}

/// Installs the update that is ready and starts the new version, once nothing is being recorded.
async fn restart(app: &AppHandle) -> Result<(), String> {
  if let Some(why) = wait_for(HEARING.load(Ordering::Relaxed), meetings::in_progress()) {
    return Err(why.into());
  }
  let Some((update, bytes)) = lock(&READY).take() else { return Err("There’s no update ready yet.".into()) };
  // Off the async threads: it unpacks the app, and may wait for an administrator's password on the main thread.
  let install = update.clone();
  let installed = tauri::async_runtime::spawn_blocking(move || install.install(&bytes).map_err(|e| (e, bytes))).await.map_err(|e| e.to_string())?;
  if let Err((e, bytes)) = installed {
    log::warn!("updates: install: {e}");
    *lock(&READY) = Some((update, bytes)); // there to try again
    let why = "Couldn’t install the update. Download it from the releases page instead.";
    set(app, |state| state.problem = Some(why.into()));
    return Err(why.into());
  }
  app.restart()
}

/// Where the updates stand, for Settings and the pill as they open.
#[tauri::command]
pub(crate) fn update_state() -> State {
  state()
}

/// A check now: from Settings, which shows the answer itself, or from the pill's menu, which `tell`s it as a notice.
#[tauri::command]
pub(crate) async fn update_check(app: AppHandle, tell: bool) -> State {
  let state = check(&app).await;
  if tell {
    super::events::emit("dictate-notice", serde_json::json!({ "message": told(&state) }));
  }
  state
}

#[tauri::command]
pub(crate) async fn update_restart(app: AppHandle) -> Result<(), String> {
  restart(&app).await
}

/// The menu bar item's Check for Updates…, which turns into Restart to Update once one is ready.
pub(crate) fn menu_item(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let message = if lock(&READY).is_some() { restart(&app).await.err() } else { Some(told(&check(&app).await)) };
    if let Some(message) = message {
      super::events::emit("dictate-notice", serde_json::json!({ "message": message }));
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_a_newer_final_release_is_an_update() {
    let v = |text: &str| Version::parse(text).unwrap();
    let current = v("0.1.1");
    for offered in ["0.1.2", "0.1.10", "0.2.0", "1.0.0", "0.1.2+build.7"] {
      assert!(newer(&current, &v(offered)), "{offered}");
    }
    for offered in ["0.1.1", "0.1.0", "0.0.9", "0.2.0-beta.1", "1.0.0-rc.1"] {
      assert!(!newer(&current, &v(offered)), "{offered}");
    }
    assert!(newer(&v("0.1.9"), &v("0.1.10")), "by number, not as text");
  }

  #[test]
  fn a_restart_waits_for_a_hold_or_a_meeting() {
    for phase in ["listening", "transcribing", "sending"] {
      heard(phase);
      assert!(wait_for(HEARING.load(Ordering::Relaxed), false).is_some(), "{phase}");
    }
    heard("idle");
    assert_eq!(wait_for(HEARING.load(Ordering::Relaxed), false), None);
    assert!(wait_for(false, true).is_some(), "a meeting recording or saving");
    assert!(wait_for(true, true).is_some());
  }

  #[test]
  fn a_menu_check_says_what_it_found() {
    let state = |change: fn(&mut State)| {
      let mut state = State { current: "0.1.1".into(), ..State::default() };
      change(&mut state);
      told(&state)
    };
    assert_eq!(state(|s| s.latest = true), "You’re up to date. 0.1.1 is the newest version.");
    assert!(state(|s| {
      s.busy = true;
      s.version = Some("0.1.2".into());
    })
    .starts_with("Downloading TabTasker Dictate 0.1.2."));
    assert!(state(|s| {
      s.ready = true;
      s.version = Some("0.1.2".into());
    })
    .contains("0.1.2 is ready"));
    assert!(state(|s| s.problem = Some("Couldn’t check.".into())) == "Couldn’t check.");
  }
}
