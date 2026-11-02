import { useCallback, useEffect, useState } from 'react';
import { invoke, listen } from '../../bridge';
import type { LibraryItem, PageProps } from '../../store';
import { Button, EmptyState, Icon, PageHeader, Section, Segmented, Tile, TileGroup } from '../../ui';
import './Library.css';

type Shown = 'all' | 'note' | 'meeting';
const SHOWN: { value: Shown; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'note', label: 'Notes' }, { value: 'meeting', label: 'Meetings' }];
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
const count = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;
const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;

/// Everything you have said that became a file: every note and meeting, newest first, with a taste of
/// each, to open, show in Finder or hand to Claude Code. What you dictated into apps is in History.
export function Library({ settings }: PageProps) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<Shown>('all');
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useCallback(() => { void invoke<LibraryItem[]>('library_list').then(setItems, error => setProblem(message(error, 'Couldn’t read your notes.'))); }, []);
  useEffect(refresh, [refresh]);
  // A note saved, a meeting finished, or the window coming back: the list reads the folders again.
  useEffect(() => listen('dictate-meeting', refresh), [refresh]);
  useEffect(() => { addEventListener('focus', refresh); return () => removeEventListener('focus', refresh); }, [refresh]);
  const act = (command: string, path: string, fallback: string) => void invoke(command, { path }).catch(error => setProblem(message(error, fallback)));

  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (items ?? []).filter(item => (shown === 'all' || item.kind === shown) && words.every(word => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(word)));
  const today = localDay(Date.now());
  const groups: { day: number; items: LibraryItem[] }[] = [];
  for (const item of matches) {
    const day = localDay(item.modifiedMs);
    if (groups.at(-1)?.day === day) groups.at(-1)!.items.push(item); else groups.push({ day, items: [item] });
  }
  const notes = items?.filter(item => item.kind === 'note').length ?? 0, meetings = items?.filter(item => item.kind === 'meeting').length ?? 0;

  return <>
    <PageHeader icon="library" title="Library">Every note and meeting you have saved, newest first.</PageHeader>
    <Section note={problem ?? (items?.length ? `${count(notes, 'note')} and ${count(meetings, 'meeting')}, as Markdown files you can open in any app.` : undefined)}>
      <div className="library-bar">
        <label className="ui-field library-search"><Icon name="search" size={15} />
          <input type="search" placeholder="Search your notes and meetings" aria-label="Search the library" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} />
        </label>
        <Segmented label="Show" value={shown} options={SHOWN} onChange={setShown} />
        <Button variant="quiet" small icon="folder" onClick={() => void invoke('show_notes', {}).catch(() => setProblem('Couldn’t open the folder in Finder.'))}>Finder</Button>
      </div>
      {items && !items.length && <EmptyState icon="library" title="Nothing saved yet">
        Click the note button on the dots and talk for as long as you like, or start a meeting from the dots’ menu. Each one is saved here as a Markdown file.
      </EmptyState>}
      {items && items.length > 0 && !matches.length && <EmptyState icon="search" title="No matches">Nothing in your {shown === 'all' ? 'library' : shown === 'note' ? 'notes' : 'meetings'} has those words.</EmptyState>}
      {groups.map(group => <div key={group.day}>
        <h3 className="library-day">{dayTitle(group.day, today)}</h3>
        <TileGroup>
          {group.items.map(item => <article key={item.path} className="library-item" aria-label={item.title}>
            <span className="library-kind" data-kind={item.kind}><Icon name={item.kind === 'meeting' ? 'meeting' : 'note'} size={16} /></span>
            <div className="library-what">
              <button type="button" className="library-title" onClick={() => act('note_open', item.path, 'Couldn’t open that note.')}>{item.title}</button>
              {item.excerpt && <p className="library-excerpt">{item.excerpt}</p>}
              <p className="library-meta">{item.kind === 'meeting' ? 'Meeting' : 'Note'} · {clock(item.modifiedMs)} · {count(item.words, 'word')}</p>
            </div>
            <div className="library-actions">
              <Button small variant="quiet" aria-label={`Open ${item.title} in another app`} title="Open in another app" icon="external" onClick={() => act('library_open', item.path, 'Couldn’t open that file.')} />
              <Button small variant="quiet" aria-label={`Show ${item.title} in Finder`} title="Show in Finder" icon="folder" onClick={() => act('show_notes', item.path, 'Couldn’t show that in Finder.')} />
              {settings.claude.claudeCode && <Button small variant="quiet" aria-label={`Send ${item.title} to Claude Code`} title="Send to Claude Code" icon="claudeCode" onClick={() => act('send_to_claude_code', item.path, 'Couldn’t open Claude Code.')} />}
              <Button small onClick={() => act('note_open', item.path, 'Couldn’t open that note.')}>Open</Button>
            </div>
          </article>)}
        </TileGroup>
      </div>)}
    </Section>
    <Section title="Dictations">
      <TileGroup>
        <Tile title="What you typed by voice" detail="Everything dictated into other apps, with the typing it saved, is under History & stats.">
          <Button small onClick={() => { location.hash = 'history'; }}>History & stats</Button>
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
