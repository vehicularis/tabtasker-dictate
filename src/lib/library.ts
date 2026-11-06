// The notes and meetings folders, as the window's lists know them.
import type { LibraryItem } from '../api/types';
import { listGroup, localDay } from './dates';

/// The lists open now: each one reads the folder again when asked (useLibrary adds itself).
export const readers = new Set<() => void>();
/// Every open list reads the folder again, after a change none of them would notice by itself: many archived at
/// once, or a note left empty and put in the Trash.
export const refreshLibrary = () => readers.forEach(read => read());
/// A note still under the name it was made with (nothing, or a date and "Note" or "Meeting", maybe a number):
/// the list calls it "New note", and one left like that with nothing in it goes to the Trash (NoteEditor).
export const isUnnamed = (title: string) => !title.trim() || /^\d{4}-\d{2}-\d{2}(?: \d{1,2}\.\d{2})? (?:Note|Meeting)(?: \d+)?$/.test(title.trim());
/// A file in the Archive folder of the folder it is listed under.
export const isArchived = (path: string) => /\/Archive\/[^/]+$/.test(path);
/// The route that opens a note or meeting.
export const routeTo = (kind: LibraryItem['kind'], path: string) => `${kind === 'note' ? 'notes' : 'meetings'}/${path}`;
/// A row's two lines. The title is the name the note was given; one still under the name it was made with is called
/// by its first sentence, as Apple Notes does, or "New note" while it's empty. The glance is what comes after: the
/// title isn't said twice when it's a line or a sentence of its own, and a transcript's "Name 00:00:09 Words" reads
/// as "Name: Words".
export const rowText = (item: LibraryItem) => {
  const text = item.excerpt.replace(/(\S+) \d{1,2}:\d{2}:\d{2} /g, '$1: ').trim();
  if (isUnnamed(item.title)) {
    const first = text.match(/^.{1,60}?(?:[.!?](?=\s)|$)/)?.[0] ?? text.slice(0, 60);
    return { title: first.replace(/[.!?]$/, '') || `New ${item.kind}`, glance: text.slice(first.length).trim() };
  }
  const rest = text.startsWith(item.title) ? text.slice(item.title.length) : null;
  return { title: item.title, glance: rest !== null && /^(?:[.!?:]|\s*$)/.test(rest) ? rest.replace(/^[\s.!?:]+/, '') : text };
};
/// The list, or the archive, for a search: every word of the query in the title or the excerpt (lower-cased by the
/// Mac's language), grouped by the day each was last changed, in the order given.
export const visibleGroups = (items: LibraryItem[], query: string, archived: boolean, now: number) => {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const today = localDay(now);
  return items.filter(item => item.archived === archived && words.every(word => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(word)))
    .reduce<{ title: string; items: LibraryItem[] }[]>((acc, item) => {
      const title = listGroup(localDay(item.modifiedMs), today), group = acc[acc.length - 1];
      if (group && group.title === title) group.items.push(item); else acc.push({ title, items: [item] });
      return acc;
    }, []);
};
