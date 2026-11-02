import { useCallback, useEffect, useRef, useState } from 'react';
import { inApp, invoke, setWindowTitle } from '../bridge';
import { Editor } from '../editor/Editor';
import { useSettings, type NoteDoc } from '../store';
import { applyTheme, Icon } from '../ui';

const path = new URLSearchParams(location.search).get('path') ?? '';
// In a browser, `?md=` stands in for the file's body, so a real note can be looked at in the mock.
const seed = inApp() ? null : new URLSearchParams(location.search).get('md');
const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
type State = 'reading' | 'clean' | 'dirty' | 'saving' | 'saved' | 'error';
const WORDS: Record<State, string> = { reading: '', clean: '', dirty: 'Unsaved', saving: 'Saving…', saved: 'Saved', error: 'Not saved' };

// One note or meeting file in the Text editor: its title above its words, saved back into the same
// Markdown file as you type (front matter kept), with ⌘S for the impatient. Hold the dictate key with
// the words focused to talk into it.
export function Note() {
  const settings = useSettings();
  const theme = settings?.appearance.theme;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [title, setTitle] = useState('');
  const [state, setState] = useState<State>('reading');
  const [problem, setProblem] = useState<string | null>(null);
  // What is to be saved, read at save time so a late timer never writes stale words.
  const latest = useRef({ title: '', body: '' });
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    void invoke<NoteDoc>('note_read', { path }).then(read => {
      const found = seed === null ? read : { ...read, body: seed };
      setDoc(found); setTitle(found.title); latest.current = { title: found.title, body: found.body }; setState('clean');
      setWindowTitle(found.title || 'Note');
    }, error => { setProblem(message(error, 'This note isn’t there any more.')); setState('error'); });
  }, []);
  const save = useCallback(() => {
    clearTimeout(timer.current);
    if (inFlight.current) return inFlight.current;
    const { title, body } = latest.current;
    setState('saving');
    inFlight.current = invoke<number>('note_write', { path, title: title.trim(), body })
      .then(() => { setState('saved'); setProblem(null); setWindowTitle(title.trim() || 'Note'); }, error => { setState('error'); setProblem(message(error, 'Couldn’t save the note.')); })
      .finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, []);
  const changed = (next: Partial<{ title: string; body: string }>) => {
    latest.current = { ...latest.current, ...next };
    setState('dirty');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 700);
  };
  // Leaving (the window closing, the Mac sleeping): what is pending goes now.
  useEffect(() => {
    const flush = () => { if (latest.current && state === 'dirty') void save(); };
    addEventListener('pagehide', flush); document.addEventListener('visibilitychange', flush);
    return () => { removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', flush); };
  }, [save, state]);
  const file = doc ? doc.path.split('/').pop() : '';
  const reveal = () => void invoke('show_notes', { file: doc?.path }).catch(() => setProblem('Couldn’t show that in Finder.'));
  const elsewhere = () => void invoke('library_open', { path: doc?.path }).catch(() => setProblem('Couldn’t open that file.'));
  return <div className="note" onKeyDown={event => { if (event.key === 's' && event.metaKey) { event.preventDefault(); void save(); } }}>
    <header className="titlebar" data-tauri-drag-region>
      <span className="note-where" data-tauri-drag-region>{doc ? `${doc.kind === 'meeting' ? 'Meeting' : 'Note'} · ${file}` : 'Note'}</span>
      <span className="note-tools">
        <button type="button" className="note-tool" aria-label="Show in Finder" title="Show in Finder" disabled={!doc} onClick={reveal}><Icon name="folder" size={15} /></button>
        <button type="button" className="note-tool" aria-label="Open in another app" title="Open in another app" disabled={!doc} onClick={elsewhere}><Icon name="external" size={15} /></button>
      </span>
    </header>
    {doc && <main className="note-page">
      <input className="note-title" aria-label="Title" placeholder="Title" value={title} spellCheck onChange={event => { setTitle(event.target.value); changed({ title: event.target.value }); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); (document.querySelector('.ed-body') as HTMLElement | null)?.focus(); } }} />
      <Editor key={doc.path} markdown={doc.body} label={doc.kind === 'meeting' ? 'Meeting' : 'Note'} autoFocus={!doc.body} placeholder="Type, or hold fn and talk. Markdown works: # for a heading, - for a list, [ ] for a to-do."
        onChange={body => changed({ body })} bar={<span className="note-state" data-state={state}>{WORDS[state]}</span>} />
    </main>}
    {problem && <p className="note-problem" role="alert">{problem}</p>}
  </div>;
}
