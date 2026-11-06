import type { Chord, Status } from '../api/types';

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

const GLYPHS: [keyof typeof MODIFIERS, string][] = [['control', '⌃'], ['option', '⌥'], ['shift', '⇧'], ['command', '⌘']];

// macOS virtual key codes by the browser's physical key, with how each reads in a shortcut.
export const KEYS: Record<string, [number, string]> = {
  KeyA: [0, 'A'], KeyS: [1, 'S'], KeyD: [2, 'D'], KeyF: [3, 'F'], KeyH: [4, 'H'], KeyG: [5, 'G'], KeyZ: [6, 'Z'], KeyX: [7, 'X'],
  KeyC: [8, 'C'], KeyV: [9, 'V'], KeyB: [11, 'B'], KeyQ: [12, 'Q'], KeyW: [13, 'W'], KeyE: [14, 'E'], KeyR: [15, 'R'], KeyY: [16, 'Y'],
  KeyT: [17, 'T'], Digit1: [18, '1'], Digit2: [19, '2'], Digit3: [20, '3'], Digit4: [21, '4'], Digit6: [22, '6'], Digit5: [23, '5'],
  Equal: [24, '='], Digit9: [25, '9'], Digit7: [26, '7'], Minus: [27, '-'], Digit8: [28, '8'], Digit0: [29, '0'], BracketRight: [30, ']'],
  KeyO: [31, 'O'], KeyU: [32, 'U'], BracketLeft: [33, '['], KeyI: [34, 'I'], KeyP: [35, 'P'], Enter: [36, '↩'], KeyL: [37, 'L'],
  KeyJ: [38, 'J'], Quote: [39, "'"], KeyK: [40, 'K'], Semicolon: [41, ';'], Backslash: [42, '\\'], Comma: [43, ','], Slash: [44, '/'],
  KeyN: [45, 'N'], KeyM: [46, 'M'], Period: [47, '.'], Tab: [48, '⇥'], Space: [49, 'Space'], Backquote: [50, '`'],
  F1: [122, 'F1'], F2: [120, 'F2'], F3: [99, 'F3'], F4: [118, 'F4'], F5: [96, 'F5'], F6: [97, 'F6'], F7: [98, 'F7'], F8: [100, 'F8'],
  F9: [101, 'F9'], F10: [109, 'F10'], F11: [103, 'F11'], F12: [111, 'F12'], F13: [105, 'F13'], F14: [107, 'F14'], F15: [113, 'F15'], F16: [106, 'F16'],
  Home: [115, '↖'], End: [119, '↘'], PageUp: [116, '⇞'], PageDown: [121, '⇟'], ArrowLeft: [123, '←'], ArrowRight: [124, '→'], ArrowDown: [125, '↓'], ArrowUp: [126, '↑'],
};

/// The modifiers an event holds, by name.
export const held = (event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) => ({ control: event.ctrlKey, option: event.altKey, shift: event.shiftKey, command: event.metaKey });
/// How held modifiers read in a shortcut, in the order ⌃⌥⇧⌘.
export const glyphs = (on: Record<keyof typeof MODIFIERS, boolean>) => GLYPHS.filter(([name]) => on[name]).map(([, glyph]) => glyph).join('');

/// The chord a key press makes, or null while it is not one: a key with ⌘, ⌥ or ⌃ (⇧ alone types a
/// capital), or a function key on its own. Goes by `code`, so another layout's keys act the same.
export function chordOf(event: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): Chord | null {
  const key = KEYS[event.code];
  if (!key) return null;
  const on = held(event);
  if (!on.command && !on.option && !on.control && !/^F\d+$/.test(event.code)) return null;
  const modifiers = GLYPHS.reduce((mask, [name]) => on[name] ? mask | MODIFIERS[name] : mask, 0);
  return { keyCode: key[0], modifiers, label: glyphs(on) + key[1] };
}

// Shortcuts a chord must not take: macOS's own, by the names System Settings gives them, then the ones
// nearly every app has. The app reports which of macOS's are on, with any the person added; a browser
// has only this list.
const { control: CTRL, option: OPT, shift: SHIFT, command: CMD } = MODIFIERS;
export const MACOS_SHORTCUTS: [number, number, string][] = [
  [49, CMD, 'Spotlight'], [49, CMD | OPT, 'Finder search'], [49, CTRL, 'Input sources'], [49, CTRL | OPT, 'Input sources'], [49, CTRL | CMD, 'Emoji & Symbols'],
  [48, CMD, 'Switching apps'], [48, CMD | SHIFT, 'Switching apps'], [50, CMD, 'Switching windows'],
  [20, CMD | SHIFT, 'Screenshots'], [21, CMD | SHIFT, 'Screenshots'], [23, CMD | SHIFT, 'Screenshots'], [20, CTRL | CMD | SHIFT, 'Screenshots'], [21, CTRL | CMD | SHIFT, 'Screenshots'],
  [12, CTRL | CMD, 'Lock Screen'], [12, CMD | SHIFT, 'Log Out'], [53, CMD | OPT, 'Force Quit'], [2, CMD | OPT, 'Show or hide the Dock'],
  [126, CTRL, 'Mission Control'], [125, CTRL, 'App windows'], [123, CTRL, 'Switching spaces'], [124, CTRL, 'Switching spaces'],
];
const APPS: [number, number, string][] = [
  [0, CMD, 'Select All'], [8, CMD, 'Copy'], [9, CMD, 'Paste'], [7, CMD, 'Cut'], [6, CMD, 'Undo'], [6, CMD | SHIFT, 'Redo'], [12, CMD, 'Quit'], [13, CMD, 'Close'],
  [4, CMD, 'Hide'], [4, CMD | OPT, 'Hide Others'], [46, CMD, 'Minimize'], [45, CMD, 'New'], [31, CMD, 'Open'], [35, CMD, 'Print'], [1, CMD, 'Save'],
  [17, CMD, 'New Tab'], [17, CMD | SHIFT, 'Reopen Closed Tab'], [15, CMD, 'Reload'], [37, CMD, 'Open Location'], [3, CMD, 'Find'], [5, CMD, 'Find Next'],
  [11, CMD, 'Bold'], [34, CMD, 'Italic'], [40, CMD, 'Add Link'], [43, CMD, 'Settings'], [3, CTRL | CMD, 'Full screen'],
];
export type Taken = { name: string; chord: Chord; reason?: string };
const taken = ([keyCode, modifiers, name]: [number, number, string]): Taken => ({ name, chord: { keyCode, modifiers, label: name } });
/// Every shortcut a chord must not take, with the name to refuse it by: macOS's own, as the app reports
/// them (a browser has the static list), then the ones nearly every app has.
export function reserved(status: Status | null): Taken[] {
  // One the person added in System Settings has no name here.
  const system = ([keyCode, modifiers]: [number, number]): Taken => {
    const name = MACOS_SHORTCUTS.find(([k, m]) => k === keyCode && m === modifiers)?.[2];
    return name ? taken([keyCode, modifiers, name]) : { ...taken([keyCode, modifiers, 'macOS']), reason: 'macOS already uses this shortcut' };
  };
  const macos = status ? status.systemShortcuts.map(system) : MACOS_SHORTCUTS.map(taken);
  return [...macos, ...APPS.map(taken)];
}
