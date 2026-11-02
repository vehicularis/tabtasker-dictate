import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke, setWindowTitle } from '../../bridge';
import { Editor } from '../../editor/Editor';
import type { NoteDoc } from '../../store';
import { Button, Icon } from '../../ui';

const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
type State = 'reading' | 'clean' | 'dirty' | 'saving' | 'saved' | 'error';
const WORDS: Record<State, string> = { reading: '', clean: '', dirty: 'Unsaved', saving: 'Saving…', saved: 'Saved', error: 'Not saved' };
/// The people in a meeting's transcript: every `**Name** hh:mm:ss` label, in order of first appearance.
const peopleIn = (body: string) => [...new Set([...body.matchAll(/^\*\*([^*\n]+)\*\* \d\d:\d\d:\d\d/gm)].map(found => found[1]))];

// One note or meeting, edited in place: its title above its words, saved back into the same Markdown file
// as you type (front matter kept), ⌘S for the impatient. A meeting shows the people heard in it, each
// renamable in one go. Hold the dictate key with the words focused to talk into it.
export function NoteEditor({ path, kind, onChanged, onDeleted, onError }: { path: string; kind: 'note' | 'meeting'; onChanged: () => void; onDeleted: () => void; onError: (message: string) => void }) {
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [title, setTitle] = useState('');
  const [seed, setSeed] = useState(0); // bumps when the body is replaced from outside the editor (a rename)
  const [state, setState] = useState<State>('reading');
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const latest = useRef({ title: '', body: '' });
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    void invoke<NoteDoc>('note_read', { path }).then(found => {
      setDoc(found); setTitle(found.title); latest.current = { title: found.title, body: found.body }; setState('clean');
      setWindowTitle(`${found.title || (kind === 'meeting' ? 'Meeting' : 'Note')} — TabTasker Dictate`);
    }, error => { onError(message(error, 'This note isn’t there any more.')); setState('error'); });
    return () => setWindowTitle('TabTasker Dictate');
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
  // Leaving (another note, the window closing, the Mac sleeping): what is pending goes now.
  useEffect(() => {
    const flush = () => { if (dirty.current) { dirty.current = false; void save(); } };
    addEventListener('pagehide', flush); document.addEventListener('visibilitychange', flush);
    return () => { flush(); removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', flush); };
  }, [save]);
  const file = doc ? doc.path.split('/').pop() : '';
  const reveal = () => void invoke('show_notes', { file: doc?.path }).catch(() => onError('Couldn’t show that in Finder.'));
  const elsewhere = () => void invoke('library_open', { path: doc?.path }).catch(() => onError('Couldn’t open that file.'));
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
  if (!doc) return <div className="editor-pane"><p className="empty-pane">{state === 'error' ? 'This note isn’t there any more.' : ''}</p></div>;
  return <div className="editor-pane" onKeyDown={event => { if (event.key === 's' && event.metaKey) { event.preventDefault(); void save(); } }}>
    <div className="editor-top">
      <span className="file" title={doc.path}>{kind === 'meeting' ? 'Meeting' : 'Note'} · {file}</span>
      <span className="note-state" data-state={state}>{WORDS[state]}</span>
      <Button small variant="quiet" icon="folder" aria-label="Show in Finder" title="Show in Finder" onClick={reveal} />
      <Button small variant="quiet" icon="external" aria-label="Open in another app" title="Open in another app" onClick={elsewhere} />
      {deleting
        ? <><span className="ask-confirm">Move to the Trash?</span><Button small variant="quiet" onClick={() => setDeleting(false)}>Keep</Button><Button small variant="danger" onClick={remove}>Trash</Button></>
        : <Button small variant="quiet" icon="trash" aria-label="Move to the Trash" title="Move to the Trash" onClick={() => setDeleting(true)} />}
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
        placeholder="Type, or hold fn and talk. Markdown works: # for a heading, - for a list, [ ] for a to-do, / for everything else."
        onChange={body => changed({ body })} />
    </div>
  </div>;
}
