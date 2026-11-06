import type { AgentsStatus, AppInfo, Folder, HistoryEntry, HistoryStats, LibraryItem, MeetingState, Models, NoteDoc, Patch, Preview, Settings, Status, Sticky, StickyHue, StickyTilt, StickyWeight, UpdateState } from './types';

/// What `request` accepts (commands.rs); anything else is refused with "Unknown request".
export type RequestKind = 'microphone' | 'accessibility' | 'keyboard' | 'note' | 'send' | 'cancel';

/// Every command the page can call: the arguments it takes (Tauri's camelCase for Rust's snake_case; `Option<T>` is
/// optional and may be null) and what it answers. A `Result<T, String>` answers `T` and rejects with the string.
/// `void` args means none. The names are `generate_handler!`'s in lib.rs, plus Tauri's own app plugin.
export interface Commands {
  // The app and the shell (app/commands.rs)
  quit: { args: void; result: void };
  open_site: { args: { url: string }; result: void };
  status: { args: void; result: Status };
  set_enabled: { args: { enabled: boolean }; result: void };
  set_input: { args: { id?: string | null }; result: void };
  set_open_at_login: { args: { enabled: boolean }; result: boolean };
  request: { args: { kind: RequestKind }; result: void };
  /// Where the overlay draws glass (x, y, width, height, radius, opacity) and which parts take clicks (x, y, width, height); at most 16 of each.
  layout: { args: { glass: [number, number, number, number, number, number][]; hit: [number, number, number, number][]; dark?: boolean | null }; result: void };
  /// Starts or stops a meeting; false when nothing changed.
  meeting: { args: { action: 'start' | 'stop' }; result: boolean };
  open_app: { args: { route?: string | null }; result: void };
  paste_last: { args: void; result: void };
  play_sound: { args: { name: string; volume: number }; result: void };
  note_open: { args: { path: string }; result: void };
  // Notes (library/notes.rs)
  save_note: { args: { title: string; text: string; stamp: string; named?: boolean | null }; result: string };
  show_notes: { args: { file?: string | null }; result: void };
  notes_folder: { args: void; result: Folder };
  preview_note: { args: { notes: Settings['notes']; title: string; body: string; actions?: string | null; stamp: string }; result: Preview };
  /// The folder the person picked, or null when they cancelled.
  choose_folder: { args: { message?: string | null; start?: string | null }; result: string | null };
  library_list: { args: void; result: LibraryItem[] };
  library_open: { args: { path: string }; result: void };
  note_read: { args: { path: string }; result: NoteDoc };
  /// The file's modified time, in ms.
  note_write: { args: { path: string; title: string; body: string }; result: number };
  note_new: { args: { title: string; text: string; stamp: string }; result: string };
  note_delete: { args: { path: string }; result: void };
  /// Saves a picture beside the note (`data` is base64); answers where it is.
  note_attach: { args: { path: string; name: string; data: string }; result: string };
  /// Answers the note's new path.
  note_archive: { args: { path: string; archived: boolean }; result: string };
  // Stickies (library/stickies.rs)
  sticky_list: { args: void; result: Sticky[] };
  sticky_get: { args: { id: string }; result: Sticky };
  sticky_new: { args: { hue?: StickyHue | null; text?: string | null }; result: Sticky };
  sticky_update: { args: { id: string; text?: string | null; hue?: StickyHue | null; title?: string | null; titled?: boolean | null; tilt?: StickyTilt | null; weight?: StickyWeight | null }; result: Sticky };
  sticky_size: { args: { id: string; width: number; height: number }; result: Sticky };
  sticky_remove: { args: { id: string }; result: void };
  /// Answers the note's path.
  sticky_to_note: { args: { id: string; stamp: string }; result: string };
  sticky_show: { args: { id: string }; result: void };
  sticky_close: { args: { id: string }; result: void };
  sticky_archive: { args: { id: string; archived: boolean }; result: void };
  sticky_pin: { args: { id: string; pinned: boolean }; result: Sticky };
  sticky_fold: { args: { id: string; folded: boolean }; result: Sticky };
  sticky_watch: { args: { id: string; pillWidth: number }; result: void };
  sticky_hold: { args: { id: string; hold: boolean }; result: void };
  // The settings (settings.rs)
  get_settings: { args: void; result: Settings };
  update_settings: { args: { patch: Patch }; result: Settings };
  reset_settings: { args: void; result: Settings };
  // Speech, apps and history
  speech_models: { args: void; result: Models };
  prepare_model: { args: void; result: void };
  /// How many of `words` the speech model can listen for.
  vocabulary_fit: { args: { words: string[] }; result: number };
  list_apps: { args: { known: string[] }; result: AppInfo[] };
  history_list: { args: void; result: HistoryEntry[] };
  history_stats: { args: void; result: HistoryStats };
  history_delete: { args: { at: number }; result: void };
  history_clear: { args: void; result: void };
  history_type: { args: { at: number }; result: void };
  // Claude and agents (ai/). What answers the settings is heard on dictate-settings, so callers ignore it.
  claude_save_key: { args: { key: string }; result: Settings };
  /// How long the test answer took, in ms.
  claude_test: { args: void; result: number };
  claude_remove_key: { args: void; result: Settings };
  claude_open_console: { args: void; result: void };
  claude_insert: { args: { request: string; text: string }; result: void };
  claude_dismiss: { args: { request: string }; result: void };
  claude_code_find: { args: void; result: string | null };
  claude_code_set: { args: { path?: string | null }; result: Settings };
  claude_connect_code: { args: void; result: Settings };
  claude_connect_local: { args: { endpoint: string; model: string }; result: Settings };
  claude_connect_open_ai: { args: { endpoint: string; key: string; model: string }; result: Settings };
  claude_disconnect: { args: void; result: Settings };
  /// Registered, though no page asks yet; answers the request id its dictate-command events carry.
  claude_ask: { args: { question: string }; result: string };
  agents_status: { args: void; result: AgentsStatus };
  agents_add: { args: { target: 'claudeCode' | 'claudeDesktop' }; result: AgentsStatus };
  // Meetings and updates
  meeting_state: { args: void; result: MeetingState };
  meeting_recover: { args: { id: string; save: boolean }; result: void };
  meeting_reveal: { args: { path: string }; result: void };
  meeting_privacy: { args: void; result: void };
  update_state: { args: void; result: UpdateState };
  update_check: { args: { tell: boolean }; result: UpdateState };
  update_restart: { args: void; result: void };
  /// Tauri's own app plugin, which is not in lib.rs: the version running.
  'plugin:app|version': { args: void; result: string };
}

/// The rest of `invoke`'s arguments for `K`: none when the command takes none, optional when every argument is, else required.
export type CommandArgs<K extends keyof Commands> = [Commands[K]['args']] extends [void] ? [] : {} extends Commands[K]['args'] ? [args?: Commands[K]['args']] : [args: Commands[K]['args']];

// Listing a name more or less than `Commands` has is a compile error, so this is exactly the set the type holds.
const listed = {
  quit: 0, open_site: 0, status: 0, set_enabled: 0, set_input: 0, set_open_at_login: 0, request: 0, layout: 0, meeting: 0, open_app: 0, paste_last: 0, play_sound: 0, note_open: 0,
  save_note: 0, show_notes: 0, notes_folder: 0, preview_note: 0, choose_folder: 0, library_list: 0, library_open: 0, note_read: 0, note_write: 0, note_new: 0, note_delete: 0, note_attach: 0, note_archive: 0,
  sticky_list: 0, sticky_get: 0, sticky_new: 0, sticky_update: 0, sticky_size: 0, sticky_remove: 0, sticky_to_note: 0, sticky_show: 0, sticky_close: 0, sticky_archive: 0, sticky_pin: 0, sticky_fold: 0, sticky_watch: 0, sticky_hold: 0,
  get_settings: 0, update_settings: 0, reset_settings: 0,
  speech_models: 0, prepare_model: 0, vocabulary_fit: 0, list_apps: 0, history_list: 0, history_stats: 0, history_delete: 0, history_clear: 0, history_type: 0,
  claude_save_key: 0, claude_test: 0, claude_remove_key: 0, claude_open_console: 0, claude_insert: 0, claude_dismiss: 0, claude_code_find: 0, claude_code_set: 0, claude_connect_code: 0, claude_connect_local: 0, claude_connect_open_ai: 0, claude_disconnect: 0, claude_ask: 0,
  agents_status: 0, agents_add: 0,
  meeting_state: 0, meeting_recover: 0, meeting_reveal: 0, meeting_privacy: 0, update_state: 0, update_check: 0, update_restart: 0,
  'plugin:app|version': 0,
} satisfies Record<keyof Commands, 0>;
/// The command names at run time, for the contract test against lib.rs.
export const COMMANDS = Object.keys(listed) as (keyof Commands)[];
