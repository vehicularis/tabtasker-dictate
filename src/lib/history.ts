// The dictation history page's rules: what search finds, what a shorter Keep removes, how days group, and the numbers it shows.
import type { HistoryEntry, HistoryStats, Keep } from '../api/types';
import { DAY, localDay } from './dates';
import { duration } from './format';
import { fold, searchWords } from './text';

/// How long each Keep holds on to the words, as history.rs prunes them; null is for good.
const AGE: Record<Keep, number | null> = { off: 0, day: DAY, week: 7 * DAY, month: 30 * DAY, forever: null };
/// What search looks through: a note shows no app, since it goes to a file.
const searchable = (entry: HistoryEntry) => entry.mode === 'note' ? entry.text : `${entry.text} ${entry.appName}`;

/// The entries that hold every word of the query, whatever its case (folded, as text.ts says).
export const searchHistory = (entries: HistoryEntry[], query: string) => {
  const words = searchWords(query);
  return entries.filter(entry => words.every(word => fold(searchable(entry)).includes(word)));
};
/// How many kept dictations a shorter Keep deletes at once: those older than its cutoff.
export const removedBy = (keep: Keep, entries: HistoryEntry[], now: number): number => {
  const age = AGE[keep];
  const before = age === null ? -Infinity : now - age;
  return entries.filter(entry => entry.atMs < before).length;
};
/// The entries in runs of one local day, in the order given (a day that comes back starts a new run).
export function byDay(entries: HistoryEntry[]) {
  const groups: { day: number; entries: HistoryEntry[] }[] = [];
  for (const entry of entries) {
    const day = localDay(entry.atMs);
    if (groups.at(-1)?.day === day) groups.at(-1)!.entries.push(entry); else groups.push({ day, entries: [entry] });
  }
  return groups;
}
/// The stats page's figures, each with its label and an optional unit and hint.
export function figures(stats: HistoryStats): { label: string; value: string; unit?: string; hint?: string }[] {
  const saved = duration(stats.savedSeconds);
  return [
    { label: 'Words today', value: stats.wordsToday.toLocaleString() },
    { label: 'Words in total', value: stats.wordsTotal.toLocaleString() },
    { label: 'Day streak', value: stats.streak.toLocaleString(), unit: stats.streak === 1 ? 'day' : 'days' },
    { label: 'Average speed', ...(stats.wpm > 0 ? { value: Math.round(stats.wpm).toLocaleString(), unit: 'wpm' } : { value: 'Not yet' }), hint: 'How fast you talk' },
    { label: 'Time saved', value: saved.value, unit: saved.unit, hint: 'Compared with typing at 40 wpm' },
    { label: 'Dictations', value: stats.dictations.toLocaleString() },
  ];
}
/// A part of a total as a whole percent; 0 when there is no total.
export const sharePercent = (part: number, total: number) => total ? Math.round((part / total) * 100) : 0;
/// The same for reading: "<1" for some words that round to nothing (no % sign).
export const share = (part: number, total: number) => part && sharePercent(part, total) === 0 ? '<1' : String(sharePercent(part, total));

// The chart's bars rise from a baseline HEIGHT tall; an empty day keeps a FLOOR stub and any words stand above it.
export const HEIGHT = 96, FLOOR = 3;
/// A day's bar, against the busiest day.
export const barHeight = (words: number, most: number) => words ? Math.max(FLOOR + 1, (words / most) * HEIGHT) : FLOOR;
