import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, listen } from '../../bridge';
import { meetingLength, meetingWhen, useMeetingState } from '../../overlay/MeetingPill';
import type { LibraryItem, PageProps } from '../../store';
import { KEY_NAMES } from '../../overlay/Dock';
import { PLACE_GLYPHS } from '../../overlay/glyphs';
import { Button, Icon, Segmented, useFlip } from '../../ui';
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
const newNote = (onOpen: Props['onOpen'], onError: Props['onError']) => void invoke<string>('note_new', { title: '', text: '', stamp: stamp() }).then(made => onOpen(routeTo('note', made)), error => onError(message(error, 'Couldn’t create a note.')));

// The library as last read, notes and meetings both, for every place that asks: one opened again knows at once
// whether it has a list, so its column doesn't flash in and out while the folder is read again.
let known: LibraryItem[] | null = null;
const readers = new Set<() => void>();
/// Every list reads the folder again, after a change none of them would otherwise notice (Delete all).
const refreshLibrary = () => readers.forEach(read => read());

/// The notes, or the meetings (none for `null`), kept fresh as another one opens, a meeting ends or the
/// window comes forward. Null only before the very first read: the window shows no column until it knows.
export function useLibrary(kind: 'note' | 'meeting' | null, path: string | null, onError: (message: string) => void) {
  const [all, setAll] = useState(known);
  const refresh = useCallback(() => { if (kind) void invoke<LibraryItem[]>('library_list').then(items => { known = items; setAll(items); }, error => onError(message(error, 'Couldn’t read your notes.'))); }, [kind, onError]);
  useEffect(refresh, [refresh, path]);
  useEffect(() => {
    if (!kind) return;
    const off = listen('dictate-meeting', refresh);
    addEventListener('focus', refresh); readers.add(refresh);
    return () => { off(); removeEventListener('focus', refresh); readers.delete(refresh); };
  }, [kind, refresh]);
  return useMemo(() => kind && all ? all.filter(item => item.kind === kind) : null, [kind, all]);
}

/// The notes, or the meetings, as the window's column: the title and its action (a new note; the record
/// button), the search, then the files newest first in groups by day that fold. Only once there are some:
/// with none the page says so on its own (NotePage).
export function NotesColumn({ kind, path, items, onError, onOpen }: Props & { items: LibraryItem[] | null }) {
  const [query, setQuery] = useState('');
  // The list, or the archive: an archived one opened from a link shows the archive it is in.
  const [inArchive, setInArchive] = useState(() => !!path && /\/Archive\/[^/]+$/.test(path));
  useEffect(() => { if (path) setInArchive(/\/Archive\/[^/]+$/.test(path)); }, [path]); // the view follows the note that is open
  const archived = (items ?? []).filter(item => item.archived).length;
  const viewing = inArchive && archived > 0;
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = (items ?? []).filter(item => item.archived === viewing && words.every(word => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(word)));
  const today = localDay(Date.now());
  const groups = shown.reduce<{ day: number; items: LibraryItem[] }[]>((acc, item) => {
    const day = localDay(item.modifiedMs);
    const group = acc[acc.length - 1];
    if (group && group.day === day) group.items.push(item); else acc.push({ day, items: [item] });
    return acc;
  }, []);
  const list = useRef<HTMLDivElement>(null);
  useFlip(list, items); // a note added, archived or moved to the top glides there; typing in the search does not
  // Delete all, as Business's archive has it: asked first, then every archived one goes to the Trash (where it can
  // come back from); one that can't be moved stays in the archive and the rest still go.
  const [clearing, setClearing] = useState(false);
  const many = (n: number) => `${n} ${kind}${n === 1 ? '' : 's'}`;
  const deleteAll = async () => {
    setClearing(false);
    const doomed = (items ?? []).filter(item => item.archived);
    let done = 0;
    for (const item of doomed) { try { await invoke('note_delete', { path: item.path }); done++; } catch { /* left in the archive */ } }
    onError(done === doomed.length ? `Moved ${many(done)} to the Trash.` : `Moved ${done} of ${many(doomed.length)} to the Trash. The rest are still in the archive.`);
    if (path && doomed.some(item => item.path === path)) onOpen(kind === 'note' ? 'notes' : 'meetings');
    refreshLibrary();
  };
  return <>
    <ColumnHead title={kind === 'note' ? 'Notes' : 'Meetings'} action={kind === 'note'
      ? <Button variant="quiet" icon="compose" aria-label="New note" title="New note" onClick={() => newNote(onOpen, onError)} />
      : <MeetingAction onError={onError} />} />
    <label className="search column-search"><Icon name="search" size={15} /><input type="search" placeholder={kind === 'note' ? 'Search notes' : 'Search meetings'} aria-label={kind === 'note' ? 'Search notes' : 'Search meetings'} value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} /></label>
    {archived > 0 && <div className="column-views"><Segmented label="Show" value={viewing ? 'archive' : 'list'} onChange={view => setInArchive(view === 'archive')}
      options={[{ value: 'list', label: kind === 'note' ? 'Notes' : 'Meetings' }, { value: 'archive', label: `Archive · ${archived}` }]} /></div>}
    {viewing && <div className="column-clear">
      {clearing
        ? <><span>Move {many(archived)} to the Trash?</span><Button small variant="quiet" onClick={() => setClearing(false)}>Keep</Button><Button small variant="danger" onClick={() => void deleteAll()}>Move to Trash</Button></>
        : <Button small variant="danger" className="quiet" icon="trash" onClick={() => setClearing(true)}>Delete all</Button>}
    </div>}
    {kind === 'meeting' && !viewing && <MeetingStrip onError={onError} />}
    <div ref={list} key={viewing ? 'archive' : 'list'} className="column-scroll">
      {items && !shown.length && (words.length ? <p className="list-none">Nothing matches that search.</p> : !viewing && <p className="list-none">Everything’s in the archive.</p>)}
      {groups.map(group => <ColumnGroup key={group.day} flip={`day:${group.day}`} title={dayTitle(group.day, today)} count={group.items.length}>
        {group.items.map(item => <button key={item.path} type="button" className="list-item" data-flip={item.path} aria-current={item.path === path || undefined} onClick={() => onOpen(routeTo(kind, item.path))}>
          <span className="t">{item.title}</span>
          {item.excerpt && <span className="x">{item.excerpt}</span>}
          <span className="m">{clock(item.modifiedMs)} · {item.words.toLocaleString()} words</span>
        </button>)}
      </ColumnGroup>)}
    </div>
  </>;
}

/// The page beside the column: the note or meeting in the editor, or what to do when none is picked. With
/// none at all there is no column, so the page has the place to itself: what it is, and the button to start.
export function NotePage({ kind, path, items, settings, onError, onOpen }: Props & { items: LibraryItem[] | null }) {
  // Archived, the list moves on to the next one; restored, the note stays open where it now is.
  if (path) return <NoteEditor key={path} path={path} kind={kind} onChanged={() => {}} onDeleted={() => onOpen(kind === 'note' ? 'notes' : 'meetings')}
    onMoved={(moved, archived) => onOpen(archived ? (kind === 'note' ? 'notes' : 'meetings') : routeTo(kind, moved))} onError={onError} />;
  const key = KEY_NAMES[settings.shortcuts.dictate];
  if (items && !items.length) return <div className="editor-pane"><div className="empty-pane first">
    <span className="empty-icon">{(() => { const Glyph = PLACE_GLYPHS[kind === 'note' ? 'notes' : 'meetings']; return <Glyph size={48} />; })()}</span>
    <strong>{kind === 'note' ? 'No notes yet' : 'No meetings yet'}</strong>
    <p>{kind === 'note' ? `Write one here, or click the note on the dots and talk.${settings.notes.folder ? '' : ' They’re saved in Documents › TabTasker Dictate.'}`
      : 'Start one here or from the dots, and you’ll get a transcript of everyone in the room or on the call.'}</p>
    {kind === 'note' ? <Button variant="primary" icon="compose" onClick={() => newNote(onOpen, onError)}>New note</Button> : <><MeetingAction onError={onError} labelled /><MeetingStrip onError={onError} /></>}
  </div></div>;
  if (!items) return <div className="editor-pane" />;
  const Glyph = PLACE_GLYPHS[kind === 'note' ? 'notes' : 'meetings'];
  return <div className="editor-pane"><div className="empty-pane">
    <Glyph size={36} />
    <p>{kind === 'note' ? `Pick a note, or start a new one with the pencil. Once it’s open, hold ${key} to add to it by voice.`
      : 'Pick a meeting, or start a new one with the microphone above.'}</p>
  </div></div>;
}

/// Start and stop, as the column's action: the microphone, or a red stop square while recording. `labelled`
/// says so in words, as the empty page's button.
function MeetingAction({ onError, labelled = false }: { onError: (message: string) => void; labelled?: boolean }) {
  const [state, refresh] = useMeetingState();
  const [busy, setBusy] = useState(false);
  const recording = !!state?.recording;
  const toggle = () => {
    if (busy) return;
    setBusy(true);
    const action = recording ? 'stop' : 'start';
    void invoke<boolean>('meeting', { action }).then(changed => { if (!changed && action === 'start') onError('Couldn’t start the meeting. Check your microphone in Settings.'); refresh(); },
      error => onError(message(error, 'Couldn’t start the meeting.'))).finally(() => setBusy(false));
  };
  return <button type="button" className={`ui-button record${recording ? ' on' : labelled ? ' primary' : ' quiet'}`} aria-label={recording ? 'Stop the meeting' : 'Start a meeting'} title={recording ? 'Stop the meeting' : 'Start a meeting'} disabled={!state || busy} onClick={toggle}>
    {recording ? <span className="record-stop" /> : <Icon name="mic" size={16} />}{labelled && (recording ? 'Stop the meeting' : 'Start a meeting')}
  </button>;
}

/// While a meeting runs, or recordings are kept: the time and the recordings, under the search.
function MeetingStrip({ onError }: { onError: (message: string) => void }) {
  const [state, refresh] = useMeetingState();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const recording = state?.recording ?? null;
  useEffect(() => { if (!recording) return; const timer = setInterval(() => setTick(n => n + 1), 1000); return () => clearInterval(timer); }, [recording]);
  const recover = (id: string, save: boolean) => { setConfirming(null); void invoke('meeting_recover', { id, save }).then(refresh, error => onError(message(error, save ? 'Couldn’t save the recording. Try again.' : 'Couldn’t discard the recording. Try again.'))); };
  const since = recording?.since ?? 0;
  const seconds = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  if (!recording && !state?.saving.length && !state?.leftovers.length) return null;
  return <div className="meeting-strip">
    {recording && <span className="meeting-live"><i />{elapsed} · {recording.system === 'on' ? 'you and the call' : 'your microphone'}</span>}
    {!recording && !!state?.saving.length && <span className="meeting-live">Saving the last meeting…</span>}
    {state?.leftovers.map(leftover => <div key={leftover.id} className="leftover">
      <span>{meetingWhen(leftover.sinceMs)} · {meetingLength(leftover.seconds)} · {leftover.saved ? 'partly transcribed' : 'not saved yet'}</span>
      {confirming === leftover.id
        ? <><Button small variant="quiet" onClick={() => setConfirming(null)}>Keep</Button><Button small variant="danger" onClick={() => recover(leftover.id, false)}>Discard</Button></>
        : <><Button small variant="quiet" onClick={() => setConfirming(leftover.id)}>Discard</Button><Button small variant="primary" onClick={() => recover(leftover.id, true)}>{leftover.saved ? 'Try again' : 'Save'}</Button></>}
    </div>)}
  </div>;
}
