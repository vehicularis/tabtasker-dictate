import { useCallback, useEffect, useState } from 'react';
import { invoke, listen } from '../../bridge';
import { meetingLength, meetingWhen, useMeetingState } from '../../overlay/MeetingPill';
import type { LibraryItem, PageProps } from '../../store';
import { Button, Icon } from '../../ui';
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

// Your notes, or your meetings: the list on the left, newest first with a search, and the one you picked
// in the editor on the right. Notes has New note; Meetings has Start and Stop, and the recordings kept.
export function NotesView({ kind, path, settings, onError }: { kind: 'note' | 'meeting'; path: string | null; onError: (message: string) => void } & PageProps) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [query, setQuery] = useState('');
  const refresh = useCallback(() => { void invoke<LibraryItem[]>('library_list').then(all => setItems(all.filter(item => item.kind === kind)), error => onError(message(error, 'Couldn’t read your notes.'))); }, [kind, onError]);
  useEffect(refresh, [refresh, path]);
  useEffect(() => { const off = listen('dictate-meeting', refresh); addEventListener('focus', refresh); return () => { off(); removeEventListener('focus', refresh); }; }, [refresh]);
  const place = kind === 'note' ? 'notes' : 'meetings';
  const open = (to: string) => { location.hash = `${place}/${encodeURIComponent(to)}`; };
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = (items ?? []).filter(item => words.every(word => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(word)));
  const today = localDay(Date.now());
  const groups = shown.reduce<{ day: number; items: LibraryItem[] }[]>((acc, item) => {
    const day = localDay(item.modifiedMs);
    const group = acc[acc.length - 1];
    if (group && group.day === day) group.items.push(item); else acc.push({ day, items: [item] });
    return acc;
  }, []);
  const newNote = () => void invoke<string>('note_new', { title: '', text: '', stamp: stamp() }).then(open, error => onError(message(error, 'Couldn’t make a note.')));
  return <>
    <aside className="list" aria-label={kind === 'note' ? 'Your notes' : 'Your meetings'}>
      <div className="list-head">
        <label className="search"><Icon name="search" size={15} /><input type="search" placeholder={kind === 'note' ? 'Search notes' : 'Search meetings'} aria-label={kind === 'note' ? 'Search notes' : 'Search meetings'} value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} /></label>
        {kind === 'note' && <Button variant="primary" icon="plus" aria-label="New note" title="New note (type, or hold fn and talk)" onClick={newNote} />}
      </div>
      {kind === 'meeting' && <MeetingBar onError={onError} />}
      <div className="list-scroll">
        {items && !items.length && <p className="list-none">{kind === 'note' ? 'No notes yet. Make one with the button above, or click the note on the dots and talk.' : 'No meetings yet. Start one above, or from the dots.'}</p>}
        {items && items.length > 0 && !shown.length && <p className="list-none">Nothing has those words.</p>}
        {groups.map(group => <div key={group.day}>
          <h3 className="list-day">{dayTitle(group.day, today)}</h3>
          {group.items.map(item => <button key={item.path} type="button" className="list-item" aria-current={item.path === path || undefined} onClick={() => open(item.path)}>
            <span className="t">{item.title}</span>
            {item.excerpt && <span className="x">{item.excerpt}</span>}
            <span className="m">{clock(item.modifiedMs)} · {item.words.toLocaleString()} words</span>
          </button>)}
        </div>)}
      </div>
    </aside>
    {path
      ? <NoteEditor key={path} path={path} kind={kind} onChanged={refresh} onDeleted={() => { location.hash = place; refresh(); }} onError={onError} />
      : <div className="editor-pane"><div className="empty-pane">
        <Icon name={kind === 'note' ? 'note' : 'meeting'} size={28} />
        <p>{kind === 'note' ? (items?.length ? 'Pick a note, or make a new one.' : `Notes are Markdown files${settings.notes.folder ? '' : ' in Documents › TabTasker Dictate'}. Hold ${settings.shortcuts.dictate === 'fn' ? 'fn' : 'your key'} anywhere to type with your voice; click the note on the dots to take a long one.`)
          : (items?.length ? 'Pick a meeting.' : 'A meeting records the room and, on a call, the other side, and tells people apart. Start one above or from the dots.')}</p>
      </div></div>}
  </>;
}

/// Start, stop, and the recordings kept: everything a meeting needs, above the list.
function MeetingBar({ onError }: { onError: (message: string) => void }) {
  const [state, refresh] = useMeetingState();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const recording = state?.recording ?? null;
  useEffect(() => { if (!recording) return; const timer = setInterval(() => setTick(n => n + 1), 1000); return () => clearInterval(timer); }, [recording]);
  const toggle = () => {
    if (busy) return;
    setBusy(true);
    const action = recording ? 'stop' : 'start';
    void invoke<boolean>('meeting', { action }).then(changed => { if (!changed && action === 'start') onError('Couldn’t start the meeting. Check the microphone in Settings.'); refresh(); },
      error => onError(message(error, 'Couldn’t start the meeting.'))).finally(() => setBusy(false));
  };
  const recover = (id: string, save: boolean) => { setConfirming(null); void invoke('meeting_recover', { id, save }).then(refresh, error => onError(message(error, 'Couldn’t do that.'))); };
  const since = recording?.since ?? 0;
  const seconds = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <div className="meeting-bar">
    <Button variant={recording ? 'danger' : 'primary'} icon={recording ? undefined : 'mic'} disabled={!state || busy} onClick={toggle}>{recording ? `Stop · ${elapsed}` : 'Start meeting'}</Button>
    <span className="meeting-note">{recording ? (recording.system === 'on' ? 'Recording you and the call.' : 'Recording your microphone.') : state?.saving.length ? 'Saving the last meeting…' : 'The room and, on a call, the other side.'}</span>
    {state?.leftovers.map(leftover => <div key={leftover.id} className="leftover">
      <span>{meetingWhen(leftover.sinceMs)} · {meetingLength(leftover.seconds)} · {leftover.saved ? 'saved, with parts left' : 'not saved yet'}</span>
      {confirming === leftover.id
        ? <><Button small variant="quiet" onClick={() => setConfirming(null)}>Keep</Button><Button small variant="danger" onClick={() => recover(leftover.id, false)}>Discard</Button></>
        : <><Button small variant="quiet" onClick={() => setConfirming(leftover.id)}>Discard</Button><Button small variant="primary" onClick={() => recover(leftover.id, true)}>{leftover.saved ? 'Try again' : 'Save'}</Button></>}
    </div>)}
  </div>;
}
