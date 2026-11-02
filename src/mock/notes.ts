import type { Mock } from '.';
import type { Settings } from '../store';

// In a browser: the notes folder, file names and front matter, composed as notes.rs composes them.

type Notes = Settings['notes'];
const VAULT = '/Users/you/Obsidian/Second Brain';
// The folders the picker hands out in turn: one inside an Obsidian vault, one plain.
const PICKS = [`${VAULT}/Inbox`, '/Users/you/Notes'];

const words = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');
const clean = (text: string) => words(text.replace(/[/:\p{Cc}]/gu, ' ')).replace(/^[. ]+/, '');
const cut = (text: string, bytes: number) => {
  let out = '';
  for (const char of text) { if (new TextEncoder().encode(out + char).length > bytes) break; out += char; }
  return out.trimEnd();
};
export const fileStem = (template: string, title: string, date: string, time: string) => {
  const name = template.replaceAll('{date}', date).replaceAll('{time}', time).replaceAll('{title}', cut(clean(title), 120) || 'Note');
  return cut(clean(name), 200) || 'Note';
};
const tag = (text: string) => words(text.trim().replace(/^#+/, '')).replaceAll(' ', '-');
const scalar = (value: string) => /^\p{L}[\p{L}\p{N}_/-]*$/u.test(value) && !['true', 'false', 'yes', 'no', 'on', 'off', 'null', 'y', 'n'].includes(value.toLowerCase()) ? value : JSON.stringify(value);

function compose(notes: Notes, title: string, body: string, actions: string | null, stamp: string) {
  const [date, clock] = stamp.split(' ');
  const [hour, minute] = clock.split('.');
  const tags = notes.tags.map(tag).filter(Boolean);
  const header = notes.frontmatter
    ? `---\ncreated: ${date}T${hour}:${minute}\n${tags.length ? `tags:\n${tags.map(one => `  - ${scalar(one)}\n`).join('')}` : 'tags: []\n'}source: TabTasker Dictate\n---\n\n`
    : '';
  const name = words(title), items = actions?.trim();
  const heading = notes.dailyNote ? `## ${hour}:${minute}${name ? ` ${name}` : ''}\n\n` : name ? `# ${name}\n\n` : '';
  const section = `${heading}${body.trim()}\n${items ? `\n${notes.dailyNote ? '###' : '##'} Action items\n\n${items}\n` : ''}`;
  return { stem: notes.dailyNote ? date : fileStem(notes.fileName, name, date, clock), header, section };
}

export function register(mock: Mock) {
  const folder = () => mock.settings().notes.folder ?? mock.status.notes;
  let picked = 0;
  mock.handle('notes_folder', () => {
    const path = folder();
    return { path, vault: path === VAULT || path.startsWith(`${VAULT}/`) ? 'Second Brain' : null };
  });
  mock.handle('choose_folder', ({ start }) => {
    const next = PICKS[picked++ % PICKS.length];
    return next === start ? PICKS[picked++ % PICKS.length] : next;
  });
  mock.handle('preview_note', ({ notes, title, body, actions, stamp }) => {
    const note = compose(notes as Notes, title as string, body as string, (actions as string | null) ?? null, stamp as string);
    return { fileName: `${note.stem}.md`, text: note.header + note.section };
  });
  mock.handle('save_note', ({ title, text, stamp }) => {
    if (!(text as string).trim()) throw 'Nothing to save';
    return `${folder()}/${compose(mock.settings().notes, title as string, text as string, null, stamp as string).stem}.md`;
  });
}
