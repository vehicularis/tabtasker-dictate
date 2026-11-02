import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { useSettings, type DictateKey } from '../store';
import { LibraryGlyph, NoteGlyph, SettingsGlyph } from './glyphs';
import { Orb } from './Orb';

/// The dictate key as the hint and Appearance's preview name it.
export const KEY_NAMES: Record<DictateKey, string> = { fn: 'fn', rightCommand: 'right ⌘', rightOption: 'right ⌥', rightControl: 'right ⌃', rightShift: 'right ⇧' };

// The dots, the pill they open into on hover (a note, your library, the quick settings), and the orb they become while you talk. `quiet` dots
// (Appearance › idle hidden) are not drawn and take no clicks until the key is held.
export function Dock({ mode, menu, dots, label, hint, quiet, level, typing, words, onHover, onMenu, onGrab, onDots, onNote, onLibrary, onSetup, onOrb }: {
  mode: string; menu: ReactNode; dots: RefObject<HTMLButtonElement | null>; label: string; hint: boolean; quiet: boolean; level: { current: number }; typing: boolean; words: string;
  onHover: (over: boolean) => void; onMenu: () => void; onGrab: (event: ReactPointerEvent) => void; onDots: () => void; onNote: () => void; onLibrary: () => void; onSetup: () => void; onOrb: () => void;
}) {
  const key = KEY_NAMES[useSettings()?.shortcuts.dictate ?? 'fn'];
  return <div className="spot" data-spot onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}
    onContextMenu={event => { event.preventDefault(); onMenu(); }}>
    {menu}
    <span className="glass capsule" data-glass aria-hidden="true" />
    <button ref={dots} type="button" className="dots" data-hit={quiet ? undefined : 16} aria-label={label} onPointerDown={onGrab} onClick={onDots}>
      <i /><i /><i />
    </button>
    <div className="glass pill" data-glass data-hit aria-hidden={mode !== 'hover'} onPointerDown={onGrab}>
      <button type="button" aria-label="Take a note" title="Take a note" tabIndex={mode === 'hover' ? 0 : -1} onClick={onNote}><NoteGlyph /></button>
      <button type="button" aria-label="Library: your notes, meetings and what you said" title="Library" tabIndex={mode === 'hover' ? 0 : -1} onClick={onLibrary}><LibraryGlyph /></button>
      <button type="button" aria-label="Quick settings" title="Quick settings" tabIndex={mode === 'hover' ? 0 : -1} onClick={onSetup}><SettingsGlyph /></button>
    </div>
    <Orb mode={mode} level={level} typing={typing} words={words} onClick={onOrb} />
    {hint && <span className="label" aria-hidden="true"><span className="glass"><kbd>{key}</kbd> hold to type</span></span>}
  </div>;
}
