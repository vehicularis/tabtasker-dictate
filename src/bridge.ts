// The Tauri global (withGlobalTauri): the app's commands and the native voice code's events. In a plain
// browser (the Vite server, for design checks) an in-memory mock answers instead.
type Tauri = {
  core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: { listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> };
  window: { getCurrentWindow: () => { close: () => Promise<void>; setTitle: (title: string) => Promise<void> } };
};
const tauri = () => (window as unknown as { __TAURI__?: Tauri }).__TAURI__;
export const inApp = () => !!tauri();

let mock: Promise<typeof import('./mock')> | undefined;
const browser = () => (mock ??= import('./mock'));

export const invoke = <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const app = tauri();
  if (app) return app.core.invoke(command, args) as Promise<T>;
  return browser().then(m => m.invoke(command, args ?? {}) as T);
};

export function listen<T>(name: string, handler: (payload: T) => void): () => void {
  let off: (() => void) | undefined, gone = false;
  const app = tauri();
  const subscribed = app ? app.event.listen(name, event => handler(event.payload as T)) : browser().then(m => m.listen(name, payload => handler(payload as T)));
  void subscribed.then(unlisten => { if (gone) unlisten(); else off = unlisten; });
  return () => { gone = true; off?.(); };
}

// Closes the window this page is in; a browser tab has none to close.
export const closeWindow = () => { void tauri()?.window.getCurrentWindow().close(); };
// Names the window this page is in, as the Mac shows it in Mission Control and the Window menu; a browser tab names itself.
export const setWindowTitle = (title: string) => { const app = tauri(); if (app) void app.window.getCurrentWindow().setTitle(title).catch(() => {}); else document.title = title; };
