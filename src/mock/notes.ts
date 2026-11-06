import type { Mock } from '.';
import type { Settings } from '../api/types';

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
    ? `---\ncreated: ${date}T${hour}:${minute}\n${tags.length ? `tags:\n${tags.map(one => `  - ${scalar(one)}\n`).join('')}` : 'tags: []\n'}source: TabTasker | Dictate\n---\n\n`
    : '';
  const name = words(title), items = actions?.trim();
  const heading = notes.dailyNote ? `## ${hour}:${minute}${name ? ` ${name}` : ''}\n\n` : name ? `# ${name}\n\n` : '';
  const section = `${heading}${body.trim()}\n${items ? `\n${notes.dailyNote ? '###' : '##'} Action items\n\n${items}\n` : ''}`;
  return { stem: notes.dailyNote ? date : fileStem(notes.fileName, name, date, clock), header, section };
}

export function register(mock: Mock) {
  const folder = () => mock.settings().notes.folder ?? mock.status.notes;
  let picked = 0;
  // The Library: a few saved notes and meetings, as the folders would hold them. `?library=empty` has none.
  const hour = 3_600_000, now = Date.now();
  const library = new URLSearchParams(location.search).get('library') === 'empty' ? [] : [
    { path: `${folder()}/Meetings/2026-11-02 Design review.md`, title: 'Design review', kind: 'meeting', modifiedMs: now - hour, words: 1240, excerpt: 'You 00:00:04 Right, so Thursday at 10 works for everyone? Maria 00:00:09 Yes, I have the big room booked. We should start with the floor plan and then…' },
    { path: `${folder()}/2026-11-02 Call the venue.md`, title: 'Call the venue about Thursday', kind: 'note', modifiedMs: now - 3 * hour, words: 42, excerpt: 'Call the venue about Thursday and ask for the bigger room. Then send Maria the new floor plan before lunch. Call them Send the plan' },
    { path: `${folder()}/2026-11-02 Note 2.md`, title: '2026-11-02 Note 2', kind: 'note', modifiedMs: now - 2 * hour, words: 0, excerpt: '' }, // a note just made, empty
    { path: `${folder()}/2026-11-01 Ideas for the launch.md`, title: 'Ideas for the launch', kind: 'note', modifiedMs: now - 26 * hour, words: 310, excerpt: 'A short video first, then the three screenshots, then the pricing. Ask Sam whether the onboarding emails can go out the same morning.' },
    { path: `${folder()}/Meetings/2026-10-30 Weekly.md`, title: 'Weekly', kind: 'meeting', modifiedMs: now - 70 * hour, words: 2890, excerpt: 'You 00:00:02 Quick round, then the roadmap. Priya 00:00:15 The board deck has no draft yet…' },
    { path: `${folder()}/Archive/2026-10-12 Old plan.md`, title: 'Old plan', kind: 'note', modifiedMs: now - 500 * hour, words: 120, excerpt: 'The first plan for the launch, before the pricing changed.', archived: true },
  ].map(item => ({ archived: false, ...item }));
  mock.handle('library_list', () => library.map(item => ({ ...item }))); // fresh, as the app's IPC answers: the same array again would never re-render
  // Into the folder's Archive/ and back, as notes.rs moves the file.
  mock.handle('note_archive', ({ path, archived }) => {
    const found = library.find(item => item.path === path);
    if (!found) throw 'That file isn’t there any more.';
    const name = String(path).split('/').pop()!, dir = String(path).slice(0, -name.length - 1);
    found.archived = !!archived;
    found.path = archived ? (dir.endsWith('/Archive') ? found.path : `${dir}/Archive/${name}`) : (dir.endsWith('/Archive') ? `${dir.slice(0, -8)}/${name}` : found.path);
    return found.path;
  });
  mock.handle('library_open', () => {});
  // The editor: a note's title and body, in memory. A library item it has never seen reads as its excerpt.
  const docs = new Map<string, { title: string; body: string }>();
  const docOf = (path: string) => {
    const known = docs.get(path);
    if (known) return known;
    const item = library.find(one => one.path === path);
    if (!item) throw 'That file isn’t there any more.';
    const made = { title: item.title, body: item.words === 0 ? '' : item.kind === 'meeting' ? item.excerpt.replace(/ (\w+ \d\d:\d\d:\d\d) /g, '\n\n**$1** ') : `${item.excerpt}\n\n- [ ] Call them\n- [x] Send the plan\n` };
    docs.set(path, made);
    return made;
  };
  mock.handle('note_read', ({ path }) => {
    const item = library.find(one => one.path === path);
    const doc = docOf(path as string);
    return { path, title: doc.title, body: doc.body, kind: item?.kind ?? 'note', modifiedMs: item?.modifiedMs ?? Date.now() };
  });
  mock.handle('note_write', ({ path, title, body }) => {
    const doc = docOf(path as string);
    doc.title = title as string; doc.body = body as string;
    const item = library.find(one => one.path === path);
    if (item) { item.title = doc.title || item.path.split('/').pop()!.replace(/\.md$/, ''); item.excerpt = doc.body.replace(/[#>*_`-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 28).join(' '); item.modifiedMs = Date.now(); item.words = doc.body.split(/\s+/).filter(Boolean).length; }
    return Date.now();
  });
  mock.handle('note_new', ({ title, text, stamp }) => {
    const note = compose(mock.settings().notes, title as string, text as string, null, stamp as string);
    const path = `${folder()}/${note.stem}.md`;
    docs.set(path, { title: title as string, body: text as string });
    library.unshift({ path, title: (title as string) || note.stem, kind: 'note', modifiedMs: Date.now(), words: (text as string).split(/\s+/).filter(Boolean).length, excerpt: (text as string).slice(0, 160), archived: false });
    return path;
  });
  mock.handle('note_open', ({ path }) => { const item = library.find(one => one.path === path); location.hash = `${item?.kind === 'meeting' ? 'meetings' : 'notes'}/${encodeURIComponent(path as string)}`; });
  mock.handle('note_attach', ({ name, data }) => `data:image/${String(name).split('.').pop() === 'jpg' ? 'jpeg' : String(name).split('.').pop()};base64,${data}`); // the browser shows it from the data itself
  mock.handle('note_delete', ({ path }) => { const at = library.findIndex(one => one.path === path); if (at >= 0) library.splice(at, 1); docs.delete(path as string); });
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
