import { describe, expect, it } from 'vitest';
import { isArchived, isUnnamed, rowText, routeTo, visibleGroups } from './library';
import type { LibraryItem } from '../api/types';

describe('isUnnamed', () => {
  it('is false for a title someone wrote', () => {
    expect(isUnnamed('Groceries')).toBe(false);
    expect(isUnnamed('Meeting notes')).toBe(false);
    expect(isUnnamed('2026-06-15 Note about lunch')).toBe(false);
  });
  it('is true for nothing, or only spaces', () => {
    expect(isUnnamed('')).toBe(true);
    expect(isUnnamed('   ')).toBe(true);
    expect(isUnnamed('\n\t')).toBe(true);
  });
  it('is true for a date and Note or Meeting', () => {
    expect(isUnnamed('2026-06-15 Note')).toBe(true);
    expect(isUnnamed('2026-06-15 Meeting')).toBe(true);
  });
  it('is true with a time, in one or two digit hours', () => {
    expect(isUnnamed('2026-06-15 9.05 Note')).toBe(true);
    expect(isUnnamed('2026-06-15 14.30 Meeting')).toBe(true);
  });
  it('is true with a number after it', () => {
    expect(isUnnamed('2026-06-15 Note 2')).toBe(true);
    expect(isUnnamed('2026-06-15 14.30 Meeting 12')).toBe(true);
  });
  it('ignores spaces around it', () => {
    expect(isUnnamed('  2026-06-15 Note  ')).toBe(true);
  });
  it('is false for forms it does not recognise', () => {
    expect(isUnnamed('2026-06-15')).toBe(false);
    expect(isUnnamed('2026-06-15 note')).toBe(false); // the match is case sensitive
    expect(isUnnamed('2026-06-15 Notes')).toBe(false);
    expect(isUnnamed('2026-06-15 14:30 Note')).toBe(false);
    expect(isUnnamed('2026-6-15 Note')).toBe(false);
    expect(isUnnamed('2026-06-15 Note 2 copy')).toBe(false);
    expect(isUnnamed('New note')).toBe(false);
  });
});

const item = (over: Partial<LibraryItem>): LibraryItem => ({ path: 'p.md', title: 'Groceries', kind: 'note', modifiedMs: 0, words: 0, excerpt: '', archived: false, ...over });

describe('rowText', () => {
  it('keeps a given title and drops it from the start of the glance', () => {
    expect(rowText(item({ excerpt: 'Groceries. Milk and eggs' }))).toEqual({ title: 'Groceries', glance: 'Milk and eggs' });
    expect(rowText(item({ excerpt: 'Groceries: milk' }))).toEqual({ title: 'Groceries', glance: 'milk' });
    expect(rowText(item({ excerpt: 'Groceries' }))).toEqual({ title: 'Groceries', glance: '' });
  });
  it('shows the whole excerpt when it does not start with the title, or only starts with its letters', () => {
    expect(rowText(item({ excerpt: 'Milk and eggs' }))).toEqual({ title: 'Groceries', glance: 'Milk and eggs' });
    expect(rowText(item({ excerpt: 'Groceries list for Friday' }))).toEqual({ title: 'Groceries', glance: 'Groceries list for Friday' });
  });
  it('reads a transcript row\'s timestamps as "Name: Words"', () => {
    expect(rowText(item({ title: 'Standup', kind: 'meeting', excerpt: 'Standup 00:00:09 Hello there' }))).toEqual({ title: 'Standup', glance: 'Hello there' });
    expect(rowText(item({ title: 'Plan', excerpt: 'Ana 00:00:09 Hello. Bob 1:02:03 Hi' }))).toEqual({ title: 'Plan', glance: 'Ana: Hello. Bob: Hi' });
  });
  it('calls an unnamed note by its first sentence', () => {
    expect(rowText(item({ title: '2026-06-15 Note', excerpt: 'Buy milk. Then eggs.' }))).toEqual({ title: 'Buy milk', glance: 'Then eggs.' });
    expect(rowText(item({ title: '', excerpt: 'Is it done? Yes' }))).toEqual({ title: 'Is it done', glance: 'Yes' });
  });
  it('calls an unnamed transcript by its first sentence, timestamps read as a colon', () => {
    expect(rowText(item({ title: '2026-06-15 14.30 Meeting', kind: 'meeting', excerpt: 'Ana 00:00:09 Hello. Bye' }))).toEqual({ title: 'Ana: Hello', glance: 'Bye' });
  });
  it('does not end a sentence at a dot inside a word', () => {
    expect(rowText(item({ title: '', excerpt: 'Version 1.2 is out. Update' }))).toEqual({ title: 'Version 1.2 is out', glance: 'Update' });
  });
  it('cuts a long unpunctuated start at 60 characters', () => {
    const long = 'word '.repeat(20).trim();
    expect(rowText(item({ title: '', excerpt: long }))).toEqual({ title: long.slice(0, 60), glance: long.slice(60).trim() });
  });
  it('says New note or New meeting while an unnamed one is empty', () => {
    expect(rowText(item({ title: '2026-06-15 Note', excerpt: '' }))).toEqual({ title: 'New note', glance: '' });
    expect(rowText(item({ title: '', kind: 'meeting', excerpt: '   ' }))).toEqual({ title: 'New meeting', glance: '' });
    // Today's behaviour; see the report. Only one closing mark is cut, so "..." is a title of "..".
    expect(rowText(item({ title: '', excerpt: '...' }))).toEqual({ title: '..', glance: '' });
  });
  it('keeps a title that is a date stamp with more after it', () => {
    expect(rowText(item({ title: '2026-06-15 Note about lunch', excerpt: 'Soup' }))).toEqual({ title: '2026-06-15 Note about lunch', glance: 'Soup' });
  });
});

describe('isArchived and routeTo', () => {
  it('knows a file in an Archive folder', () => {
    expect(isArchived('/Users/me/Notes/Archive/a.md')).toBe(true);
    expect(isArchived('/Users/me/Notes/a.md')).toBe(false);
    expect(isArchived('/Users/me/Notes/Archive/deep/a.md')).toBe(false);
    expect(isArchived('Archive/a.md')).toBe(false); // needs a slash before it
    expect(isArchived('')).toBe(false);
  });
  it('routes notes to notes/ and meetings to meetings/', () => {
    expect(routeTo('note', 'a/b.md')).toBe('notes/a/b.md');
    expect(routeTo('meeting', 'a/b.md')).toBe('meetings/a/b.md');
  });
});

describe('visibleGroups', () => {
  const now = Date.UTC(2026, 5, 15, 16); // 12:00 on 15 June 2026 in New York
  const day = 86_400_000;
  const items = [
    item({ path: '1', title: 'Today A', modifiedMs: now - 1000, excerpt: 'alpha beta' }),
    item({ path: '2', title: 'Today B', modifiedMs: now - 2000, excerpt: 'gamma' }),
    item({ path: '3', title: 'Yesterday', modifiedMs: now - day, excerpt: 'alpha' }),
    item({ path: '4', title: 'Old', modifiedMs: now - 40 * day, excerpt: 'delta', archived: true }),
  ];
  const titles = (groups: ReturnType<typeof visibleGroups>) => groups.map(group => [group.title, group.items.map(one => one.path)]);
  it('groups the list by day, in the order given', () => {
    expect(titles(visibleGroups(items, '', false, now))).toEqual([['Today', ['1', '2']], ['Yesterday', ['3']]]);
  });
  it('shows the archive apart from the list', () => {
    expect(visibleGroups(items, '', true, now).flatMap(group => group.items.map(one => one.path))).toEqual(['4']);
  });
  it('is empty for no items', () => {
    expect(visibleGroups([], '', false, now)).toEqual([]);
  });
  it('matches one word in the title or the excerpt, whatever its case', () => {
    expect(visibleGroups(items, 'ALPHA', false, now).flatMap(group => group.items.map(one => one.path))).toEqual(['1', '3']);
    expect(visibleGroups(items, '  yesterday ', false, now).flatMap(group => group.items.map(one => one.path))).toEqual(['3']);
  });
  it('needs every word of a two-word query, found in the title and the excerpt separately', () => {
    expect(visibleGroups(items, 'today gamma', false, now).flatMap(group => group.items.map(one => one.path))).toEqual(['2']);
    expect(visibleGroups(items, 'today yesterday', false, now)).toEqual([]);
  });
  it('matches inside a word, and an empty or blank query shows everything', () => {
    expect(visibleGroups(items, 'lph', false, now).flatMap(group => group.items.map(one => one.path))).toEqual(['1', '3']);
    expect(visibleGroups(items, '   ', false, now).flatMap(group => group.items).length).toBe(3);
  });
  it('splits a day that comes back later into its own group, as the list is sorted newest first', () => {
    const mixed = [items[0], items[2], item({ path: '5', modifiedMs: now - 3000 })];
    expect(titles(visibleGroups(mixed, '', false, now))).toEqual([['Today', ['1']], ['Yesterday', ['3']], ['Today', ['5']]]);
  });
  describe('Turkish İstanbul', () => {
    const turkish = [item({ path: 't', title: 'Trip', excerpt: 'İstanbul in May' })];
    const found = (query: string, list = turkish) => visibleGroups(list, query, false, now).length > 0;
    it('finds İstanbul with İstanbul', () => { expect(found('İstanbul')).toBe(true); });
    // Today's behaviour; see the report.
    it('does not find İstanbul with istanbul, nor istanbul with İstanbul (the folding is not changed)', () => {
      expect(found('istanbul')).toBe(false);
      expect(found('İstanbul', [item({ title: 'Trip', excerpt: 'istanbul in May' })])).toBe(false);
      expect(found('istanbul', [item({ title: 'Trip', excerpt: 'istanbul in May' })])).toBe(true);
    });
  });
});
