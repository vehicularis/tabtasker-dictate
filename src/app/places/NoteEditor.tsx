import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke, setWindowTitle } from '../../bridge';
import { Editor } from '../../editor/Editor';
import { message } from '../../lib/errors';
import { KEY_NAMES } from '../../lib/keyNames';
import { isUnnamed, refreshLibrary } from '../../lib/library';
import { useSettings, type NoteDoc } from '../../store';
import { Button, Icon } from '../../ui';

type State = 'reading' | 'clean' | 'dirty' | 'saving' | 'saved' | 'error';
const WORDS: Record<State, string> = { reading: '', clean: '', dirty: 'Unsaved', saving: 'Saving…', saved: 'Saved', error: 'Not saved' };
/// The people in a meeting's transcript: every `**Name** hh:mm:ss` label, in order of first appearance.
const peopleIn = (body: string) => [...new Set([...body.matchAll(/^\*\*([^*\n]+)\*\* \d\d:\d\d:\d\d/gm)].map(found => found[1]))];

// One note or meeting, edited in place: its title above its words, saved back into the same Markdown file
// as you type (front matter kept), ⌘S for the impatient. A meeting shows the people heard in it, each
// renamable in one go. Hold the dictate key with the words focused to talk into it.
export function NoteEditor({ path, kind, onChanged, onDeleted, onMoved, onError }: { path: string; kind: 'note' | 'meeting'; onChanged: () => void; onDeleted: () => void; onMoved: (path: string, archived: boolean) => void; onError: (message: string) => void }) {
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const dictateKey = KEY_NAMES[useSettings()?.shortcuts.dictate ?? 'fn'];
  const [title, setTitle] = useState('');
  const [seed, setSeed] = useState(0); // bumps when the body is replaced from outside the editor (a rename)
  const [state, setState] = useState<State>('reading');
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const latest = useRef({ title: '', body: '' });
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    void invoke<NoteDoc>('note_read', { path }).then(found => {
      setDoc(found); setTitle(found.title); latest.current = { title: found.title, body: found.body }; setState('clean'); loaded.current = true;
      setWindowTitle(found.title || (kind === 'meeting' ? 'Meeting' : 'Note'));
    }, error => { onError(message(error, 'This note has been moved or deleted.')); setState('error'); });
    return () => setWindowTitle('TabTasker | Dictate');
  }, [path, kind, onError]);
  const save = useCallback(() => {
    clearTimeout(timer.current);
    if (inFlight.current) return inFlight.current;
    const { title, body } = latest.current;
    setState('saving');
    inFlight.current = invoke<number>('note_write', { path, title: title.trim(), body })
      .then(() => { setState('saved'); onChanged(); }, error => { setState('error'); onError(message(error, 'Couldn’t save the note.')); })
      .finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [path, onChanged, onError]);
  const dirty = useRef(false);
  const changed = (next: Partial<{ title: string; body: string }>) => {
    latest.current = { ...latest.current, ...next };
    dirty.current = true; setState('dirty');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { dirty.current = false; void save(); }, 700);
  };
  // Leaving (another note, the window closing, the Mac sleeping): what is pending goes now. A note left with nothing
  // in it and still under the name it was made with goes to the Trash once that's saved, as Apple Notes lets an empty
  // one go, so a stray New note doesn't stay in the list. A meeting, or a note given a name, is never thrown away.
  useEffect(() => {
    const flush = () => { if (dirty.current) { dirty.current = false; void save(); } };
    addEventListener('pagehide', flush); document.addEventListener('visibilitychange', flush);
    return () => { flush(); removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', flush); };
  }, [save]);
  // Its own effect, keyed on the note alone: `save` is new on every render, and this must run only when the note
  // closes. Cleanups run in order, so the flush above has started any last save by now.
  useEffect(() => () => {
    const { title, body } = latest.current;
    if (kind === 'note' && loaded.current && !body.trim() && isUnnamed(title))
      void Promise.resolve(inFlight.current).then(() => invoke('note_delete', { path })).then(refreshLibrary, () => {});
  }, [kind, path]);
  const file = doc ? doc.path.split('/').pop() : '';
  const reveal = () => void invoke('show_notes', { file: doc?.path }).catch(() => onError('Couldn’t show that in Finder.'));
  const elsewhere = () => void invoke('library_open', { path: doc?.path }).catch(() => onError('Couldn’t open that file.'));
  // Into the folder's Archive/ or back out, saved first; the list then follows it to where it is.
  const archived = /\/Archive\/[^/]+$/.test(path);
  const archive = (on: boolean) => { clearTimeout(timer.current); void save().then(() => invoke<string>('note_archive', { path, archived: on })).then(moved => onMoved(moved, on), error => onError(message(error, on ? 'Couldn’t archive that.' : 'Couldn’t restore that.'))); };
  const remove = () => { clearTimeout(timer.current); dirty.current = false; void invoke('note_delete', { path }).then(onDeleted, error => onError(message(error, 'Couldn’t move that to the Trash.'))); };
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (!renaming || !doc) return;
    const to = renaming.to.trim().replace(/[*_`[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    setRenaming(null);
    if (!to || to === renaming.from) return;
    const body = latest.current.body.split(`**${renaming.from}** `).join(`**${to}** `);
    latest.current = { ...latest.current, body };
    setDoc({ ...doc, body }); setSeed(n => n + 1);
    dirty.current = false; void save();
  };
  const people = doc && kind === 'meeting' ? peopleIn(latest.current.body) : [];
  if (!doc) return <div className="editor-pane"><p className="empty-pane">{state === 'error' ? 'This note has been moved or deleted.' : ''}</p></div>;
  return <div className="editor-pane" onKeyDown={event => { if (event.key === 's' && event.metaKey) { event.preventDefault(); void save(); } }}>
    <div className="editor-top">
      <span className="file" title={doc.path}>{archived ? 'Archived' : kind === 'meeting' ? 'Meeting' : 'Note'} · {file}</span>
      <span className="note-state" data-state={state}>{WORDS[state]}</span>
      <Button small variant="quiet" icon="folder" aria-label="Show in Finder" title="Show in Finder" onClick={reveal} />
      <Button small variant="quiet" icon="external" aria-label="Open in another app" title="Open in another app" onClick={elsewhere} />
      {archived
        ? <Button small variant="quiet" onClick={() => archive(false)}>Restore</Button>
        : <Button small variant="quiet" icon="archive" aria-label="Archive" title="Move to the archive" onClick={() => archive(true)} />}
      {deleting
        ? <><span className="ask-confirm">Move to Trash?</span><Button small variant="quiet" onClick={() => setDeleting(false)}>Keep</Button><Button small variant="danger" onClick={remove}>Trash</Button></>
        : <Button small variant="quiet" icon="trash" aria-label="Move to Trash" title="Move to Trash" onClick={() => setDeleting(true)} />}
    </div>
    <div className="editor-page">
      <input className="note-title" aria-label="Title" placeholder="Title" value={title} spellCheck onChange={event => { setTitle(event.target.value); changed({ title: event.target.value }); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); (document.querySelector('.ed-body') as HTMLElement | null)?.focus(); } }} />
      {people.length > 0 && <div className="people" aria-label="People in this meeting">
        <Icon name="meeting" size={14} />
        {people.map(person => renaming?.from === person
          ? <form key={person} className="chip renaming" onSubmit={rename}>
            <input autoFocus value={renaming.to} aria-label={`New name for ${person}`} onChange={event => setRenaming({ from: person, to: event.target.value })}
              onKeyDown={event => { if (event.key === 'Escape') setRenaming(null); }} onBlur={rename} />
          </form>
          : <button key={person} type="button" className="chip" title={`Rename ${person} everywhere in this meeting`} onClick={() => setRenaming({ from: person, to: person })}>{person}</button>)}
      </div>}
      <Editor key={`${doc.path}:${seed}`} markdown={doc.body} label={kind === 'meeting' ? 'Meeting' : 'Note'} autoFocus={!doc.body} notePath={doc.path}
        placeholder={`Type, or hold ${dictateKey} and talk. Press / for headings, lists and more.`}
        onChange={body => changed({ body })} />
    </div>
  </div>;
}
