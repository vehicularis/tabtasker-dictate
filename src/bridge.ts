// The Tauri global (withGlobalTauri): the app's commands and the native voice code's events. In a plain
// browser (the Vite server, for design checks) an in-memory mock answers instead.
type Tauri = {
  core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>; convertFileSrc: (path: string) => string };
  event: { listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> };
  window: { getCurrentWindow: () => { close: () => Promise<void>; setTitle: (title: string) => Promise<void> } };
  menu: {
    Menu: { new: (options: { items: unknown[] }) => Promise<{ popup: (at?: unknown) => Promise<void> }> };
    MenuItem: { new: (options: { text: string; enabled?: boolean; action?: () => void }) => Promise<unknown> };
    CheckMenuItem: { new: (options: { text: string; checked?: boolean; enabled?: boolean; action?: () => void }) => Promise<unknown> };
    Submenu: { new: (options: { text: string; items: unknown[] }) => Promise<unknown> };
    PredefinedMenuItem: { new: (options: { item: 'Separator' }) => Promise<unknown> };
  };
  dpi: { LogicalPosition: new (x: number, y: number) => unknown };
};
const tauri = () => (window as unknown as { __TAURI__?: Tauri }).__TAURI__;

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

/// A file on this Mac as a URL the page may show (a picture kept beside a note); in a browser, the path itself.
export const fileSrc = (path: string) => tauri()?.core.convertFileSrc(path) ?? path;

/// A native menu, as the Mac draws them: items with a tick or not, submenus and separators. Popped over the window
/// at `at` (page points) or under the pointer, so it is never clipped by a small window (a sticky's look menu).
/// False in a browser, where the page draws its own menu instead.
export type MenuSpec = ({ text: string; checked?: boolean; disabled?: boolean; action: () => void } | { text: string; items: MenuSpec } | 'separator')[];
export async function popupMenu(spec: MenuSpec, at?: { x: number; y: number }): Promise<boolean> {
  const app = tauri();
  if (!app?.menu) return false;
  const { Menu, MenuItem, CheckMenuItem, Submenu, PredefinedMenuItem } = app.menu;
  const build = (items: MenuSpec): Promise<unknown[]> => Promise.all(items.map(item => {
    if (item === 'separator') return PredefinedMenuItem.new({ item: 'Separator' });
    if ('items' in item) return build(item.items).then(items => Submenu.new({ text: item.text, items }));
    if (item.checked !== undefined) return CheckMenuItem.new({ text: item.text, checked: item.checked, enabled: !item.disabled, action: item.action });
    return MenuItem.new({ text: item.text, enabled: !item.disabled, action: item.action });
  }));
  const menu = await Menu.new({ items: await build(spec) });
  await menu.popup(at ? new app.dpi.LogicalPosition(at.x, at.y) : undefined);
  return true;
}
