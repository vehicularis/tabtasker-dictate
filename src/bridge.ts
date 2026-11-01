// The Tauri global (withGlobalTauri): the app's commands and the native voice code's events.
type Tauri = {
  core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: { listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> };
};
const tauri = () => (window as unknown as { __TAURI__?: Tauri }).__TAURI__;

export const invoke = <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> =>
  tauri()?.core.invoke(command, args) as Promise<T> ?? Promise.reject(new Error('Not in the app'));

export function listen<T>(name: string, handler: (payload: T) => void): () => void {
  let off: (() => void) | undefined, gone = false;
  void tauri()?.event.listen(name, event => handler(event.payload as T)).then(unlisten => { if (gone) unlisten(); else off = unlisten; });
  return () => { gone = true; off?.(); };
}
