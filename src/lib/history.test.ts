import { describe, expect, it } from 'vitest';
import { barHeight, byDay, figures, FLOOR, HEIGHT, removedBy, searchHistory, share, sharePercent } from './history';
import { DAY } from './dates';
import type { HistoryEntry, HistoryStats } from '../api/types';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({ atMs: 1, mode: 'dictate', bundleId: 'com.apple.Notes', appName: 'Notes', words: 3, seconds: 2, text: 'hello there', ...over });

describe('searchHistory', () => {
  const note = entry({ atMs: 1, mode: 'note', appName: 'Notes', text: 'Buy oat milk' });
  const app = entry({ atMs: 2, mode: 'dictate', appName: 'Slack', text: 'Lunch at noon' });
  const all = [note, app];
  it('gives every entry for an empty query', () => expect(searchHistory(all, '  ')).toEqual(all));
  it('needs every word, in any order and case, in the text', () => {
    expect(searchHistory(all, 'MILK buy')).toEqual([note]);
    expect(searchHistory(all, 'milk noon')).toEqual([]);
  });
  it('looks in the app name for an app entry', () => {
    expect(searchHistory(all, 'lunch slack')).toEqual([app]);
  });
  it('does not look in the app name for a note, since a note goes to a file', () => {
    expect(searchHistory(all, 'notes')).toEqual([]);
    expect(searchHistory([entry({ mode: 'dictate', appName: 'Notes', text: 'x' })], 'notes')).toHaveLength(1);
  });
  it('matches a word inside a longer word', () => expect(searchHistory(all, 'unc')).toEqual([app]));
  it('does not throw on emoji or regex characters', () => {
    expect(searchHistory([entry({ text: 'ok 👍 (done)' })], '👍 (done)')).toHaveLength(1);
    expect(searchHistory(all, '[')).toEqual([]);
  });
  it('finds a Turkish word by its lower case form', () => {
    expect(searchHistory([entry({ text: 'ISPARTA' })], 'isparta')).toHaveLength(1);
    expect(searchHistory([entry({ text: 'İstanbul' })], 'i̇stanbul')).toHaveLength(1);
  });
});

describe('removedBy', () => {
  const now = at(2026, 6, 15, 12);
  const old = (days: number, extra = 0) => entry({ atMs: now - days * DAY - extra });
  it('removes nothing for Forever, however old', () => expect(removedBy('forever', [old(4000)], now)).toBe(0));
  it('removes what is older than a day for a day, and keeps the rest', () => {
    expect(removedBy('day', [old(1, 1), old(1), old(1, -1), old(0)], now)).toBe(1);
  });
  it('cuts at a week', () => expect(removedBy('week', [old(7, 1), old(7), old(6)], now)).toBe(1));
  it('cuts at 30 days for a month', () => expect(removedBy('month', [old(30, 1), old(30), old(29)], now)).toBe(1));
  it('removes everything before now for Don’t keep, and keeps a future one', () => {
    expect(removedBy('off', [old(0, 1), old(5), entry({ atMs: now }), entry({ atMs: now + 1000 })], now)).toBe(2);
  });
  it('is 0 for no entries', () => expect(removedBy('off', [], now)).toBe(0));
});

describe('byDay', () => {
  it('is empty for nothing', () => expect(byDay([])).toEqual([]));
  it('groups by local day across midnight', () => {
    const a = entry({ atMs: at(2026, 6, 15, 23, 59) }), b = entry({ atMs: at(2026, 6, 15, 0, 1) }), c = entry({ atMs: at(2026, 6, 14, 23, 59) });
    const groups = byDay([a, b, c]);
    expect(groups.map(g => g.entries)).toEqual([[a, b], [c]]);
    expect(groups[0].day).toBe(Date.UTC(2026, 5, 15) / DAY);
  });
  it('starts a new group when a day comes back, as only adjacent entries join', () => {
    const d1 = entry({ atMs: at(2026, 6, 15, 10) }), d2 = entry({ atMs: at(2026, 6, 14, 10) }), d3 = entry({ atMs: at(2026, 6, 15, 9) });
    expect(byDay([d1, d2, d3]).map(g => g.entries.length)).toEqual([1, 1, 1]);
  });
  it('keeps a 25 hour November DST day as one group and the next day apart', () => {
    const first = entry({ atMs: at(2026, 11, 1, 0, 30) }), last = entry({ atMs: at(2026, 11, 1, 23, 30) }), next = entry({ atMs: at(2026, 11, 2, 0, 30) });
    expect(byDay([first, last, next]).map(g => g.entries.length)).toEqual([2, 1]);
    // The repeated 1 AM hour is the same day twice.
    expect(byDay([entry({ atMs: Date.UTC(2026, 10, 1, 5, 30) }), entry({ atMs: Date.UTC(2026, 10, 1, 6, 30) })])).toHaveLength(1);
  });
  it('keeps a 23 hour March DST day as one group', () => {
    expect(byDay([entry({ atMs: at(2026, 3, 8, 0, 30) }), entry({ atMs: at(2026, 3, 8, 23, 30) })])).toHaveLength(1);
  });
  it('splits 31 Dec and 1 Jan', () => {
    expect(byDay([entry({ atMs: at(2026, 1, 1, 0, 30) }), entry({ atMs: at(2025, 12, 31, 23, 30) })])).toHaveLength(2);
  });
});

describe('figures', () => {
  const stats: HistoryStats = { dictations: 1234, wordsToday: 56, wordsTotal: 12_345, wpm: 141.6, savedSeconds: 3600 * 2 + 600, streak: 3, today: 1, days: [], apps: [] };
  const by = (s: HistoryStats, label: string) => figures(s).find(f => f.label === label);
  it('lists the six in order', () => {
    expect(figures(stats).map(f => f.label)).toEqual(['Words today', 'Words in total', 'Day streak', 'Average speed', 'Time saved', 'Dictations']);
  });
  it('groups thousands', () => {
    expect(by(stats, 'Words in total')).toEqual({ label: 'Words in total', value: '12,345' });
    expect(by(stats, 'Dictations')?.value).toBe('1,234');
  });
  it('writes the streak singular for one day', () => {
    expect(by(stats, 'Day streak')).toMatchObject({ value: '3', unit: 'days' });
    expect(by({ ...stats, streak: 1 }, 'Day streak')).toMatchObject({ value: '1', unit: 'day' });
    expect(by({ ...stats, streak: 0 }, 'Day streak')).toMatchObject({ value: '0', unit: 'days' });
  });
  it('rounds the speed, and says Not yet with none', () => {
    expect(by(stats, 'Average speed')).toEqual({ label: 'Average speed', value: '142', unit: 'wpm', hint: 'How fast you talk' });
    expect(by({ ...stats, wpm: 0 }, 'Average speed')).toEqual({ label: 'Average speed', value: 'Not yet', hint: 'How fast you talk' });
  });
  it('words the time saved', () => {
    expect(by(stats, 'Time saved')).toEqual({ label: 'Time saved', value: '2', unit: 'h 10 min', hint: 'Compared with typing at 40 wpm' });
  });
});

describe('share', () => {
  it('is 0 of nothing', () => {
    expect(sharePercent(0, 0)).toBe(0);
    expect(share(0, 0)).toBe('0');
    expect(share(5, 0)).toBe('<1'); // Today's behaviour; see the report.
  });
  it('is <1 for some words that round to nothing', () => {
    expect(share(1, 1000)).toBe('<1');
    expect(share(4, 1000)).toBe('<1');
    expect(sharePercent(4, 1000)).toBe(0);
  });
  it('rounds to a whole percent from half up', () => {
    expect(share(5, 1000)).toBe('1');
    expect(share(1, 3)).toBe('33');
    expect(share(2, 3)).toBe('67');
  });
  it('is 100 for the total', () => expect(share(50, 50)).toBe('100'));
  it('is 0 for no words of a total', () => expect(share(0, 50)).toBe('0'));
});

describe('barHeight', () => {
  it('keeps a stub for an empty day', () => expect(barHeight(0, 100)).toBe(FLOOR));
  it('stands a little above the stub for a few words', () => expect(barHeight(1, 10_000)).toBe(FLOOR + 1));
  it('is the full height for the busiest day', () => expect(barHeight(100, 100)).toBe(HEIGHT));
  it('scales between', () => expect(barHeight(50, 100)).toBe(HEIGHT / 2));
});
