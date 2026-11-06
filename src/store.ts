import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Chord, ClaudeVia, Patch, PillButton, Settings, Size, Status, StickyHue, UpdateState } from './api/types';
import { invoke, listen } from './bridge';

/// What the connected AI is called on its answer card, and the glyph beside it: Claude by name when it is Claude,
/// otherwise the model the person named, or just AI.
export const aiName = (claude: { via: ClaudeVia; openAiModel: string; localModel: string }) => claude.via === 'openAi' ? claude.openAiModel || 'AI' : claude.via === 'local' ? claude.localModel || 'AI' : 'Claude';
export const aiIcon = (claude: { via: ClaudeVia }): 'claude' | 'agents' => claude.via === 'api' || claude.via === 'claudeCode' ? 'claude' : 'agents';
/// The Mac's own alert sounds, which the cues are chosen from (settings.rs SOUNDS).
export const SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'] as const;
export const SIZES: { value: Size; label: string }[] = [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }];
/// Apps where Return follows the words unless the app's style says otherwise (settings.rs CHAT_APPS).
const CHAT_APPS = ['com.tinyspeck.slackmacgap', 'com.apple.MobileSMS', 'net.whatsapp.WhatsApp', 'com.microsoft.teams2', 'com.microsoft.teams', 'ru.keepcoder.Telegram', 'com.tdesktop.Telegram', 'com.hnc.Discord', 'com.facebook.archon', 'com.signal.desktop'];
export const sendsByDefault = (bundleId: string) => CHAT_APPS.some(chat => chat.toLowerCase() === bundleId.toLowerCase());
/// The buttons the dots' pill can hold, in the pill's order (settings.rs PillButton).
export const PILL_BUTTONS = ['note', 'write', 'sticky', 'meeting', 'library', 'settings'] as const satisfies readonly PillButton[];

/// The whiteboard's hues (boardColor.ts in TabTasker Business), which a sticky is one of.
export const STICKY_HUES = { amber: '#E0A23C', coral: '#DE7468', sage: '#5AA57A', sky: '#4A8CD2', violet: '#8878DC', slate: '#79838F', teal: '#3FA4A0', plum: '#B4629C' } as const satisfies Record<StickyHue, string>;
/// The sticker's sizes, from its menu: the window's points.
export const STICKY_SIZES = { small: [200, 150], medium: [240, 200], large: [320, 260] } as const satisfies Record<Size, readonly [number, number]>;
/// The updates, kept current by dictate-update, which every window hears; null until they arrive.
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void invoke('update_state').then(first => setState(heard => heard ?? first)).catch(() => {});
    return listen('dictate-update', setState);
  }, []);
  return state;
}

// NSEvent modifier flags, as the native side matches them.
export const MODIFIERS = { control: 1 << 18, option: 1 << 19, shift: 1 << 17, command: 1 << 20 } as const;
// F1 to F20, which work as a shortcut on their own.
const FUNCTION_KEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90];

/// Why the store refuses `chord`, or null when it takes it: the same rules as settings.rs (a key with ⌃,
/// ⌥ or ⌘, or a function key alone) plus never a chord `others` already use, said with its `reason` when it has one.
export function chordProblem(chord: Chord, others: { name: string; chord: Chord | null; reason?: string }[] = []): string | null {
  const { control, option, shift, command } = MODIFIERS;
  if (!Number.isInteger(chord.keyCode) || chord.keyCode < 0 || chord.keyCode >= 0x80 || !Number.isInteger(chord.modifiers)
    || chord.modifiers & ~(control | option | shift | command) || typeof chord.label !== 'string' || !chord.label.trim()) return 'That key can’t be a shortcut';
  if (!(chord.modifiers & (control | option | command)) && !FUNCTION_KEYS.includes(chord.keyCode)) return 'Add ⌘, ⌥ or ⌃ to it';
  const taken = others.find(other => other.chord?.keyCode === chord.keyCode && other.chord.modifiers === chord.modifiers);
  return taken ? taken.reason ?? `Already used for “${taken.name}”` : null;
}

/// Something only the person can do: a permission to give, or a model never downloaded or whose last try
/// failed. A model that is merely loading or downloading is not it: that passes on its own.
export const needsSetup = (status: Status) =>
  status.microphone !== 'allowed' || !status.accessibility || !status.enabled || (!status.modelReady && !status.modelPreparing);
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
    listen('dictate-settings', set);
    void invoke('get_settings').then(next => { if (!current) set(next); }).catch(() => {});
  }
  listeners.add(changed);
  return () => { listeners.delete(changed); };
};

/// The settings, or null for the moment before they arrive.
export const useSettings = () => useSyncExternalStore(subscribe, () => current);

/// Saves a change; answers the settings as saved, which may keep an old value the store refused.
export async function updateSettings(patch: Patch): Promise<Settings> {
  const next = await invoke('update_settings', { patch });
  set(next);
  return next;
}
export async function resetSettings(): Promise<Settings> {
  const next = await invoke('reset_settings');
  set(next);
  return next;
}

/// The native status, asked for again every `every` ms while mounted (once when 0).
export function useStatus(every = 0): [Status | null, () => void] {
  const [status, setStatus] = useState<Status | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const ask = () => void invoke('status').then(next => { if (live) setStatus(next); }).catch(() => {});
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
