import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { Status } from '../store';
import { AlarmIcon, Caret, Check, FolderIcon, GearIcon, MeetingIcon, MicIcon, NoteIcon, SetupIcon } from './icons';

const itemsOf = (menu: Element) => [...menu.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"], :scope > .sub > [role^="menuitem"]')];

// The dots' right-click menu. It works from the keyboard like a Mac menu: arrows move, → and ← open and
// close the microphones, Escape closes a level.
export function Menu({ status, mics, meeting, onMics, onNote, onMeeting, onShowNotes, onPickMic, onLogin, onHide, onSettings, onSetup }: {
  status: Status | null; mics: boolean; meeting: boolean; onMics: (open: boolean) => void; onNote: () => void; onMeeting: () => void; onShowNotes: () => void;
  onPickMic: (id: string | null) => void; onLogin: () => void; onHide: () => void; onSettings: () => void; onSetup: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const parent = useRef<HTMLButtonElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  const keys = (event: KeyboardEvent) => {
    const menu = (event.target as Element).closest('[role="menu"]');
    if (!menu) return;
    const items = itemsOf(menu), at = items.indexOf(document.activeElement as HTMLElement);
    const inSub = menu !== root.current;
    const focusSub = () => requestAnimationFrame(() => { const sub = root.current?.querySelector('.submenu'); if (sub) itemsOf(sub)[0]?.focus(); });
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus();
    else if (event.key === 'Home' || event.key === 'End') items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    else if (event.key === 'ArrowRight' && !inSub && document.activeElement === parent.current) { onMics(true); focusSub(); }
    else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && inSub) { onMics(false); parent.current?.focus(); }
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  return <div ref={root} className="glass menu" data-glass data-hit role="menu" aria-label="TabTasker Dictate" tabIndex={-1} onKeyDown={keys}
    onPointerMove={event => {
      const row = (event.target as Element).closest<HTMLElement>('[role^="menuitem"]');
      if (!row) return;
      // The pointer moves the selection, as in a Mac menu: the arrows carry on from the row under it, and
      // focus never sits in a list that a root row is about to close.
      if (row !== document.activeElement) row.focus({ preventScroll: true });
      if (!row.closest('.submenu')) onMics(row.hasAttribute('aria-haspopup'));
    }}>
    <button type="button" role="menuitem" tabIndex={-1} onClick={onNote}><NoteIcon />New note</button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={onMeeting}><MeetingIcon />{meeting ? 'Stop meeting' : 'Start meeting'}</button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={onShowNotes}><FolderIcon />Show notes in Finder</button>
    <i className="rule" role="separator" />
    {status && status.inputs.length > 0 && <div className="sub">
      <button ref={parent} type="button" role="menuitem" tabIndex={-1} aria-haspopup="menu" aria-expanded={mics} onClick={() => onMics(!mics)}><MicIcon />Microphone<Caret /></button>
      {mics && <div className="glass menu submenu" data-glass data-hit role="menu" aria-label="Microphone">
        {[{ id: null, name: 'Automatic' }, ...status.inputs].map(({ id, name }) => {
          const on = (status.input ?? null) === id;
          return <button key={id ?? ''} type="button" role="menuitemradio" tabIndex={-1} aria-checked={on} onClick={() => onPickMic(id)}>{on ? <Check /> : <span className="icon" />}{name}</button>;
        })}
        <i className="rule" role="separator" /><p className="in-use">Mic in use<span>{status.inputInUse}</span></p>
      </div>}
    </div>}
    <button type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={!!status?.openAtLogin} onClick={onLogin}>{status?.openAtLogin ? <Check /> : <span className="icon" />}Open at Login</button>
    <i className="rule" role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} onClick={onHide}><AlarmIcon />Hide for an hour</button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={onSettings}><GearIcon />Settings…</button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={onSetup}><SetupIcon />Set up…</button>
  </div>;
}
