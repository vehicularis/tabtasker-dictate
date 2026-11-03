// The app in a browser: real settings kept in memory, a sample status, and each feature's own commands
// from its file here. Nothing leaves the page and nothing persists past a reload.
import { chordProblem, PILL_BUTTONS, SOUNDS, STICKY_HUES, type Chord, type Settings, type Status, type Sticky } from '../store';
import { register as input } from './input';
import { register as speech } from './speech';
import { register as notes } from './notes';
import { register as meetings } from './meetings';
import { register as claude } from './claude';
import { register as agents } from './agents';
import { register as stats } from './stats';
import { register as setup } from './setup';
import { register as design } from './design';

type Handler = (args: Record<string, unknown>) => unknown;
export type Mock = {
  /// Answers `command` in the browser. A later handler replaces an earlier one.
  handle: (command: string, handler: Handler) => void;
  /// The handler `command` has now, for a later one that adds to it rather than replacing it.
  handled: (command: string) => Handler | undefined;
  emit: (event: string, payload: unknown) => void;
  settings: () => Settings;
  /// A change from a feature's own mock, as settings.rs's `update`: the store's rules, and it can turn Claude on.
  update: (patch: unknown) => Settings;
  /// The sample status, which handlers may change (a permission granted, the model ready).
  status: Status;
};

// The same as settings.rs's defaults.
const DEFAULTS: Settings = {
  version: 1,
  general: { menuBarIcon: true, showInDock: false },
  shortcuts: { dictate: 'fn', handsFree: true, command: 'control', note: null, meeting: null, pasteLast: null, writeNote: null, sticky: null, ask: null },
  dictation: { language: 'auto', translateToEnglish: false, removeFillers: true, sounds: true, soundVolume: 0.3, startSound: 'Tink', stopSound: 'Pop', model: 'turbo' },
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
  meetings: { folder: null, systemAudio: true, summarize: true, you: 'You', others: 'Others', speakers: true, decisions: true, actionItems: true },
  claude: { enabled: false, via: 'api', model: 'claude-haiku-5-5', effort: 'medium', commands: true, claudeCode: null, localEndpoint: 'http://localhost:11434', localModel: 'llama3.2' },
  agents: { mcp: true, shareHistory: false, shareNotes: true, shareMeetings: true, allowWrite: false },
  history: { keep: 'week' },
  appearance: { theme: 'system', edge: 'right', size: 'medium', idle: 'dots', hint: true, pill: ['note', 'write', 'sticky', 'meeting', 'library', 'settings'], margin: 8, avoidDock: true },
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

// ---------- the store's rules, as settings.rs keeps them, so a page sees the same refusals here ----------
type Check = (value: unknown) => boolean;
const LANGUAGES = new Set(('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn '
  + 'sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue').split(' '));
const STYLES = ['default', 'casual', 'formal', 'code', 'raw'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bool: Check = value => typeof value === 'boolean';
const text: Check = value => typeof value === 'string';
const oneOf = (...choices: string[]): Check => value => choices.includes(value as string);
const listOf = (item: Check): Check => value => Array.isArray(value) && value.every(item);
const folder: Check = value => value === null || (typeof value === 'string' && value.startsWith('/') && !value.includes('\0'));
const chord: Check = value => value === null || (object(value) && chordProblem(value as Chord) === null);
const SCHEMA: Record<string, Record<string, Check>> = {
  general: { menuBarIcon: bool, showInDock: bool },
  shortcuts: { dictate: oneOf('fn', 'rightCommand', 'rightOption', 'rightControl', 'rightShift'), handsFree: bool, command: oneOf('control', 'option', 'command', 'shift', 'off'), note: chord, meeting: chord, pasteLast: chord, writeNote: chord, sticky: chord, ask: chord },
  dictation: { language: value => value === 'auto' || LANGUAGES.has(value as string), translateToEnglish: bool, removeFillers: bool, sounds: bool,
    soundVolume: value => typeof value === 'number' && Number.isFinite(value), startSound: oneOf(...SOUNDS), stopSound: oneOf(...SOUNDS), model: oneOf('turbo', 'small') },
  vocabulary: { words: listOf(text), replacements: listOf(pair => object(pair) && text(pair.from) && text(pair.to)), learn: bool, suggestions: listOf(text) },
  apps: { styles: listOf(app => object(app) && text(app.bundleId) && text(app.name) && STYLES.includes(app.style as string) && (app.polish === undefined || bool(app.polish)) && (app.send == null || bool(app.send))), defaultStyle: oneOf(...STYLES) },
  notes: { folder, fileName: value => typeof value === 'string' && !/[/:\0]/.test(value) && !value.trimStart().startsWith('.'), frontmatter: bool, dailyNote: bool, tags: listOf(text), claudeTitle: bool, claudeActions: bool },
  meetings: { folder, systemAudio: bool, summarize: bool, you: text, others: text, speakers: bool, decisions: bool, actionItems: bool },
  claude: { enabled: bool, via: oneOf('api', 'claudeCode', 'local'), model: oneOf('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'), effort: oneOf('low', 'medium', 'high'), commands: bool, claudeCode: folder, localEndpoint: text, localModel: text },
  agents: { mcp: bool, shareHistory: bool, shareNotes: bool, shareMeetings: bool, allowWrite: bool },
  history: { keep: oneOf('off', 'day', 'week', 'month', 'forever') },
  appearance: { theme: oneOf('system', 'light', 'dark'), edge: oneOf('bottom', 'left', 'right'), size: oneOf('small', 'medium', 'large'), idle: oneOf('dots', 'hidden'), hint: bool,
    pill: value => Array.isArray(value) && value.length > 0 && value.every(button => (PILL_BUTTONS as readonly unknown[]).includes(button)), margin: value => typeof value === 'number' && value >= 0 && value <= 120, avoidDock: bool },
};
const valid = (next: Settings) => {
  const sections = next as unknown as Record<string, Record<string, unknown>>;
  const shapes = Number.isInteger(next.version) && Object.entries(SCHEMA).every(([section, fields]) => object(sections[section]) && Object.entries(fields).every(([field, check]) => check(sections[section][field])));
  const { note, meeting, pasteLast } = next.shortcuts;
  return shapes && [note, meeting, pasteLast].every((one, i, all) => !one || all.slice(0, i).every(other => !other || other.keyCode !== one.keyCode || other.modifiers !== one.modifiers));
};
const put = (base: Settings, path: string[], value: unknown) => {
  const trial = copy(base) as unknown as Record<string, Record<string, unknown>>;
  if (path.length === 1) (trial as Record<string, unknown>)[path[0]] = value; else trial[path[0]][path[1]] = value;
  return trial as unknown as Settings;
};
const clip = (value: string, max: number) => [...value.trim()].slice(0, max).join('');
const clipList = (list: string[], items: number, chars: number) => {
  const seen = new Set<string>();
  return list.map(item => clip(item, chars)).filter(item => item && !seen.has(item.toLowerCase()) && seen.add(item.toLowerCase())).slice(0, items);
};
const clamp = (next: Settings): Settings => {
  next.version = 1;
  const { vocabulary, apps, notes, meetings, shortcuts } = next;
  vocabulary.words = clipList(vocabulary.words, 500, 64);
  vocabulary.suggestions = clipList(vocabulary.suggestions, 500, 64);
  vocabulary.replacements = vocabulary.replacements.map(pair => ({ from: clip(pair.from, 200), to: clip(pair.to, 200) })).filter(pair => pair.from).slice(0, 500);
  const seen = new Set<string>();
  apps.styles = apps.styles.map(app => ({ ...app, bundleId: clip(app.bundleId, 200), name: clip(app.name, 200), polish: app.polish ?? false }))
    .filter(app => app.bundleId && !seen.has(app.bundleId.toLowerCase()) && seen.add(app.bundleId.toLowerCase())).slice(0, 500);
  notes.tags = clipList(notes.tags, 50, 64);
  notes.fileName = clip(notes.fileName, 200) || DEFAULTS.notes.fileName;
  meetings.you = clip(meetings.you, 64) || DEFAULTS.meetings.you;
  meetings.others = clip(meetings.others, 64) || DEFAULTS.meetings.others;
  for (const one of [shortcuts.note, shortcuts.meeting, shortcuts.pasteLast]) if (one) one.label = clip(one.label, 16);
  return next;
};
/// settings.rs's `patched`: each setting tried on its own, a refused one keeping its old value, a list
/// keeping the entries that are fine alone, unknown keys ignored, then lengths clamped.
const patched = (base: Settings, patch: unknown): Settings => {
  let good = copy(base);
  const leaves: [string[], unknown][] = [];
  if (object(patch)) for (const [key, value] of Object.entries(patch)) {
    const known = (good as unknown as Record<string, unknown>)[key];
    if (known === undefined) continue;
    if (object(value) && object(known)) { for (const [field, leaf] of Object.entries(value)) if (field in known) leaves.push([[key, field], leaf]); }
    else leaves.push([[key], value]);
  }
  for (const [path, value] of leaves) {
    const trial = put(good, path, value);
    if (valid(trial)) { good = trial; continue; }
    if (!Array.isArray(value)) continue;
    const kept = value.filter(item => valid(put(good, path, [item])));
    const fewer = put(good, path, kept);
    if (valid(fewer)) good = fewer;
  }
  return clamp(good);
};

const handlers = new Map<string, Handler>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach(handler => handler(copy(payload)));
const changed = () => { emit('dictate-settings', settings); return copy(settings); };
const mock: Mock = { handle: (command, handler) => handlers.set(command, handler), handled: command => handlers.get(command), emit, settings: () => copy(settings), status, update: patch => { settings = patched(settings, patch); return changed(); } };

mock.handle('get_settings', () => copy(settings));
mock.handle('update_settings', ({ patch }) => {
  if (!object(patch)) throw 'Invalid settings';
  const request = copy(patch);
  if (object(request.claude)) { delete request.claude.enabled; delete request.claude.via; } // only the app turns Claude on, once a connection is tested
  return mock.update(request);
});
mock.handle('reset_settings', () => { settings = { ...copy(DEFAULTS), claude: { ...copy(DEFAULTS.claude), enabled: settings.claude.enabled } }; return changed(); });
mock.handle('status', () => copy(status));
mock.handle('play_sound', () => {}); // a browser has none of the Mac's sounds
// Stickies, in memory: `?sticky=<id>` is one for the sticky page to show.
const folderOf = () => settings.notes.folder ?? status.notes;
const stickies: Sticky[] = [{ id: 'demo', text: 'Call the venue about Thursday', hue: 'amber', x: 120, y: 140, width: 240, height: 200, pinned: true, folded: false, closed: false, archived: false, createdMs: Date.now(), updatedMs: Date.now() },
  { id: 'list', text: 'Groceries\n- milk\n- coffee', hue: 'sage', x: 380, y: 160, width: 240, height: 200, pinned: false, folded: false, closed: true, archived: false, createdMs: Date.now() - 86_400_000, updatedMs: Date.now() - 86_400_000 },
  { id: 'old', text: 'Book the dentist', hue: 'sky', x: 200, y: 260, width: 240, height: 200, pinned: true, folded: false, closed: true, archived: true, createdMs: Date.now() - 9 * 86_400_000, updatedMs: Date.now() - 9 * 86_400_000 }].filter(() => new URLSearchParams(location.search).get('stickies') !== 'empty') as Sticky[];
for (const one of stickies) Object.assign(one, one.id === 'demo' ? { title: 'Venue', titled: true, tilt: 'slight', weight: 'bold' } : { title: '', titled: false, tilt: 'none', weight: 'bold' });
const stickyHue = (hue: unknown): Sticky['hue'] => (typeof hue === 'string' && hue in STICKY_HUES ? hue : 'amber') as Sticky['hue'];
mock.handle('sticky_list', () => copy(stickies));
mock.handle('sticky_get', ({ id }) => { const found = stickies.find(one => one.id === id) ?? stickies[0]; if (!found) throw 'That sticky is gone.'; return copy(found); });
mock.handle('sticky_new', ({ hue, text }) => {
  const last = stickies.at(-1);
  const made: Sticky = { id: Math.random().toString(16).slice(2, 14), text: typeof text === 'string' ? text : '', hue: stickyHue(hue ?? ['amber', 'sky', 'sage', 'coral', 'violet', 'teal'][stickies.length % 6]), x: (last?.x ?? 92) + 28, y: (last?.y ?? 112) + 28, width: last?.width ?? 240, height: last?.height ?? 200, pinned: true, folded: false, closed: false, title: '', titled: last?.titled ?? false, tilt: last?.tilt ?? 'none', weight: last?.weight ?? 'bold', archived: false, createdMs: Date.now(), updatedMs: Date.now() };
  stickies.push(made); emit('dictate-stickies', { count: stickies.length }); return copy(made);
});
mock.handle('sticky_update', ({ id, text, hue, title, titled, tilt, weight }) => { const found = stickies.find(one => one.id === id); if (!found) throw 'That sticky is gone.'; if (typeof text === 'string') found.text = text; if (hue) found.hue = stickyHue(hue); if (typeof title === 'string') found.title = title; if (typeof titled === 'boolean') found.titled = titled; if (tilt === 'none' || tilt === 'slight' || tilt === 'random') found.tilt = tilt; if (weight === 'regular' || weight === 'bold') found.weight = weight; found.updatedMs = Date.now(); return copy(found); });
mock.handle('sticky_size', ({ id, width, height }) => { const found = stickies.find(one => one.id === id); if (!found) throw 'That sticky is gone.'; found.width = Number(width); found.height = Number(height); return copy(found); });
const stickyChange = (id: unknown, edit: (one: Sticky) => void) => { const found = stickies.find(one => one.id === id); if (!found) throw 'That sticky is gone.'; edit(found); emit('dictate-stickies', { count: stickies.length }); };
mock.handle('sticky_show', ({ id }) => stickyChange(id, one => { one.closed = false; one.archived = false; }));
mock.handle('sticky_close', ({ id }) => stickyChange(id, one => { one.closed = true; }));
mock.handle('sticky_archive', ({ id, archived }) => stickyChange(id, one => { one.archived = !!archived; one.closed = true; }));
mock.handle('sticky_watch', () => {});
mock.handle('sticky_hold', () => {});
mock.handle('sticky_pin', ({ id, pinned }) => { const found = stickies.find(one => one.id === id); if (!found) throw 'That sticky is gone.'; found.pinned = !!pinned; return copy(found); });
mock.handle('sticky_fold', ({ id, folded }) => { const found = stickies.find(one => one.id === id); if (!found) throw 'That sticky is gone.'; found.folded = !!folded; return copy(found); });
mock.handle('sticky_remove', ({ id }) => { const at = stickies.findIndex(one => one.id === id); if (at >= 0) stickies.splice(at, 1); emit('dictate-stickies', { count: stickies.length }); });
mock.handle('sticky_to_note', ({ id }) => { const at = stickies.findIndex(one => one.id === id); if (at < 0) throw 'That sticky is gone.'; const [gone] = stickies.splice(at, 1); return `${folderOf()}/${gone.text.split('\n')[0].slice(0, 40)}.md`; });
mock.handle('set_enabled', ({ enabled }) => {
  status.enabled = !!enabled;
  if (!enabled) { Object.assign(status, { modelReady: false, modelPreparing: false, modelMessage: 'Dictation is paused. The speech model stays on this Mac.' }); return; }
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
mock.handle('open_app', ({ route }) => { open(`/app.html${location.search}#${typeof route === 'string' ? route : 'notes'}`, '_blank'); });
mock.handle('paste_last', () => emit('dictate-notice', { message: 'Nothing to paste yet' }));
mock.handle('quit', () => emit('dictate-notice', { message: 'Quit (in the app, it would)' }));
mock.handle('open_site', ({ url }) => { window.open(url as string, '_blank', 'noopener'); });
mock.handle('save_note', ({ title, stamp }) => `${status.notes}/${stamp} ${title || 'Note'}.md`);
mock.handle('show_notes', () => {});
mock.handle('plugin:app|version', () => '0.1.0');

// Input goes last: its `request` adds Send and Cancel to the permission answers setup gives.
for (const register of [speech, notes, meetings, claude, agents, stats, setup, design, input]) register(mock);

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
