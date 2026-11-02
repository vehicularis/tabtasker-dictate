import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { invoke, listen } from '../../bridge';
import type { DictateKey, HistoryEntry, HoldMode, Keep, PageProps } from '../../store';
import { Button, EmptyState, Icon, PageHeader, Section, Select, Tile, TileGroup, Toast } from '../../ui';
import './History.css';

/// history.rs's stats: `today` is a local day number (days since 1970-01-01 on this Mac) and `days`
/// the words on each of the last 30, ending on it.
export type HistoryStats = {
  dictations: number; wordsToday: number; wordsTotal: number; wpm: number; savedSeconds: number; streak: number;
  today: number; days: number[]; apps: { bundleId: string; name: string; words: number }[];
};

const KEEP: { value: Keep; label: string }[] = [
  { value: 'off', label: 'Don’t keep' }, { value: 'day', label: 'For a day' }, { value: 'week', label: 'For a week' }, { value: 'month', label: 'For a month' }, { value: 'forever', label: 'Forever' },
];
const KEY: Record<DictateKey, string> = { fn: 'fn', rightCommand: 'right ⌘', rightOption: 'right ⌥', rightControl: 'right ⌃', rightShift: 'right ⇧' };
const MODE: Partial<Record<HoldMode, string>> = { note: 'Note', command: 'Command', handsfree: 'Hands-free' };
const DAY = 86_400_000;
const PAGE = 100;
/// How long each Keep holds on to the words, as history.rs prunes them; null is for good.
const AGE: Record<Keep, number | null> = { off: 0, day: DAY, week: 7 * DAY, month: 30 * DAY, forever: null };
const FOR: Record<Keep, string> = { off: '', day: ' for a day', week: ' for a week', month: ' for a month', forever: '' };
/// What search looks through: a note shows no app, since it goes to a file.
const searchable = (entry: HistoryEntry) => entry.mode === 'note' ? entry.text : `${entry.text} ${entry.appName}`;
/// Focus for after a confirm closes, which would otherwise drop it to the page.
const refocus = (selector: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
const KEEP_SELECT = 'select[aria-label="Keep what you said"]';

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const localDay = (atMs: number) => Math.floor((atMs - new Date(atMs).getTimezoneOffset() * 60_000) / DAY);
/// A local day number as a date; the number already holds the time zone, so it is read as UTC.
const dateOf = (day: number, options: Intl.DateTimeFormatOptions) => new Date(day * DAY).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: minutes.toLocaleString(), unit: 'min' };
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return { value: hours.toLocaleString(), unit: rest ? `h ${rest} min` : 'h' };
}
function dayTitle(day: number, today: number) {
  if (day === today) return 'Today';
  if (day === today - 1) return 'Yesterday';
  const thisYear = dateOf(day, { year: 'numeric' }) === dateOf(today, { year: 'numeric' });
  return dateOf(day, { weekday: 'long', month: 'long', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* a web view without the async clipboard */ }
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy');
}

export function History({ settings, update }: PageProps) {
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [clearing, setClearing] = useState(false);
  /// A shorter Keep waiting on a confirm, with how many kept dictations it removes.
  const [narrowing, setNarrowing] = useState<{ keep: Keep; removes: number } | null>(null);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const keep = settings.history.keep;

  const fail = useCallback((error: unknown, fallback: string) => setToast({ message: typeof error === 'string' ? error : fallback, error: true }), []);
  const refresh = useCallback(() => {
    void invoke<HistoryStats>('history_stats').then(setStats).catch(error => fail(error, 'Couldn’t read your stats'));
    void invoke<HistoryEntry[]>('history_list').then(setEntries).catch(error => fail(error, 'Couldn’t read your history'));
  }, [fail]);
  // A change to Keep prunes on the next read, so read again.
  useEffect(refresh, [refresh, keep]);
  useEffect(() => listen('dictate-history', refresh), [refresh]);
  useEffect(() => { addEventListener('focus', refresh); return () => removeEventListener('focus', refresh); }, [refresh]);
  const hideToast = useCallback(() => setToast(null), []);

  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (entries ?? []).filter(entry => words.every(word => searchable(entry).toLocaleLowerCase().includes(word)));
  const today = stats?.today ?? localDay(Date.now());

  const remove = (entry: HistoryEntry) => {
    const next = matches[matches.indexOf(entry) + 1] ?? matches[matches.indexOf(entry) - 1];
    void invoke('history_delete', { at: entry.atMs }).then(() => {
      setEntries(all => all?.filter(other => other.atMs !== entry.atMs) ?? null);
      // Focus stays in the list rather than falling back to the page.
      requestAnimationFrame(() => (list.current?.querySelector<HTMLElement>(`[data-at="${next?.atMs}"] [data-action="delete"]`) ?? document.querySelector<HTMLElement>('.history-search input'))?.focus());
    }).catch(error => fail(error, 'Couldn’t delete that'));
  };
  const clear = () => {
    setClearing(false);
    void invoke('history_clear').then(() => {
      refresh();
      setToast({ message: 'History cleared' });
      refocus(KEEP_SELECT);
    }).catch(error => fail(error, 'Couldn’t clear history'));
  };
  // A shorter Keep removes words at once and for good, so it asks first, as Clear does.
  const choose = (next: Keep) => {
    const age = AGE[next];
    const before = age === null ? -Infinity : Date.now() - age;
    const removes = (entries ?? []).filter(entry => entry.atMs < before).length;
    if (removes) setNarrowing({ keep: next, removes }); else void update({ history: { keep: next } });
  };
  const narrow = (confirmed: boolean) => {
    if (confirmed && narrowing) void update({ history: { keep: narrowing.keep } });
    setNarrowing(null);
    refocus(KEEP_SELECT);
  };
  const copy = (entry: HistoryEntry) => void copyText(entry.text).then(() => setToast({ message: 'Copied' })).catch(() => fail(null, 'Couldn’t copy that'));
  const type = (entry: HistoryEntry) => void invoke('history_type', { at: entry.atMs }).catch(error => fail(error, 'Couldn’t type that'));

  const visible = matches.slice(0, shown);
  const groups: { day: number; entries: HistoryEntry[] }[] = [];
  for (const entry of visible) {
    const day = localDay(entry.atMs);
    if (groups.at(-1)?.day === day) groups.at(-1)!.entries.push(entry); else groups.push({ day, entries: [entry] });
  }

  return <>
    <PageHeader icon="history" title="History & stats">What you dictated, and how much typing it saved.</PageHeader>
    {stats && <>
      <Section title="Stats">
        <Figures stats={stats} />
      </Section>
      <Section title="Last 30 days">
        <Chart stats={stats} />
      </Section>
      <Section title="Top apps" note={stats.apps.length ? 'Notes aren’t counted here: they go to a file, not an app.' : undefined}>
        <TileGroup label="Top apps">
          {stats.apps.length
            ? stats.apps.map(app => <Tile key={app.bundleId || app.name} title={app.name} detail={count(app.words, 'word')}>
              <Share part={app.words} of={stats.wordsTotal} label={`${app.name}’s share of your words`} />
            </Tile>)
            : <Tile title="No apps yet" detail="The apps you dictate into show up here, with how much you said in each." dim />}
        </TileGroup>
      </Section>
    </>}
    <Section title="History" note="Word counts and times are always kept for your stats. Everything stays on this Mac.">
      <TileGroup>
        {narrowing
          ? <Tile title={narrowing.keep === 'off' ? 'Stop keeping what you say?' : `Keep what you said${FOR[narrowing.keep]}?`}
            detail={`Removes ${count(narrowing.removes, 'dictation')} for good. Your stats stay.`}>
            <Button variant="quiet" onClick={() => narrow(false)} autoFocus>Cancel</Button>
            <Button variant="danger" onClick={() => narrow(true)}>Remove</Button>
          </Tile>
          : <Tile title="Keep what you said" detail="Older dictations are removed for good.">
            <Select label="Keep what you said" value={keep} options={KEEP} onChange={choose} />
          </Tile>}
        <Tile title={clearing ? 'Clear all of your history?' : 'Clear history'} detail="Removes what you said from your history on this Mac. Saved notes and your stats stay.">
          {clearing
            ? <><Button variant="quiet" onClick={() => { setClearing(false); refocus('[data-action="clear"]'); }} autoFocus>Cancel</Button>
              <Button variant="danger" onClick={clear}>Clear</Button></>
            : <Button variant="danger" data-action="clear" disabled={!entries?.length} onClick={() => setClearing(true)}>Clear…</Button>}
        </Tile>
      </TileGroup>
    </Section>
    {entries && (keep === 'off' && !entries.length
      ? <EmptyState icon="history" title="History is off" action={<Button onClick={() => update({ history: { keep: 'week' } })}>Keep for a week</Button>}>
        What you say isn’t kept, so there’s nothing to search. Your stats still count every word.
      </EmptyState>
      : !entries.length
        ? stats?.dictations
          ? <EmptyState icon="history" title="Nothing kept right now">What you say next shows up here{FOR[keep]}. Your stats still count every word.</EmptyState>
          : <EmptyState icon="history" title="Nothing here yet">Hold {KEY[settings.shortcuts.dictate]} and speak in any app. What you say shows up here.</EmptyState>
        : <section className="history-list" aria-label="What you said">
          <label className="search history-search">
            <Icon name="search" size={15} />
            <input type="search" placeholder="Search what you said" aria-label="Search history" value={query} spellCheck={false}
              onChange={event => { setQuery(event.target.value); setShown(PAGE); }} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
            {words.length > 0 && <span className="history-count" aria-live="polite">{count(matches.length, 'match', 'matches')}</span>}
          </label>
          <div ref={list}>
            {!matches.length && <EmptyState icon="search" title="No matches">Nothing you said matches “{query.trim()}”.</EmptyState>}
            {groups.map(group => <div key={group.day}>
              <h3 className="history-day">{dayTitle(group.day, today)}</h3>
              <TileGroup label={dayTitle(group.day, today)}>
                {group.entries.map(entry => <Item key={entry.atMs} entry={entry} words={words} onCopy={copy} onType={type} onDelete={remove} />)}
              </TileGroup>
            </div>)}
          </div>
          {matches.length > shown && <div className="history-more"><Button variant="quiet" onClick={() => setShown(shown + PAGE)}>Show more</Button></div>}
        </section>)}
    {toast && <Toast message={toast.message} error={toast.error} onDone={hideToast} />}
  </>;
}

function Figures({ stats }: { stats: HistoryStats }) {
  const saved = duration(stats.savedSeconds);
  const figures: { label: string; value: string; unit?: string; hint?: string }[] = [
    { label: 'Words today', value: stats.wordsToday.toLocaleString() },
    { label: 'Words in total', value: stats.wordsTotal.toLocaleString() },
    { label: 'Day streak', value: stats.streak.toLocaleString(), unit: stats.streak === 1 ? 'day' : 'days' },
    { label: 'Average speed', ...(stats.wpm > 0 ? { value: Math.round(stats.wpm).toLocaleString(), unit: 'wpm' } : { value: 'Not yet' }), hint: 'Words a minute as you speak' },
    { label: 'Time saved', value: saved.value, unit: saved.unit, hint: 'Against typing at 40 wpm' },
    { label: 'Dictations', value: stats.dictations.toLocaleString() },
  ];
  return <dl className="stats-figures">
    {figures.map(figure => <div key={figure.label} className="stats-figure">
      <dt>{figure.label}</dt>
      <dd><span className="value">{figure.value}</span>{figure.unit && <span className="unit">{figure.unit}</span>}{figure.hint && <span className="hint">{figure.hint}</span>}</dd>
    </div>)}
  </dl>;
}

// The chart's drawing grid: one column per day, the bars rising from the baseline.
const COLUMN = 20, BAR = 12, HEIGHT = 96, FLOOR = 3;

function Chart({ stats }: { stats: HistoryStats }) {
  const [picked, setPicked] = useState<number | null>(null);
  const readout = useId();
  const { days, today } = stats;
  const most = Math.max(...days, 1);
  const dayOf = (i: number) => today - (days.length - 1 - i);
  const total = days.reduce((sum, words) => sum + words, 0);
  const keys = (event: KeyboardEvent) => {
    const at = picked ?? days.length - 1;
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: days.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setPicked(Math.min(days.length - 1, Math.max(0, next)));
  };
  return <div className="stats-chart" tabIndex={0} role="group" aria-label="Words each day, last 30 days. Use the arrow keys to read each day." aria-describedby={readout}
    onKeyDown={keys} onFocus={() => setPicked(picked ?? days.length - 1)} onBlur={() => setPicked(null)} onMouseLeave={() => setPicked(null)}>
    <p id={readout} className="stats-readout" aria-live="polite">
      {picked == null
        ? <><strong>{count(total, 'word')}</strong> in the last 30 days</>
        : <><strong>{count(days[picked], 'word')}</strong> {dayOf(picked) === today ? 'today' : `on ${dateOf(dayOf(picked), { weekday: 'long', month: 'long', day: 'numeric' })}`}</>}
    </p>
    <svg viewBox={`0 0 ${days.length * COLUMN} ${HEIGHT}`} aria-hidden="true">
      {days.map((words, i) => {
        const height = words ? Math.max(FLOOR + 1, (words / most) * HEIGHT) : FLOOR;
        return <g key={i} data-picked={picked === i || undefined} data-empty={!words || undefined} onMouseEnter={() => setPicked(i)}>
          <rect className="hit" x={i * COLUMN} y={0} width={COLUMN} height={HEIGHT} />
          <rect className="bar" x={i * COLUMN + (COLUMN - BAR) / 2} y={HEIGHT - height} width={BAR} height={height} rx={Math.min(3, height / 2)} />
        </g>;
      })}
    </svg>
    <div className="stats-axis" aria-hidden="true">
      <span>{dateOf(dayOf(0), { month: 'short', day: 'numeric' })}</span>
      <span>{dateOf(dayOf(Math.floor(days.length / 2)), { month: 'short', day: 'numeric' })}</span>
      <span>Today</span>
    </div>
  </div>;
}

function Share({ part, of, label }: { part: number; of: number; label: string }) {
  const percent = of ? Math.round((part / of) * 100) : 0;
  return <span className="stats-share">
    <span className="ui-progress" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span>
    <span className="percent">{part && percent === 0 ? '<1' : percent}%</span>
  </span>;
}

/// `text` with every searched word marked.
function marked(text: string, words: string[]): ReactNode {
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return text.split(pattern).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part);
}

// Long notes fold to a few lines until opened.
const LONG = 320;

function Item({ entry, words, onCopy, onType, onDelete }: {
  entry: HistoryEntry; words: string[]; onCopy: (entry: HistoryEntry) => void; onType: (entry: HistoryEntry) => void; onDelete: (entry: HistoryEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const long = entry.text.length > LONG;
  const time = new Date(entry.atMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const app = entry.mode === 'note' ? '' : entry.appName;
  const where = [app, MODE[entry.mode]].filter(Boolean).join(' · ');
  return <article className="history-entry" data-at={entry.atMs} data-folded={long && !open || undefined} aria-label={`${time}${where ? `, ${where}` : ''}`}>
    <p className="text">{marked(entry.text, words)}</p>
    <div className="meta">
      <span><time dateTime={new Date(entry.atMs).toISOString()}>{time}</time>{app && <> · {marked(app, words)}</>}{MODE[entry.mode] && ` · ${MODE[entry.mode]}`} · {count(entry.words, 'word')}</span>
      {long && <button type="button" className="link fold" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show all'}</button>}
      <span className="actions">
        <Button variant="quiet" small icon="copy" aria-label="Copy" title="Copy" onClick={() => onCopy(entry)} />
        <Button variant="quiet" small icon="keyboard" aria-label="Type again" title="Type again in the app you were using" onClick={() => onType(entry)} />
        <Button variant="quiet" small icon="trash" aria-label="Delete" title="Delete" data-action="delete" onClick={() => onDelete(entry)} />
      </span>
    </div>
  </article>;
}
