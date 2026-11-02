import { useEffect, useState, useSyncExternalStore } from 'react';
import { invoke, listen } from './bridge';

// The settings, as settings.rs keeps them (settings.json in the app data folder).
export type Chord = { keyCode: number; modifiers: number; label: string };
export type Style = 'default' | 'casual' | 'formal' | 'code' | 'raw';
export type DictateKey = 'fn' | 'rightCommand' | 'rightOption' | 'rightControl' | 'rightShift';
export type CommandKey = 'control' | 'option' | 'command' | 'shift' | 'off';
export type ClaudeModel = 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5';
export type Keep = 'off' | 'day' | 'week' | 'month' | 'forever';
export type Theme = 'system' | 'light' | 'dark';
export type Edge = 'bottom' | 'left' | 'right';
export type Size = 'small' | 'medium' | 'large';
export type AppStyle = { bundleId: string; name: string; style: Style; polish: boolean };
export type Settings = {
  version: 1;
  general: { menuBarIcon: boolean };
  shortcuts: { dictate: DictateKey; handsFree: boolean; command: CommandKey; note: Chord | null; meeting: Chord | null; pasteLast: Chord | null };
  dictation: { language: string; translateToEnglish: boolean; liveTyping: boolean; removeFillers: boolean; sounds: boolean; model: 'turbo' | 'small' };
  vocabulary: { words: string[]; replacements: { from: string; to: string }[]; learn: boolean; suggestions: string[] };
  apps: { styles: AppStyle[]; defaultStyle: Style };
  notes: { folder: string | null; fileName: string; frontmatter: boolean; dailyNote: boolean; tags: string[]; claudeTitle: boolean; claudeActions: boolean };
  meetings: { folder: string | null; systemAudio: boolean; summarize: boolean; you: string; others: string };
  claude: { enabled: boolean; model: ClaudeModel; commands: boolean; claudeCode: string | null; projectFolder: string | null };
  agents: { mcp: boolean; shareHistory: boolean; shareNotes: boolean; shareMeetings: boolean; allowWrite: boolean };
  history: { keep: Keep };
  appearance: { theme: Theme; edge: Edge; size: Size; idle: 'dots' | 'hidden'; hint: boolean };
};

// The events pages hear, besides the native voice code's own, with what each carries.
export type HoldMode = 'dictate' | 'note' | 'command' | 'handsfree';
export type HistoryEntry = { atMs: number; mode: HoldMode; bundleId: string; appName: string; words: number; seconds: number; text: string };
export type Events = {
  'dictate-settings': Settings;
  'dictate-command': { request: string; phase: 'thinking' | 'answer' | 'error'; text?: string; instruction?: string };
  'dictate-meeting': { state: 'recording' | 'saving' | 'saved' | 'error'; since?: number; path?: string; message?: string };
  'dictate-hands-free': { locked: boolean };
  'dictate-history': { entry: HistoryEntry };
  'dictate-learned': { word: string };
};

// NSEvent modifier flags, as the native side matches them.
export const MODIFIERS = { control: 1 << 18, option: 1 << 19, shift: 1 << 17, command: 1 << 20 } as const;
// F1 to F20, which work as a shortcut on their own.
const FUNCTION_KEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90];

/// Why the store refuses `chord`, or null when it takes it: the same rules as settings.rs (a key with ⌃,
/// ⌥ or ⌘, or a function key alone) plus never a chord `others` already use.
export function chordProblem(chord: Chord, others: { name: string; chord: Chord | null }[] = []): string | null {
  const { control, option, shift, command } = MODIFIERS;
  if (!Number.isInteger(chord.keyCode) || chord.keyCode < 0 || chord.keyCode >= 0x80 || !Number.isInteger(chord.modifiers)
    || chord.modifiers & ~(control | option | shift | command) || typeof chord.label !== 'string' || !chord.label.trim()) return 'That key can’t be a shortcut';
  if (!(chord.modifiers & (control | option | command)) && !FUNCTION_KEYS.includes(chord.keyCode)) return 'Add ⌘, ⌥ or ⌃ to it';
  const taken = others.find(other => other.chord?.keyCode === chord.keyCode && other.chord.modifiers === chord.modifiers);
  return taken ? `Already used for “${taken.name}”` : null;
}

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
/// Any part of the settings: objects merge, lists and values replace.
export type Patch = DeepPartial<Settings>;

// What the native side reports: permissions, the model, the microphones.
export type Status = {
  enabled: boolean; microphone: 'allowed' | 'notDetermined' | 'denied'; accessibility: boolean;
  modelReady: boolean; modelPreparing: boolean; modelMessage: string; notes: string; openAtLogin?: boolean;
  // What "Press 🌐 key to" does instead of nothing: it competes with holding fn.
  globeKey: '' | 'inputSource' | 'emoji' | 'dictation';
  inputs: { id: string; name: string }[]; input: string | null; inputInUse: string;
  home?: string; // the home folder, for paths written with ~
  firstRun?: boolean; // this launch is the first and opened the full setup in Settings
};
export const setupDone = (status: Status | null) =>
  !!status && status.enabled && status.microphone === 'allowed' && status.accessibility && status.modelReady;

// One copy of the settings for the whole page, kept current by dictate-settings from every window.
let current: Settings | null = null;
const listeners = new Set<() => void>();
let started = false;
const set = (next: Settings) => { current = next; listeners.forEach(changed => changed()); };
const subscribe = (changed: () => void) => {
  if (!started) {
    started = true;
    listen<Settings>('dictate-settings', set);
    void invoke<Settings>('get_settings').then(next => { if (!current) set(next); }).catch(() => {});
  }
  listeners.add(changed);
  return () => { listeners.delete(changed); };
};

/// The settings, or null for the moment before they arrive.
export const useSettings = () => useSyncExternalStore(subscribe, () => current);

/// Saves a change; answers the settings as saved, which may keep an old value the store refused.
export async function updateSettings(patch: Patch): Promise<Settings> {
  const next = await invoke<Settings>('update_settings', { patch });
  set(next);
  return next;
}
export async function resetSettings(): Promise<Settings> {
  const next = await invoke<Settings>('reset_settings');
  set(next);
  return next;
}

/// The native status, asked for again every `every` ms while mounted (once when 0).
export function useStatus(every = 0): [Status | null, () => void] {
  const [status, setStatus] = useState<Status | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const ask = () => void invoke<Status>('status').then(next => { if (live) setStatus(next); }).catch(() => {});
    ask();
    const timer = every ? setInterval(ask, every) : undefined;
    addEventListener('focus', ask);
    return () => { live = false; clearInterval(timer); removeEventListener('focus', ask); };
  }, [every, tick]);
  return [status, () => setTick(t => t + 1)];
}

/// A folder typed by hand: a full path, or one in the home folder written with ~. Null for empty (the
/// default folder); undefined when it is neither.
export function folderPath(typed: string, home: string | undefined): string | null | undefined {
  const path = typed.trim();
  if (!path) return null;
  if (path.startsWith('/')) return path;
  if (home && (path === '~' || path.startsWith('~/'))) return home + path.slice(1);
  return undefined;
}
/// `path` with the home folder written as ~.
export const tilde = (path: string, home: string | undefined) => home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/// What every settings page gets: the settings and a way to change them. `update` shows its own errors
/// and answers the settings as saved, or undefined when saving failed.
export type PageProps = { settings: Settings; update: (patch: Patch) => Promise<Settings | undefined> };
