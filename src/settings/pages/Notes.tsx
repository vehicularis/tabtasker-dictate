import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '../../bridge';
import { tilde, useStatus, type PageProps, type Settings } from '../../store';
import { Button, ChipList, Icon, PageHeader, Section, Tile, TileGroup, Toggle } from '../../ui';
import './Notes.css';

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
  : name.trimStart().startsWith('.') ? 'A file name can’t start with a dot, which would hide the note.' : null;
// A tag as the front matter writes it: no leading #, words joined by hyphens.
const tagOf = (text: string) => text.trim().replace(/^#+/, '').split(/\s+/).filter(Boolean).join('-');
const two = (n: number) => String(n).padStart(2, '0');
const stampOf = (now: Date) => `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;

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
    void invoke<Preview>('preview_note', { notes: shown, title: SAMPLE.title, body: SAMPLE.body, actions, stamp: stampOf(new Date()) })
      .then(next => { if (live) setPreview(next); }).catch(() => {});
    return () => { live = false; };
  }, [previewKey]);

  const choose = async () => {
    setChoosing(true);
    setFolderProblem(null);
    try {
      const path = await invoke<string | null>('choose_folder', { message: 'Choose the folder your notes are saved in.', start: folder?.path ?? null });
      if (!path) return;
      const saved = await update({ notes: { folder: path } });
      if (saved && saved.notes.folder !== path) setFolderProblem('That folder can’t hold notes. Choose another one.');
    } catch (error) {
      setFolderProblem(typeof error === 'string' ? error : 'Couldn’t open the folder picker.');
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
    <PageHeader icon="note" title="Notes">Spoken notes are saved as Markdown files in a folder you choose.</PageHeader>

    <Section title="Folder" note={folderProblem ?? (notes.folder
      ? <>Notes are saved here from now on; notes already saved stay where they are. <button type="button" className="link" onClick={() => void update({ notes: { folder: null } })}>Use the default folder</button></>
      : 'Any folder works. Choose one inside an Obsidian vault and your notes show up in Obsidian.')}>
      <TileGroup label="Notes folder">
        <Tile title={<span className="notes-folder"><Icon name="folder" size={16} />{name}</span>} detail={path && <span className="notes-path">{tilde(path, status?.home)}</span>}>
          <Button variant="quiet" small onClick={() => void invoke('show_notes', {}).catch(() => setFolderProblem('Couldn’t open the folder in Finder.'))}>Show in Finder</Button>
          <Button disabled={choosing} onClick={() => void choose()}>Choose…</Button>
        </Tile>
        {folder?.vault && <Tile title={`Obsidian vault “${folder.vault}”`} detail="Notes show up in Obsidian as soon as they are saved, with their tags.">
          <span className="state" data-on><Icon name="check" size={14} />Obsidian</span>
        </Tile>}
      </TileGroup>
    </Section>

    <Section title="Files" note={templateProblem ? <span id={problemId} role="alert">{templateProblem}</span> : (!notes.dailyNote && notes.fileName !== DEFAULT_NAME
      ? <button type="button" className="link" onClick={() => void update({ notes: { fileName: DEFAULT_NAME } })}>Use the default name, {DEFAULT_NAME}</button> : undefined)}>
      <TileGroup>
        <Tile title="Daily note" detail="Adds each note to one file a day, named by its date, as a new section with the time.">
          <Toggle label="Daily note" checked={notes.dailyNote} onChange={dailyNote => update({ notes: { dailyNote } })} />
        </Tile>
        <Tile title="File name" detail={notes.dailyNote ? 'Not used while daily note is on.' : 'Filled in for each note. A name that is taken gets a number, so no note is ever replaced.'} stack dim={notes.dailyNote}>
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

    <Section title="Front matter">
      <TileGroup>
        <Tile title="Front matter" detail="A YAML header with when the note was made, its tags and “TabTasker Dictate” as its source.">
          <Toggle label="Front matter" checked={notes.frontmatter} onChange={frontmatter => update({ notes: { frontmatter } })} />
        </Tile>
        {notes.frontmatter && <Tile title="Tags" detail="Added to every note, so you can find them all in Obsidian." stack>
          <ChipList label="Tags" placeholder="Add a tag, like voice" items={notes.tags} onChange={tags => update({ notes: { tags: tags.map(tagOf).filter(Boolean) } })} />
        </Tile>}
      </TileGroup>
    </Section>

    <Section title="Preview" note={notes.dailyNote ? 'Each note is added to the end of the day’s file. The front matter is written once, when the day’s file is made.' : undefined}>
      <div className="ui-tiles notes-preview" role="group" aria-label="Preview of a saved note">
        <div className="notes-file"><Icon name="note" size={16} /><span aria-live="polite">{preview?.fileName ?? ' '}</span></div>
        <pre className="notes-text">{preview && lines(preview.text)}</pre>
      </div>
    </Section>

    <Section title="With Claude" note={claude
      ? 'Claude sees the note’s words, never your voice. When Claude is slow or unavailable, the note is saved as it is.'
      : <>These work once Claude is connected. <button type="button" className="link" onClick={() => { location.hash = 'claude'; }}>Connect Claude</button></>}>
      <TileGroup>
        <Tile title="Claude names the note" detail="A short title from what you said, unless you type one." dim={!claude}>
          <Toggle label="Claude names the note" checked={notes.claudeTitle} onChange={claudeTitle => update({ notes: { claudeTitle } })} />
        </Tile>
        <Tile title="Action items" detail="Claude adds a list of what to do at the end of the note." dim={!claude}>
          <Toggle label="Action items" checked={notes.claudeActions} onChange={claudeActions => update({ notes: { claudeActions } })} />
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
