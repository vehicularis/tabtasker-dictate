//! The windows: the overlay, and the app's window with its pages.
use super::{dictate_overlay_attach, dictate_window_toolbar, MAIN, OVERLAY};
use crate::library::{notes, stickies};
use crate::settings;
use tauri::{ActivationPolicy, AppHandle, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

/// The app window's places, by the first part of the hash it opens on (`notes/<path>` opens that note).
const ROUTES: &[&str] = &["notes", "meetings", "stickies", "settings", "setup", "about", "help"];

pub(crate) fn overlay(app: &AppHandle) -> tauri::Result<()> {
  let window = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("index.html".into()))
    .title("TabTasker Dictate")
    .decorations(false).transparent(true).shadow(false)
    .always_on_top(true).visible_on_all_workspaces(true).skip_taskbar(true).resizable(false).focused(false)
    .visible(false) // dictate.m shows it once the page has drawn the overlay
    .accept_first_mouse(true) // the overlay is never key while another app is in front
    .build()?;
  if let Ok(native) = window.ns_window() { unsafe { dictate_overlay_attach(native) }; }
  Ok(())
}

/// The app's window (notes, meetings, stickies and the settings), made on demand. While it is open the
/// app has a Dock icon and a menu bar, like any app with a window; closing it goes back to the menu bar
/// only. With no `route`, an open window keeps its place and a new one starts on Notes.
pub(crate) fn show_main(app: &AppHandle, route: Option<&str>) -> tauri::Result<()> {
  let route = route.map(|route| if ROUTES.contains(&route.split('/').next().unwrap_or_default()) { route } else { "notes" });
  app.set_activation_policy(ActivationPolicy::Regular)?;
  if let Some(window) = app.get_webview_window(MAIN) {
    if let Some(route) = route { window.eval(format!("location.hash = '#{route}'"))?; }
    window.unminimize()?;
    window.show()?;
    return window.set_focus();
  }
  let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App(format!("app.html#{}", route.unwrap_or("notes")).into()))
    .title("TabTasker Dictate")
    .inner_size(1040.0, 700.0).min_inner_size(840.0, 580.0).center()
    .title_bar_style(TitleBarStyle::Overlay).hidden_title(true) // the lights where AppKit puts them, centred on the page's 40-point bar by its toolbar (panels.m)
    .build()?;
  if let Ok(native) = window.ns_window() { unsafe { dictate_window_toolbar(native) }; }
  // The frame's colour behind the page, as Business's window: the page paints the same, so the window's
  // edge is the frame's and a resize never shows anything else.
  let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
  let _ = window.set_background_color(Some(if dark { tauri::window::Color(0x17, 0x17, 0x17, 0xff) } else { tauri::window::Color(0xeb, 0xeb, 0xeb, 0xff) }));
  window.set_focus()
}

pub(super) fn show_note(app: &AppHandle, path: &str) -> Result<(), String> {
  let doc = notes::read_doc(path)?;
  let place = if doc.kind == "meeting" { "meetings" } else { "notes" };
  show_main(app, Some(&format!("{place}/{}", percent(&doc.path)))).map_err(|e| e.to_string())
}

/// `text` in a URL: letters, digits and a path's own marks as they are, everything else as bytes.
fn percent(text: &str) -> String {
  text.bytes().map(|byte| if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect()
}

/// General › Show in the Dock: the app as a regular one, with a Dock icon that opens the window, or back to
/// the menu bar only (unless the window is open, which keeps the Dock icon until it closes).
pub(crate) fn show_in_dock(app: &AppHandle, on: bool) {
  let policy = if on || app.get_webview_window(MAIN).is_some() { ActivationPolicy::Regular } else { ActivationPolicy::Accessory };
  if let Err(e) = app.set_activation_policy(policy) { log::warn!("dock: {e}"); }
}

pub(crate) fn window_event(window: &Window, event: &WindowEvent) {
  // The window closed: back to the menu bar only, unless the Dock icon is wanted all along.
  if window.label() == MAIN && matches!(event, WindowEvent::Destroyed) && !settings::get().general.show_in_dock {
    let _ = window.app_handle().set_activation_policy(ActivationPolicy::Accessory);
  }
  // The title bar's toolbar follows the window into and out of full screen.
  if window.label() == MAIN && matches!(event, WindowEvent::Resized(_)) {
    if let Ok(native) = window.ns_window() { unsafe { dictate_window_toolbar(native) }; }
  }
  // A sticky moved or resized comes back where it was left.
  if window.label().starts_with("sticky-") && matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) { stickies::frame_changed(window.app_handle(), window.label()); }
}
