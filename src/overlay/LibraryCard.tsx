import { useEffect, useRef, useState } from 'react';
import { invoke, listen } from '../bridge';
import type { LibraryItem } from '../store';
import { LibraryGlyph, NoteGlyph } from './glyphs';
import { Icon } from '../ui/Icon';
import { Logo, X } from './icons';
import { PREVIEW } from './preview';

const DAY = 86_400_000;
const localDay = (atMs: number) => Math.floor((atMs - new Date(atMs).getTimezoneOffset() * 60_000) / DAY);
/// "Today 09:41", "Yesterday 17:02", "Fri 30 Oct".
function when(atMs: number) {
  const day = localDay(atMs), today = localDay(Date.now());
  const clock = new Date(atMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (day === today) return `Today ${clock}`;
  if (day === today - 1) return `Yesterday ${clock}`;
  return new Date(atMs).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
const hour = 3_600_000;
const SAMPLE: LibraryItem[] = [
  { path: '/m/1', title: 'Design review', kind: 'meeting', modifiedMs: Date.now() - hour, words: 1240, excerpt: 'Thursday at 10 works for everyone; Maria has the big room.' },
  { path: '/n/1', title: 'Call the venue about Thursday', kind: 'note', modifiedMs: Date.now() - 3 * hour, words: 42, excerpt: 'Ask for the bigger room, then send Maria the new floor plan.' },
  { path: '/n/2', title: 'Ideas for the launch', kind: 'note', modifiedMs: Date.now() - 26 * hour, words: 310, excerpt: 'A short video first, then the three screenshots, then the pricing.' },
  { path: '/m/2', title: 'Weekly', kind: 'meeting', modifiedMs: Date.now() - 70 * hour, words: 2890, excerpt: 'Quick round, then the roadmap. The board deck has no draft yet.' },
];

// The Library, from the dots: your notes and meetings, newest first, in the overlay's glass. A click opens
// one in your Markdown app; the whole Library, with search across everything, is a page in Settings.
export function LibraryCard({ claudeCode, onClose, onError, onWriteNote }: { claudeCode: boolean; onClose: () => void; onError: (message: string) => void; onWriteNote: () => void }) {
  const [items, setItems] = useState<LibraryItem[] | null>(PREVIEW ? SAMPLE : null);
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const refresh = () => { if (!PREVIEW) void invoke<LibraryItem[]>('library_list').then(setItems, () => onError('Couldn’t read your notes.')); };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => listen('dictate-meeting', refresh), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { field.current?.focus(); }, []);
  const act = (command: string, path: string, fallback: string) => void invoke(command, { path }).catch(() => onError(fallback));
  const all = () => { onClose(); void invoke('open_settings', { route: 'library' }).catch(() => onError('Couldn’t open Settings')); };
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = (items ?? []).filter(item => words.every(word => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(word))).slice(0, 12);
  return <article className="glass card setup library" data-glass data-hit aria-label="Library">
    <header className="head"><Logo size={28} /><strong>Library</strong><button type="button" className="close" aria-label="Close" onClick={onClose}><X /></button></header>
    <label className="library-find"><Icon name="search" size={15} />
      <input ref={field} type="search" placeholder="Search notes and meetings" aria-label="Search the library" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} />
    </label>
    {items && !items.length && <p className="library-none">Nothing saved yet. Take a note from the dots, or start a meeting from their menu: each is saved here.</p>}
    {items && items.length > 0 && !shown.length && <p className="library-none">Nothing has those words.</p>}
    <ul className="ways library-list">
      {shown.map(item => <li key={item.path}>
        <span className="row-icon" aria-hidden="true">{item.kind === 'meeting' ? <Icon name="meeting" size={16} /> : <NoteGlyph size={18} />}</span>
        <button type="button" className="what library-open" onClick={() => act('library_open', item.path, 'Couldn’t open that file.')}>
          {item.title}<small>{item.kind === 'meeting' ? 'Meeting' : 'Note'} · {when(item.modifiedMs)}{item.excerpt ? ` · ${item.excerpt}` : ''}</small>
        </button>
        <span className="library-acts">
          <button type="button" className="tool" aria-label={`Show ${item.title} in Finder`} title="Show in Finder" onClick={() => act('show_notes', item.path, 'Couldn’t show that in Finder.')}><Icon name="folder" size={15} /></button>
          {claudeCode && <button type="button" className="tool" aria-label={`Send ${item.title} to Claude Code`} title="Send to Claude Code" onClick={() => act('send_to_claude_code', item.path, 'Couldn’t open Claude Code.')}><Icon name="claudeCode" size={15} /></button>}
        </span>
      </li>)}
    </ul>
    <footer className="actions">
      <button type="button" className="btn" onClick={onWriteNote}><NoteGlyph size={16} />Write a note</button>
      <span className="ask">{items ? `${items.filter(item => item.kind === 'note').length} notes, ${items.filter(item => item.kind === 'meeting').length} meetings` : ''}</span>
      <button type="button" className="btn" onClick={all}><LibraryGlyph size={16} />All of it</button>
    </footer>
  </article>;
}
