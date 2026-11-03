import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, listen } from '../../bridge';
import { listGroup, listWhen, localDay, stamp } from '../../lib/dates';
import { message } from '../../lib/errors';
import { KEY_NAMES } from '../../lib/keyNames';
import { isUnnamed, readers, refreshLibrary } from '../../lib/library';
import { useSelection } from '../../lib/selection';
import { Menu, MenuItem, MenuLine } from '../../editor/Menu';
import { meetingLength, meetingWhen, useMeetingState } from '../../overlay/MeetingPill';
import type { LibraryItem, PageProps } from '../../store';
import { PLACE_GLYPHS } from '../../overlay/glyphs';
import { Button, Icon, Segmented, useFlip } from '../../ui';
import { ColumnGroup, ColumnHead } from '../Column';
import { NoteEditor } from './NoteEditor';

// A row is two lines, as Apple Notes has them: the title, then when and the first words, on one line.
/// A row's two lines. The title is the name the note was given; one still under the name it was made with is called
/// by its first sentence, as Apple Notes does, or "New note" while it's empty. The glance is what comes after: the
/// title isn't said twice when it's a line or a sentence of its own, and a transcript's "Name 00:00:09 Words" reads
/// as "Name: Words".
const rowText = (item: LibraryItem) => {
  const text = item.excerpt.replace(/(\S+) \d{1,2}:\d{2}:\d{2} /g, '$1: ').trim();
  if (isUnnamed(item.title)) {
    const first = text.match(/^.{1,60}?(?:[.!?](?=\s)|$)/)?.[0] ?? text.slice(0, 60);
    return { title: first.replace(/[.!?]$/, '') || `New ${item.kind}`, glance: text.slice(first.length).trim() };
  }
  const rest = text.startsWith(item.title) ? text.slice(item.title.length) : null;
  return { title: item.title, glance: rest !== null && /^(?:[.!?:]|\s*$)/.test(rest) ? rest.replace(/^[\s.!?:]+/, '') : text };
};
type Props = { kind: 'note' | 'meeting'; path: string | null; onError: (message: string) => void; onOpen: (route: string) => void } & PageProps;
const routeTo = (kind: 'note' | 'meeting', path: string) => `${kind === 'note' ? 'notes' : 'meetings'}/${encodeURIComponent(path)}`;
const newNote = (onOpen: Props['onOpen'], onError: Props['onError']) => void invoke<string>('note_new', { title: '', text: '', stamp: stamp() }).then(made => onOpen(routeTo('note', made)), error => onError(message(error, 'Couldn’t make a new note.')));

// The library as last read, notes and meetings both, for every place that asks: one opened again knows at once
// whether it has a list, so its column doesn't flash in and out while the folder is read again.
let known: LibraryItem[] | null = null;

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
  const groups = shown.reduce<{ title: string; items: LibraryItem[] }[]>((acc, item) => {
    const title = listGroup(localDay(item.modifiedMs), today), group = acc[acc.length - 1];
    if (group && group.title === title) group.items.push(item); else acc.push({ title, items: [item] });
    return acc;
  }, []);
  const list = useRef<HTMLDivElement>(null);
  useFlip(list, items); // a note added, archived or moved to the top glides there; typing in the search does not

  // Many at once, as Business's lists do it: ⌘-click or ⇧-click picks rows, a plain click still opens one, ⌘A
  // picks them all, Escape lets go. Picked, the column's title row says how many and holds what to do with them,
  // so nothing moves; a right-click does the same for the row under it. The Trash only after a menu asks, though
  // what goes there can come back. One that fails stays and the rest still go.
  const sel = useSelection(useMemo(() => shown.map(item => item.path), [shown]));
  const picked = [...sel.ids];
  const [asking, setAsking] = useState<{ paths: string[]; at: HTMLElement } | null>(null);
  const [menu, setMenu] = useState<{ paths: string[]; x: number; y: number } | null>(null);
  const many = (n: number) => `${n} ${kind}${n === 1 ? '' : 's'}`;
  const home = kind === 'note' ? 'notes' : 'meetings';
  const each = async (paths: string[], said: (what: string) => string, work: (path: string) => Promise<unknown>) => {
    sel.clear(); setAsking(null); setMenu(null);
    let done = 0;
    for (const one of paths) { try { await work(one); done++; } catch { /* left where it was */ } }
    onError(done === paths.length ? `${said(many(done))}.` : `${said(`${done} of ${many(paths.length)}`)}. The rest weren’t changed.`);
    if (path && paths.includes(path)) onOpen(home);
    refreshLibrary();
  };
  const archive = (paths: string[]) => void each(paths, what => `${viewing ? 'Restored' : 'Archived'} ${what}`, one => invoke('note_archive', { path: one, archived: !viewing }));
  const trash = (paths: string[]) => void each(paths, what => `Moved ${what} to the Trash`, one => invoke('note_delete', { path: one }));
  const archivedPaths = (items ?? []).filter(item => item.archived).map(item => item.path);
  const action = picked.length
    ? <span className="column-bulk">
      <Button variant="quiet" icon={viewing ? 'undo' : 'archive'} aria-label={viewing ? 'Restore' : 'Archive'} title={viewing ? 'Restore' : 'Archive'} onClick={() => archive(picked)} />
      <Button variant="quiet" icon="trash" aria-label="Move to Trash" title="Move to Trash" aria-haspopup="menu" onClick={event => setAsking({ paths: picked, at: event.currentTarget })} />
      <Button variant="quiet" icon="close" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={sel.clear} />
    </span>
    : viewing ? <Button variant="quiet" icon="trash" aria-label="Empty the archive" title="Empty the archive" aria-haspopup="menu" onClick={event => setAsking({ paths: archivedPaths, at: event.currentTarget })} />
    : kind === 'note' ? <Button variant="quiet" icon="compose" aria-label="New note" title="New note" onClick={() => newNote(onOpen, onError)} />
    : <MeetingAction onError={onError} />;
  return <>
    <ColumnHead title={picked.length ? `${picked.length} selected` : kind === 'note' ? 'Notes' : 'Meetings'} action={action} />
    <label className="search column-search"><Icon name="search" size={15} /><input type="search" placeholder={kind === 'note' ? 'Search notes' : 'Search meetings'} aria-label={kind === 'note' ? 'Search notes' : 'Search meetings'} value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} /></label>
    {archived > 0 && <div className="column-views"><Segmented label="Show" value={viewing ? 'archive' : 'list'} onChange={view => { sel.clear(); setInArchive(view === 'archive'); }}
      options={[{ value: 'list', label: kind === 'note' ? 'Notes' : 'Meetings' }, { value: 'archive', label: `Archive · ${archived}` }]} /></div>}
    {kind === 'meeting' && !viewing && <MeetingStrip onError={onError} />}
    {asking && <Menu anchor={asking.at} label="Move to Trash" focus onClose={() => setAsking(null)}>
      <p className="ed-menu-note">{asking.paths.length === 1 ? 'It can' : 'They can'} come back from the Trash in Finder.</p>
      <MenuItem danger onSelect={() => trash(asking.paths)}><Icon name="trash" size={15} />Move {asking.paths.length > 1 && asking.paths.length === archivedPaths.length && viewing ? 'all ' : ''}{many(asking.paths.length)} to the Trash</MenuItem>
    </Menu>}
    {menu && <Menu anchor={() => new DOMRect(menu.x, menu.y, 0, 0)} label={menu.paths.length > 1 ? `${menu.paths.length} selected` : kind === 'note' ? 'Note' : 'Meeting'} onClose={() => setMenu(null)}>
      {menu.paths.length === 1 && <><MenuItem onSelect={() => { setMenu(null); onOpen(routeTo(kind, menu.paths[0])); }}>Open</MenuItem><MenuLine /></>}
      <MenuItem onSelect={() => archive(menu.paths)}><Icon name={viewing ? 'undo' : 'archive'} size={15} />{viewing ? 'Restore' : 'Archive'}{menu.paths.length > 1 ? ` ${many(menu.paths.length)}` : ''}</MenuItem>
      <MenuItem danger onSelect={() => trash(menu.paths)}><Icon name="trash" size={15} />Move {menu.paths.length > 1 ? `${many(menu.paths.length)} ` : ''}to the Trash</MenuItem>
    </Menu>}
    <div ref={list} key={viewing ? 'archive' : 'list'} className="column-scroll" onKeyDown={sel.keys}>
      {items && !shown.length && (words.length ? <p className="list-none">Nothing matches that search.</p> : !viewing && <p className="list-none">Everything’s in the archive.</p>)}
      {groups.map(group => <ColumnGroup key={group.title} flip={`group:${group.title}`} title={group.title} count={group.items.length}>
        {group.items.map(item => {
          const { title, glance } = rowText(item);
          return <button key={item.path} type="button" className="list-item" data-flip={item.path} aria-current={item.path === path || undefined}
            data-picked={sel.ids.has(item.path) || undefined}
            onClick={event => { if (!sel.click(item.path, event)) onOpen(routeTo(kind, item.path)); }}
            onContextMenu={event => { event.preventDefault(); setMenu({ paths: sel.ids.has(item.path) ? picked : [item.path], x: event.clientX, y: event.clientY }); }}>
            <span className="t">{title}</span>
            <span className="d"><span className="when">{listWhen(item.modifiedMs, today)}</span>{glance || <span className="none">{item.excerpt ? 'No more text' : 'No text'}</span>}</span>
          </button>;
        })}
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
