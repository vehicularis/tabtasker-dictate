import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { PILL_BUTTONS, useSettings, type DictateKey, type PillButton } from '../store';
import { LibraryGlyph, MeetingGlyph, NoteGlyph, SettingsGlyph, StickyGlyph, WriteGlyph } from './glyphs';
import { Orb } from './Orb';

/// The dictate key as the hint and Appearance's preview name it.
export const KEY_NAMES: Record<DictateKey, string> = { fn: 'fn', rightCommand: 'right ⌘', rightOption: 'right ⌥', rightControl: 'right ⌃', rightShift: 'right ⇧' };

// The dots, the pill they open into on hover (the buttons Appearance picks: a spoken note, a note to type, a
// sticky, a meeting, the window with your notes, the settings), and the orb they become while you talk.
// `quiet` dots (Appearance › idle hidden) are not drawn and take no clicks until the key is held. `buttons`
// overrides the setting (Help shows them all). The key's hint shows only while the pointer is on the spoken
// note, the button it is the other way to, as Business shows its fn hint only on its mic; `hintShown` keeps
// it up (Help).
export function Dock({ mode, menu, dots, label, hint, hintShown = false, quiet, level, typing, words, recording, buttons, onHover, onMenu, onGrab, onDots, onNote, onWrite, onSticky, onMeeting, onOpen, onSettings, onOrb }: {
  mode: string; menu: ReactNode; dots: RefObject<HTMLButtonElement | null>; label: string; hint: boolean; hintShown?: boolean; quiet: boolean; level: { current: number }; typing: boolean; words: string; recording: boolean; buttons?: readonly PillButton[];
  onHover: (over: boolean) => void; onMenu: () => void; onGrab: (event: ReactPointerEvent) => void; onDots: () => void; onNote: () => void; onWrite: () => void; onSticky: () => void; onMeeting: () => void; onOpen: () => void; onSettings: () => void; onOrb: () => void;
}) {
  const settings = useSettings();
  const key = KEY_NAMES[settings?.shortcuts.dictate ?? 'fn'];
  const pill = buttons ?? settings?.appearance.pill ?? PILL_BUTTONS;
  const tab = mode === 'hover' ? 0 : -1;
  const [onVoice, setOnVoice] = useState(false);
  useEffect(() => { if (mode !== 'hover') setOnVoice(false); }, [mode]); // a pill that closed under the pointer starts clear
  const button: Record<PillButton, ReactNode> = {
    note: <button key="note" type="button" aria-label="Speak a note" title="Speak a note: click and talk" tabIndex={tab} onPointerEnter={() => setOnVoice(true)} onPointerLeave={() => setOnVoice(false)} onClick={onNote}><NoteGlyph /></button>,
    write: <button key="write" type="button" aria-label="Write a note" title="Write a note: a new note in the window, to type into" tabIndex={tab} onClick={onWrite}><WriteGlyph /></button>,
    sticky: <button key="sticky" type="button" aria-label="New sticky" title="New sticky" tabIndex={tab} onClick={onSticky}><StickyGlyph /></button>,
    meeting: <button key="meeting" type="button" aria-label={recording ? 'Stop the meeting' : 'Start a meeting'} title={recording ? 'Stop the meeting' : 'Start a meeting: record the room or a call, with who said what'} data-recording={recording || undefined} tabIndex={tab} onClick={onMeeting}><MeetingGlyph /></button>,
    library: <button key="library" type="button" aria-label="Your notes and meetings" title="Your notes, meetings and stickies" tabIndex={tab} onClick={onOpen}><LibraryGlyph /></button>,
    settings: <button key="settings" type="button" aria-label="Settings" title="Settings" tabIndex={tab} onClick={onSettings}><SettingsGlyph /></button>,
  };
  return <div className="spot" data-spot data-hint={hintShown || onVoice || undefined} style={{ '--buttons': pill.length } as CSSProperties} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}
    onContextMenu={event => { event.preventDefault(); onMenu(); }}>
    {menu}
    <span className="keep" data-hit aria-hidden="true" />
    <span className="glass capsule" data-glass aria-hidden="true" />
    <button ref={dots} type="button" className="dots" data-hit={quiet ? undefined : 16} aria-label={label} onPointerDown={onGrab} onClick={onDots}>
      <i /><i /><i />
    </button>
    <div className="glass pill" data-glass data-hit aria-hidden={mode !== 'hover'} onPointerDown={onGrab}>{pill.map(name => button[name])}</div>
    <Orb mode={mode} level={level} typing={typing} words={words} onClick={onOrb} />
    {hint && <span className="label" aria-hidden="true"><span className="glass"><kbd>{key}</kbd> hold to type</span></span>}
  </div>;
}
