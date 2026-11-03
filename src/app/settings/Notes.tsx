import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '../../bridge';
import { stamp } from '../../lib/dates';
import { message } from '../../lib/errors';
import { tilde, useStatus, type PageProps, type Settings } from '../../store';
import { Button, ChipList, Icon, PageHeader, Section, Tile, TileGroup, Toggle } from '../../ui';
import './notes.css';

type Folder = { path: string; vault: string | null };
type Preview = { fileName: string; text: string };

const DEFAULT_NAME = '{date} {title}';
// The note the preview saves.
const SAMPLE = {
  title: 'Call the venue about Thursday',
  body: 'Ask for the bigger room, and send Maria the new floor plan before lunch.',
  actions: '- [ ] Ask the venue for the bigger room\n- [ ] Send Maria the new floor plan',
};
const TOKENS = [{ token: '{date}', label: 'Date' }, { token: '{time}', label: 'Time' }, { token: '{title}', label: 'Title' }];

// The store's rules for a file name, said before it refuses one.
const nameProblem = (name: string) => /[/:]/.test(name) ? 'A file name can’t contain a slash or a colon.'
  : name.trimStart().startsWith('.') ? 'A file name can’t start with a dot, because that would hide the note.' : null;
// A tag as the front matter writes it: no leading #, words joined by hyphens.
const tagOf = (text: string) => text.trim().replace(/^#+/, '').split(/\s+/).filter(Boolean).join('-');

export function Notes({ settings, update }: PageProps) {
  const notes = settings.notes;
  const claude = settings.claude.enabled;
  const [status] = useStatus();
  const [folder, setFolder] = useState<Folder | null>(null);
  const [folderProblem, setFolderProblem] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [template, setTemplate] = useState(notes.fileName);
  const [preview, setPreview] = useState<Preview | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const selection = useRef<[number, number] | null>(null);

  useEffect(() => setTemplate(notes.fileName), [notes.fileName]);
  useEffect(() => {
    let live = true;
    void invoke<Folder>('notes_folder').then(next => { if (live) setFolder(next); }).catch(() => {});
    return () => { live = false; };
  }, [notes.folder]);

  const templateProblem = nameProblem(template);
  const problemId = useId();
  // The preview follows the name as it is typed, and the saved one while what is typed can't be used.
  const shown: Settings['notes'] = { ...notes, fileName: templateProblem || !template.trim() ? notes.fileName : template };
  const actions = claude && notes.claudeActions ? SAMPLE.actions : null;
  const previewKey = JSON.stringify([shown, actions]);
  useEffect(() => {
    let live = true;
    void invoke<Preview>('preview_note', { notes: shown, title: SAMPLE.title, body: SAMPLE.body, actions, stamp: stamp(new Date()) })
      .then(next => { if (live) setPreview(next); }).catch(() => {});
    return () => { live = false; };
  }, [previewKey]);

  const choose = async () => {
    setChoosing(true);
    setFolderProblem(null);
    try {
      const path = await invoke<string | null>('choose_folder', { message: 'Choose where to save your notes.', start: folder?.path ?? null });
      if (!path) return;
      const saved = await update({ notes: { folder: path } });
      if (saved && saved.notes.folder !== path) setFolderProblem('Dictate can’t save notes in that folder. Choose another one.');
    } catch (error) {
      setFolderProblem(message(error, 'Couldn’t open the folder picker.'));
    } finally {
      setChoosing(false);
    }
  };

  const commit = (next: string) => {
    if (!next.trim()) { setTemplate(notes.fileName); return; }
    if (!nameProblem(next) && next !== notes.fileName) void update({ notes: { fileName: next } });
  };
  // Puts a token where the caret was, over any selected text, and never inside another token. A space
  // keeps it apart from a word or token it would touch; a separator already there stands.
  const insert = (token: string) => {
    let [start, end] = selection.current ?? [template.length, template.length];
    const open = template.lastIndexOf('{', start - 1), close = template.indexOf('}', start);
    if (start === end && start > 0 && open > template.lastIndexOf('}', start - 1) && close >= 0) start = end = close + 1;
    const before = /[\p{L}\p{N}})\]]$/u.test(template.slice(0, start)) ? ' ' : '';
    const after = /^[\p{L}\p{N}{([]/u.test(template.slice(end)) ? ' ' : '';
    const next = template.slice(0, start) + before + token + after + template.slice(end);
    const caret = start + before.length + token.length;
    selection.current = [caret, caret];
    setTemplate(next);
    commit(next);
    requestAnimationFrame(() => { if (document.activeElement === field.current) field.current?.setSelectionRange(caret, caret); });
  };
  const remember = () => { const input = field.current; if (input) selection.current = [input.selectionStart ?? template.length, input.selectionEnd ?? template.length]; };

  const path = folder?.path ?? status?.notes;
  const name = path?.split('/').filter(Boolean).pop() ?? 'TabTasker Dictate';
  return <>
    <PageHeader icon="note" title="Notes">Your notes are plain Markdown files in a folder you choose.</PageHeader>

    <Section title="Folder" note={folderProblem ?? (notes.folder
      ? <>New notes go here, and older ones stay where they are. <button type="button" className="link" onClick={() => void update({ notes: { folder: null } })}>Use the default folder</button></>
      : 'To save notes straight into Obsidian, choose a folder inside your vault.')}>
      <TileGroup label="Notes folder">
        <Tile title={<span className="notes-folder"><Icon name="folder" size={16} />{name}</span>} detail={path && <span className="notes-path">{tilde(path, status?.home)}</span>}>
          <Button variant="quiet" small onClick={() => void invoke('show_notes', {}).catch(() => setFolderProblem('Couldn’t show the folder in Finder.'))}>Show in Finder</Button>
          <Button disabled={choosing} onClick={() => void choose()}>Choose…</Button>
        </Tile>
        {folder?.vault && <Tile title={`Obsidian vault “${folder.vault}”`} detail="New notes show up in Obsidian as soon as they’re saved.">
          <span className="state" data-on><Icon name="check" size={14} />Obsidian</span>
        </Tile>}
      </TileGroup>
    </Section>

    <Section title="Files" note={templateProblem ? <span id={problemId} role="alert">{templateProblem}</span> : (!notes.dailyNote && notes.fileName !== DEFAULT_NAME
      ? <button type="button" className="link" onClick={() => void update({ notes: { fileName: DEFAULT_NAME } })}>Use the default name, {DEFAULT_NAME}</button> : undefined)}>
      <TileGroup>
        <Tile title="Daily note" detail="Keep one file per day and add each note to it.">
          <Toggle label="Daily note" checked={notes.dailyNote} onChange={dailyNote => update({ notes: { dailyNote } })} />
        </Tile>
        <Tile title="File name" detail={notes.dailyNote ? 'With Daily note on, files are named by their date.' : 'If a name’s taken, Dictate adds a number, so nothing gets overwritten.'} stack dim={notes.dailyNote}>
          <span className="notes-template">
            <input ref={field} className="ui-field mono" aria-label="File name" aria-invalid={!!templateProblem || undefined}
              aria-describedby={templateProblem ? problemId : undefined} value={template} disabled={notes.dailyNote} spellCheck={false}
              placeholder={DEFAULT_NAME} onChange={event => { setTemplate(event.target.value); remember(); }} onSelect={remember} onBlur={() => commit(template)}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); commit(template); }
                if (event.key === 'Escape') setTemplate(notes.fileName);
              }} />
            {TOKENS.map(({ token, label }) => <Button key={token} small icon="plus" aria-label={`Insert ${label.toLowerCase()}`} title={token} disabled={notes.dailyNote}
              onMouseDown={event => event.preventDefault()} onClick={() => insert(token)}>{label}</Button>)}
          </span>
        </Tile>
      </TileGroup>
    </Section>

    <Section title="For Obsidian">
      <TileGroup>
        <Tile title="Front matter" detail="Adds the date and your tags at the top of each file.">
          <Toggle label="Front matter" checked={notes.frontmatter} onChange={frontmatter => update({ notes: { frontmatter } })} />
        </Tile>
        {notes.frontmatter && <Tile title="Tags" detail="Every note gets these, so you can find them all in Obsidian." stack>
          <ChipList label="Tags" placeholder="Add a tag, like voice" items={notes.tags} onChange={tags => update({ notes: { tags: tags.map(tagOf).filter(Boolean) } })} />
        </Tile>}
      </TileGroup>
    </Section>

    <Section title="Preview" note={notes.dailyNote ? 'Each note is added to the end of that day’s file.' : undefined}>
      <div className="ui-tiles notes-preview" role="group" aria-label="Preview of a saved note">
        <div className="notes-file"><Icon name="note" size={16} /><span aria-live="polite">{preview?.fileName ?? ' '}</span></div>
        <pre className="notes-text">{preview && lines(preview.text)}</pre>
      </div>
    </Section>

    <Section title="With AI" note={claude
      ? 'If the AI is slow or can’t be reached, the note is saved as it is.'
      : <>These need Claude or a local model. <button type="button" className="link" onClick={() => { location.hash = 'settings/agents'; }}>Connect one</button></>}>
      <TileGroup>
        <Tile title="Name notes with AI" dim={!claude}>
          <Toggle label="Name notes with AI" checked={notes.claudeTitle} onChange={claudeTitle => update({ notes: { claudeTitle } })} />
        </Tile>
        <Tile title="To-dos" detail="Adds the to-dos it hears at the end of the note." dim={!claude}>
          <Toggle label="To-dos" checked={notes.claudeActions} onChange={claudeActions => update({ notes: { claudeActions } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}

// The preview's text, its front matter and headings set apart.
function lines(text: string) {
  let inFront = text.startsWith('---\n');
  return text.replace(/\n$/, '').split('\n').map((line, i) => {
    const kind = inFront ? 'meta' : line.startsWith('#') ? 'heading' : undefined;
    if (inFront && i > 0 && line === '---') inFront = false;
    return <span key={i} className={kind}>{line}{'\n'}</span>;
  });
}
