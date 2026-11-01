// The app in a browser: real settings kept in memory, a sample status, and each feature's own commands
// from its file here. Nothing leaves the page and nothing persists past a reload.
import type { Settings, Status } from '../store';
import { register as input } from './input';
import { register as speech } from './speech';
import { register as notes } from './notes';
import { register as meetings } from './meetings';
import { register as claude } from './claude';
import { register as agents } from './agents';
import { register as stats } from './stats';
import { register as setup } from './setup';
import { register as design } from './design';

export type Handler = (args: Record<string, unknown>) => unknown;
export type Mock = {
  /// Answers `command` in the browser. A later handler replaces an earlier one.
  handle: (command: string, handler: Handler) => void;
  emit: (event: string, payload: unknown) => void;
  settings: () => Settings;
  /// The sample status, which handlers may change (a permission granted, the model ready).
  status: Status;
};

// The same as settings.rs's defaults.
const DEFAULTS: Settings = {
  version: 1,
  shortcuts: { dictate: 'fn', handsFree: true, command: 'control', note: null, meeting: null, pasteLast: null },
  dictation: { language: 'auto', translateToEnglish: false, liveTyping: true, removeFillers: true, sounds: true, model: 'turbo' },
  vocabulary: { words: [], replacements: [], learn: true, suggestions: [] },
  apps: {
    defaultStyle: 'default',
    styles: ([
      ['com.apple.Terminal', 'Terminal', 'code'], ['com.googlecode.iterm2', 'iTerm', 'code'], ['com.mitchellh.ghostty', 'Ghostty', 'code'],
      ['dev.warp.Warp-Stable', 'Warp', 'code'], ['com.microsoft.VSCode', 'Visual Studio Code', 'code'], ['com.todesktop.230313mzl4w4u92', 'Cursor', 'code'],
      ['com.apple.dt.Xcode', 'Xcode', 'code'], ['dev.zed.Zed', 'Zed', 'code'], ['com.apple.MobileSMS', 'Messages', 'casual'],
      ['com.tinyspeck.slackmacgap', 'Slack', 'casual'], ['net.whatsapp.WhatsApp', 'WhatsApp', 'casual'], ['com.hnc.Discord', 'Discord', 'casual'],
      ['com.apple.mail', 'Mail', 'formal'], ['com.microsoft.Outlook', 'Outlook', 'formal'],
    ] as const).map(([bundleId, name, style]) => ({ bundleId, name, style, polish: false })),
  },
  notes: { folder: null, fileName: '{date} {title}', frontmatter: true, dailyNote: false, tags: [], claudeTitle: true, claudeActions: false },
  meetings: { folder: null, systemAudio: true, summarize: true, you: 'You', others: 'Others' },
  claude: { enabled: false, model: 'claude-haiku-5-5', commands: true, claudeCode: null, projectFolder: null },
  agents: { mcp: true, shareHistory: false, shareNotes: true, shareMeetings: true, allowWrite: false },
  history: { keep: 'week' },
  appearance: { theme: 'system', edge: 'bottom', size: 'medium', idle: 'dots', hint: true },
};

const status: Status = {
  enabled: true, microphone: 'allowed', accessibility: true, modelReady: true, modelPreparing: false, modelMessage: '',
  notes: '/Users/you/Documents/TabTasker Dictate', home: '/Users/you', globeKey: '', openAtLogin: true,
  inputs: [{ id: 'built-in', name: 'MacBook Pro Microphone' }, { id: 'airpods', name: 'AirPods Pro' }], input: null, inputInUse: 'MacBook Pro Microphone',
};
// `?status=new` starts as a Mac that has never been set up, for the setup flow.
if (new URLSearchParams(location.search).get('status') === 'new') Object.assign(status, { enabled: false, microphone: 'notDetermined', accessibility: false, modelReady: false });

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let settings = copy(DEFAULTS);
const merge = (base: unknown, patch: unknown): unknown => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !base || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) if (key in out) out[key] = merge(out[key], value);
  return out;
};

const handlers = new Map<string, Handler>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach(handler => handler(copy(payload)));
const mock: Mock = { handle: (command, handler) => handlers.set(command, handler), emit, settings: () => copy(settings), status };

const changed = () => { emit('dictate-settings', settings); return copy(settings); };
mock.handle('get_settings', () => copy(settings));
mock.handle('update_settings', ({ patch }) => { settings = { ...(merge(settings, patch) as Settings), version: 1 }; return changed(); });
mock.handle('reset_settings', () => { settings = copy(DEFAULTS); return changed(); });
mock.handle('status', () => copy(status));
mock.handle('set_enabled', ({ enabled }) => {
  status.enabled = !!enabled;
  if (!enabled) { Object.assign(status, { modelReady: false, modelPreparing: false, modelMessage: 'Voice is off. Your local model is kept for next time.' }); return; }
  // A download that finishes in a few seconds.
  let percent = 0;
  Object.assign(status, { modelPreparing: true, modelReady: false });
  const timer = setInterval(() => {
    percent = Math.min(100, percent + 17);
    status.modelMessage = `Downloading Whisper · ${percent}%`;
    if (percent === 100) { clearInterval(timer); Object.assign(status, { modelPreparing: false, modelReady: true, modelMessage: 'Whisper large-v3 Turbo · automatic language detection · audio stays on this Mac' }); }
  }, 600);
});
mock.handle('set_input', ({ id }) => { status.input = (id as string | null) ?? null; status.inputInUse = status.inputs.find(input => input.id === id)?.name ?? status.inputs[0].name; });
mock.handle('set_open_at_login', ({ enabled }) => (status.openAtLogin = !!enabled));
mock.handle('request', ({ kind }) => {
  if (kind === 'microphone') status.microphone = 'allowed';
  if (kind === 'accessibility') status.accessibility = true;
});
mock.handle('layout', () => {});
mock.handle('meeting', () => false);
mock.handle('open_settings', ({ route }) => { open(`/settings.html${location.search}#${typeof route === 'string' ? route : 'general'}`, '_blank'); });
mock.handle('paste_last', () => emit('dictate-notice', { message: 'Nothing to paste yet' }));
mock.handle('save_note', ({ title, stamp }) => `${status.notes}/${stamp} ${title || 'Note'}.md`);
mock.handle('show_notes', () => {});
mock.handle('plugin:app|version', () => '0.1.0');

for (const register of [input, speech, notes, meetings, claude, agents, stats, setup, design]) register(mock);

export async function invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = handlers.get(command);
  if (!handler) throw new Error(`${command} is not in the browser mock`);
  return handler(args);
}

export async function listen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  set.add(handler);
  return () => { set.delete(handler); };
}
