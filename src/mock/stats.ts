import type { Mock } from '.';
import { DAY, localDay } from '../lib/dates';
import type { HistoryEntry, HistoryStats, Keep } from '../api/types';

// In a browser: a month of sample dictations, with history.rs's pruning and stats math.
// `?history=empty` starts with nothing said.

const SAMPLES: [Pick<HistoryEntry, 'mode' | 'bundleId' | 'appName'>, string][] = [
  [{ mode: 'dictate', bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' }, 'Sounds good, I’ll pick up the onboarding copy after lunch and send it over for review.'],
  [{ mode: 'dictate', bundleId: 'com.apple.mail', appName: 'Mail' }, 'Hi Maria, thanks for the quick turnaround. The contract looks right to me, so let’s sign this week. Best, Can.'],
  [{ mode: 'dictate', bundleId: 'com.todesktop.230313mzl4w4u92', appName: 'Cursor' }, 'Add a test that a corrupt line in the history file is skipped and the rest still loads.'],
  [{ mode: 'note', bundleId: 'com.apple.finder', appName: 'Finder' }, 'Ideas for the launch. Lead with privacy: everything runs on the Mac, and nothing is sent anywhere unless you connect Claude. Show the dots first, then a real dictation in Slack, then a note saved straight into an Obsidian vault. Keep the video under a minute and end on the shortcut, so people remember the one thing they need: hold the key and talk. A second cut for social can be fifteen seconds, the dots and one sentence typed.'],
  [{ mode: 'dictate', bundleId: 'com.apple.MobileSMS', appName: 'Messages' }, 'On my way, see you in ten'],
  [{ mode: 'command', bundleId: 'com.apple.mail', appName: 'Mail' }, 'Make this friendlier and shorter'],
  [{ mode: 'dictate', bundleId: 'notion.id', appName: 'Notion' }, 'Decision: we ship the menu bar app first and keep the iPhone version for after the summer.'],
  [{ mode: 'handsfree', bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' }, 'Quick update for the team. The build is notarized and stapled, I tested it on a clean Mac and it opens fine. I’ll send the link in the release channel once Can has had a look.'],
  [{ mode: 'dictate', bundleId: 'com.linear', appName: 'Linear' }, 'History search should match the app name too, not only the words.'],
];

// A fixed sequence, so every reload shows the same month.
const seeded = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function sample(): HistoryEntry[] {
  const random = seeded(7);
  const entries: HistoryEntry[] = [];
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const hoursToday = Math.max(0.05, (Date.now() - midnight.getTime()) / 3_600_000 - 0.2);
  for (let ago = 29; ago >= 0; ago--) {
    if (ago > 9 && random() < 0.22) continue; // a few quiet days, then a streak up to today
    const count = 1 + Math.floor(random() * 7);
    for (let i = 0; i < count; i++) {
      const [shape, text] = SAMPLES[Math.floor(random() * SAMPLES.length)];
      const words = text.split(/\s+/).length;
      const hour = ago ? 8 + random() * 11 : random() * hoursToday;
      entries.push({ ...shape, text, words, seconds: words / (2.1 + random() * 0.9), atMs: Math.round(midnight.getTime() - ago * DAY + hour * 3_600_000) });
    }
  }
  entries.sort((a, b) => a.atMs - b.atMs);
  for (let i = 1; i < entries.length; i++) entries[i].atMs = Math.max(entries[i].atMs, entries[i - 1].atMs + 1); // the time is the id
  return entries;
}

const AGE: Record<Keep, number | null> = { off: -Infinity, day: DAY, week: 7 * DAY, month: 30 * DAY, forever: null };

function stats(entries: HistoryEntry[]): HistoryStats {
  const today = localDay(Date.now());
  const days = Array<number>(30).fill(0);
  const active = new Set<number>();
  const apps = new Map<string, { bundleId: string; name: string; words: number }>();
  let wordsToday = 0, wordsTotal = 0, spokenWords = 0, spokenSeconds = 0;
  for (const entry of entries) {
    const on = localDay(entry.atMs);
    wordsTotal += entry.words;
    if (on === today) wordsToday += entry.words;
    if (today - on >= 0 && today - on < 30) days[29 - (today - on)] += entry.words;
    if (entry.seconds > 0) { spokenWords += entry.words; spokenSeconds += entry.seconds; }
    if (entry.words) active.add(on);
    const key = entry.bundleId || entry.appName;
    if (entry.mode !== 'note' && key && entry.words) {
      const app = apps.get(key) ?? { bundleId: entry.bundleId, name: '', words: 0 };
      app.words += entry.words;
      if (entry.appName) app.name = entry.appName;
      apps.set(key, app);
    }
  }
  let streak = 0;
  for (let on = active.has(today) ? today : today - 1; active.has(on); on--) streak++;
  return {
    dictations: entries.length, wordsToday, wordsTotal, wpm: spokenSeconds ? spokenWords / (spokenSeconds / 60) : 0,
    savedSeconds: Math.max(0, wordsTotal / 40 * 60 - spokenSeconds), streak, today, days,
    apps: [...apps.values()].map(app => ({ ...app, name: app.name || app.bundleId })).sort((a, b) => b.words - a.words || a.name.localeCompare(b.name)).slice(0, 5),
  };
}

export function register(mock: Mock) {
  const entries = new URLSearchParams(location.search).get('history') === 'empty' ? [] : sample();
  const prune = () => {
    const age = AGE[mock.settings().history.keep];
    if (age !== null) for (const entry of entries) if (entry.atMs < Date.now() - age) entry.text = '';
  };
  mock.handle('history_list', () => { prune(); return entries.filter(entry => entry.text).reverse(); });
  mock.handle('history_stats', () => { prune(); return stats(entries); });
  mock.handle('history_delete', ({ at }) => { for (const entry of entries) if (entry.atMs === at) entry.text = ''; });
  mock.handle('history_clear', () => { for (const entry of entries) entry.text = ''; });
  mock.handle('history_type', ({ at }) => { if (!entries.some(entry => entry.atMs === at && entry.text)) throw 'That dictation is no longer kept'; });
}
