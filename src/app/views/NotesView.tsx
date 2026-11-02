import { useCallback, useEffect, useState } from 'react';
import { invoke, listen } from '../../bridge';
import { meetingLength, meetingWhen, useMeetingState } from '../../overlay/MeetingPill';
import type { LibraryItem, PageProps } from '../../store';
import { Button, Icon } from '../../ui';
import { ColumnGroup, ColumnHead } from '../Column';
import { NoteEditor } from './NoteEditor';

const DAY = 86_400_000;
const localDay = (atMs: number) => Math.floor((atMs - new Date(atMs).getTimezoneOffset() * 60_000) / DAY);
const dateOf = (day: number, options: Intl.DateTimeFormatOptions) => new Date(day * DAY).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
function dayTitle(day: number, today: number) {
  if (day === today) return 'Today';
  if (day === today - 1) return 'Yesterday';
  const thisYear = dateOf(day, { year: 'numeric' }) === dateOf(today, { year: 'numeric' });
  return dateOf(day, { weekday: 'long', month: 'long', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}
const clock = (atMs: number) => new Date(atMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };
const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
type Props = { kind: 'note' | 'meeting'; path: string | null; onError: (message: string) => void; onOpen: (route: string) => void } & PageProps;
const routeTo = (kind: 'note' | 'meeting', path: string) => `${kind === 'note' ? 'notes' : 'meetings'}/${encodeURIComponent(path)}`;

/// The notes, or the meetings, as the window's column: the title and its action (a new note; the record
/// button), the search, then the files newest first in groups by day that fold.
export function NotesColumn({ kind, path, onError, onOpen }: Props) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [query, setQuery] = useState('');
  const refresh = useCallback(() => { void invoke<LibraryItem[]>('library_list').then(all => setItems(all.filter(item => item.kind === kind)), error => onError(message(error, 'Couldn’t read your notes.'))); }, [kind, onError]);
  useEffect(refresh, [refresh, path]);
  useEffect(() => { const off = listen('dictate-meeting', refresh); addEventListener('focus', refresh); return () => { off(); removeEventListener('focus', refresh); }; }, [refresh]);
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = (items ?? []).filter(item => words.every(word => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(word)));
  const today = localDay(Date.now());
  const groups = shown.reduce<{ day: number; items: LibraryItem[] }[]>((acc, item) => {
    const day = localDay(item.modifiedMs);
    const group = acc[acc.length - 1];
    if (group && group.day === day) group.items.push(item); else acc.push({ day, items: [item] });
    return acc;
  }, []);
  const newNote = () => void invoke<string>('note_new', { title: '', text: '', stamp: stamp() }).then(made => onOpen(routeTo(kind, made)), error => onError(message(error, 'Couldn’t make a note.')));
  return <>
    <ColumnHead title={kind === 'note' ? 'Notes' : 'Meetings'} action={kind === 'note'
      ? <Button variant="quiet" icon="compose" aria-label="New note" title="New note (type, or hold fn and talk)" onClick={newNote} />
      : <MeetingAction onError={onError} />} />
    <label className="search column-search"><Icon name="search" size={15} /><input type="search" placeholder={kind === 'note' ? 'Search notes' : 'Search meetings'} aria-label={kind === 'note' ? 'Search notes' : 'Search meetings'} value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} /></label>
    {kind === 'meeting' && <MeetingStrip onError={onError} />}
    <div className="column-scroll">
      {items && !items.length && <p className="list-none">{kind === 'note' ? 'No notes yet. Make one with the pencil above, or click the note on the dots and talk.' : 'No meetings yet. Start one with the microphone above, or from the dots.'}</p>}
      {items && items.length > 0 && !shown.length && <p className="list-none">Nothing has those words.</p>}
      {groups.map(group => <ColumnGroup key={group.day} title={dayTitle(group.day, today)} count={group.items.length}>
        {group.items.map(item => <button key={item.path} type="button" className="list-item" aria-current={item.path === path || undefined} onClick={() => onOpen(routeTo(kind, item.path))}>
          <span className="t">{item.title}</span>
          {item.excerpt && <span className="x">{item.excerpt}</span>}
          <span className="m">{clock(item.modifiedMs)} · {item.words.toLocaleString()} words</span>
        </button>)}
      </ColumnGroup>)}
    </div>
  </>;
}

/// The page beside the column: the note or meeting in the editor, or what to do when none is picked.
export function NotePage({ kind, path, settings, onError, onOpen }: Props) {
  if (path) return <NoteEditor key={path} path={path} kind={kind} onChanged={() => {}} onDeleted={() => onOpen(kind === 'note' ? 'notes' : 'meetings')} onError={onError} />;
  return <div className="editor-pane"><div className="empty-pane">
    <Icon name={kind === 'note' ? 'note' : 'meeting'} size={28} />
    <p>{kind === 'note' ? `Pick a note, or make one with the pencil. Notes are Markdown files${settings.notes.folder ? '' : ' in Documents › TabTasker Dictate'}. Hold ${settings.shortcuts.dictate === 'fn' ? 'fn' : 'your key'} anywhere to type with your voice; click the note on the dots to take a long one.`
      : 'Pick a meeting. A meeting records the room and, on a call, the other side, and tells the people apart. Start one with the microphone above, or from the dots.'}</p>
  </div></div>;
}

/// Start and stop, as the column's action: the microphone, or a red stop square while recording.
function MeetingAction({ onError }: { onError: (message: string) => void }) {
  const [state, refresh] = useMeetingState();
  const [busy, setBusy] = useState(false);
  const recording = !!state?.recording;
  const toggle = () => {
    if (busy) return;
    setBusy(true);
    const action = recording ? 'stop' : 'start';
    void invoke<boolean>('meeting', { action }).then(changed => { if (!changed && action === 'start') onError('Couldn’t start the meeting. Check the microphone in Settings.'); refresh(); },
      error => onError(message(error, 'Couldn’t start the meeting.'))).finally(() => setBusy(false));
  };
  return <button type="button" className={`ui-button record${recording ? ' on' : ' quiet'}`} aria-label={recording ? 'Stop the meeting' : 'Start a meeting'} title={recording ? 'Stop the meeting' : 'Start a meeting: the room and, on a call, the other side'} disabled={!state || busy} onClick={toggle}>
    {recording ? <span className="record-stop" /> : <Icon name="mic" size={16} />}
  </button>;
}

/// While a meeting runs, or recordings are kept: the time and the recordings, under the search.
function MeetingStrip({ onError }: { onError: (message: string) => void }) {
  const [state, refresh] = useMeetingState();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const recording = state?.recording ?? null;
  useEffect(() => { if (!recording) return; const timer = setInterval(() => setTick(n => n + 1), 1000); return () => clearInterval(timer); }, [recording]);
  const recover = (id: string, save: boolean) => { setConfirming(null); void invoke('meeting_recover', { id, save }).then(refresh, error => onError(message(error, 'Couldn’t do that.'))); };
  const since = recording?.since ?? 0;
  const seconds = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  if (!recording && !state?.saving.length && !state?.leftovers.length) return null;
  return <div className="meeting-strip">
    {recording && <span className="meeting-live"><i />{elapsed} · {recording.system === 'on' ? 'you and the call' : 'your microphone'}</span>}
    {!recording && !!state?.saving.length && <span className="meeting-live">Saving the last meeting…</span>}
    {state?.leftovers.map(leftover => <div key={leftover.id} className="leftover">
      <span>{meetingWhen(leftover.sinceMs)} · {meetingLength(leftover.seconds)} · {leftover.saved ? 'saved, with parts left' : 'not saved yet'}</span>
      {confirming === leftover.id
        ? <><Button small variant="quiet" onClick={() => setConfirming(null)}>Keep</Button><Button small variant="danger" onClick={() => recover(leftover.id, false)}>Discard</Button></>
        : <><Button small variant="quiet" onClick={() => setConfirming(leftover.id)}>Discard</Button><Button small variant="primary" onClick={() => recover(leftover.id, true)}>{leftover.saved ? 'Try again' : 'Save'}</Button></>}
    </div>)}
  </div>;
}
