import type { Status } from '../store';
import { AlarmIcon, Caret, Check, FolderIcon, GearIcon, MeetingIcon, MicIcon, NoteIcon, SetupIcon } from './icons';

// The dots' right-click menu.
export function Menu({ status, mics, meeting, onMics, onNote, onMeeting, onShowNotes, onPickMic, onLogin, onHide, onSettings, onSetup }: {
  status: Status | null; mics: boolean; meeting: boolean; onMics: (open: boolean) => void; onNote: () => void; onMeeting: () => void; onShowNotes: () => void;
  onPickMic: (id: string | null) => void; onLogin: () => void; onHide: () => void; onSettings: () => void; onSetup: () => void;
}) {
  return <div className="glass menu" data-glass data-hit role="menu"
    onPointerMove={event => { const row = (event.target as Element).closest('[role="menuitem"]'); if (row) onMics(row.hasAttribute('aria-haspopup')); }}>
    <button type="button" role="menuitem" onClick={onNote}><NoteIcon />New note</button>
    <button type="button" role="menuitem" onClick={onMeeting}><MeetingIcon />{meeting ? 'Stop meeting' : 'Start meeting'}</button>
    <button type="button" role="menuitem" onClick={onShowNotes}><FolderIcon />Show notes in Finder</button>
    <i className="rule" />
    {status && status.inputs.length > 0 && <div className="sub">
      <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={mics} onClick={() => onMics(!mics)}><MicIcon />Microphone<Caret /></button>
      {mics && <div className="glass menu submenu" data-glass data-hit role="menu" aria-label="Microphone">
        {[{ id: null, name: 'Automatic' }, ...status.inputs].map(({ id, name }) => {
          const on = (status.input ?? null) === id;
          return <button key={id ?? ''} type="button" role="menuitemradio" aria-checked={on} onClick={() => onPickMic(id)}>{on ? <Check /> : <span className="icon" />}{name}</button>;
        })}
        <i className="rule" /><p className="in-use">Mic in use<span>{status.inputInUse}</span></p>
      </div>}
    </div>}
    <button type="button" role="menuitemcheckbox" aria-checked={!!status?.openAtLogin} onClick={onLogin}>{status?.openAtLogin ? <Check /> : <span className="icon" />}Open at Login</button>
    <i className="rule" />
    <button type="button" role="menuitem" onClick={onHide}><AlarmIcon />Hide for an hour</button>
    <button type="button" role="menuitem" onClick={onSettings}><GearIcon />Settings…</button>
    <button type="button" role="menuitem" onClick={onSetup}><SetupIcon />Set up…</button>
  </div>;
}
