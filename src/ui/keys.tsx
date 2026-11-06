import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { chordProblem, MODIFIERS } from '../store';
import type { Chord } from '../api/types';
import { Icon } from './Icon';

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="ui-kbd">{children}</kbd>;

const GLYPHS: [keyof typeof MODIFIERS, string][] = [['control', '⌃'], ['option', '⌥'], ['shift', '⇧'], ['command', '⌘']];

// macOS virtual key codes by the browser's physical key, with how each reads in a shortcut.
const KEYS: Record<string, [number, string]> = {
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

const held = (event: KeyboardEvent) => ({ control: event.ctrlKey, option: event.altKey, shift: event.shiftKey, command: event.metaKey });
const glyphs = (on: Record<keyof typeof MODIFIERS, boolean>) => GLYPHS.filter(([name]) => on[name]).map(([, glyph]) => glyph).join('');

/// The chord a key press makes, or null while it is not one: a key with ⌘, ⌥ or ⌃ (⇧ alone types a
/// capital), or a function key on its own.
export function chordOf(event: KeyboardEvent): Chord | null {
  const key = KEYS[event.code];
  if (!key) return null;
  const on = held(event);
  if (!on.command && !on.option && !on.control && !/^F\d+$/.test(event.code)) return null;
  const modifiers = GLYPHS.reduce((mask, [name]) => on[name] ? mask | MODIFIERS[name] : mask, 0);
  return { keyCode: key[0], modifiers, label: glyphs(on) + key[1] };
}

/// Records a global shortcut: click, then press it. Escape cancels; Delete clears it. A chord `taken`
/// holds already, or one the store keeps the old value over, is refused with the reason beside it.
/// `onChange` answers the chord as saved, when it knows it.
export function KeyRecorder({ value, onChange, label, taken = [] }: {
  value: Chord | null; label: string; taken?: { name: string; chord: Chord | null }[];
  onChange: (chord: Chord | null) => void | Promise<Chord | null | undefined>;
}) {
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => { if (!refused) return; const timer = setTimeout(() => setRefused(null), 6000); return () => clearTimeout(timer); }, [refused]);
  const stop = () => { setRecording(false); setPartial(''); };
  const save = (chord: Chord | null) => {
    const problem = chord && chordProblem(chord, taken);
    if (problem) { setRefused(problem); return; }
    setRefused(null);
    void Promise.resolve(onChange(chord)).then(saved => {
      if (chord && saved !== undefined && (saved?.keyCode !== chord.keyCode || saved.modifiers !== chord.modifiers)) setRefused(`${chord.label} can’t be used here`);
    });
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) {
      if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); if (value) save(null); }
      return;
    }
    event.preventDefault(); event.stopPropagation();
    const on = held(event);
    const bare = !on.command && !on.option && !on.control && !on.shift;
    if (event.key === 'Escape' && bare) { stop(); return; }
    if ((event.key === 'Backspace' || event.key === 'Delete') && bare) { save(null); stop(); return; }
    const chord = chordOf(event);
    if (chord) { save(chord); stop(); return; }
    setPartial(glyphs(on));
  };
  const clearable = value && !recording;
  return <span className="ui-recorder">
    {refused && <span className="ui-recorder-refused" role="alert">{refused}</span>}
    {/* Before the key, so the key's right edge lines up with every other control whether or not it holds a chord. */}
    {clearable && <button type="button" className="ui-recorder-clear" aria-label={`Clear ${label}`} onClick={() => save(null)}><Icon name="close" size={12} /></button>}
    <button type="button" className="ui-recorder-key" data-recording={recording || undefined} aria-label={`${label}: ${value?.label ?? 'none'}`}
      onClick={() => { setRefused(null); setRecording(!recording); }} onBlur={stop} onKeyDown={key} onKeyUp={event => { if (recording) setPartial(glyphs(held(event))); }}>
      {recording ? (partial ? <span className="ui-kbd-text">{partial}</span> : <span className="hint">Type shortcut</span>)
        : value ? <span className="ui-kbd-text">{value.label}</span> : <span className="hint">Record shortcut</span>}
    </button>
  </span>;
}
