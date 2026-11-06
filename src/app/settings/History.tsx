import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { invoke, listen } from '../../bridge';
import { copyText } from '../../lib/clipboard';
import { dateOf, dayTitle, localDay } from '../../lib/dates';
import { message } from '../../lib/errors';
import { count } from '../../lib/format';
import { barHeight, byDay, figures, HEIGHT, removedBy, searchHistory, searchWords, share, sharePercent } from '../../lib/history';
import { KEY_NAMES } from '../../lib/keyNames';
import type { PageProps } from '../../store';
import type { HistoryEntry, HistoryStats, HoldMode, Keep } from '../../api/types';
import { Button, EmptyState, Icon, PageHeader, Section, Select, Tile, TileGroup, Toast } from '../../ui';
import './history.css';

const KEEP: { value: Keep; label: string }[] = [
  { value: 'off', label: 'Don’t keep' }, { value: 'day', label: 'For a day' }, { value: 'week', label: 'For a week' }, { value: 'month', label: 'For a month' }, { value: 'forever', label: 'Forever' },
];
const MODE: Partial<Record<HoldMode, string>> = { note: 'Note', command: 'Command', handsfree: 'Hands-free' };
const PAGE = 100;
const FOR: Record<Keep, string> = { off: '', day: ' for a day', week: ' for a week', month: ' for a month', forever: '' };
/// Focus for after a confirm closes, which would otherwise drop it to the page.
const refocus = (selector: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
const KEEP_SELECT = '.ui-select[aria-label="Keep what you said"]';

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

  const fail = useCallback((error: unknown, fallback: string) => setToast({ message: message(error, fallback), error: true }), []);
  const refresh = useCallback(() => {
    void invoke('history_stats').then(setStats).catch(error => fail(error, 'Couldn’t load your stats'));
    void invoke('history_list').then(setEntries).catch(error => fail(error, 'Couldn’t load your history'));
  }, [fail]);
  // A change to Keep prunes on the next read, so read again.
  useEffect(refresh, [refresh, keep]);
  useEffect(() => listen('dictate-history', refresh), [refresh]);
  useEffect(() => { addEventListener('focus', refresh); return () => removeEventListener('focus', refresh); }, [refresh]);
  const hideToast = useCallback(() => setToast(null), []);

  const words = searchWords(query);
  const matches = searchHistory(entries ?? [], query);
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
    }).catch(error => fail(error, 'Couldn’t clear your history'));
  };
  // A shorter Keep removes words at once and for good, so it asks first, as Clear does.
  const choose = (next: Keep) => {
    const removes = removedBy(next, entries ?? [], Date.now());
    if (removes) setNarrowing({ keep: next, removes }); else void update({ history: { keep: next } });
  };
  const narrow = (confirmed: boolean) => {
    if (confirmed && narrowing) void update({ history: { keep: narrowing.keep } });
    setNarrowing(null);
    refocus(KEEP_SELECT);
  };
  const copy = (entry: HistoryEntry) => void copyText(entry.text).then(() => setToast({ message: 'Copied' })).catch(() => fail(null, 'Couldn’t copy that'));
  const type = (entry: HistoryEntry) => void invoke('history_type', { at: entry.atMs }).catch(error => fail(error, 'Couldn’t type that again'));

  const visible = matches.slice(0, shown);
  const groups = byDay(visible);

  return <>
    <PageHeader icon="history" title="History & stats">Everything you’ve dictated, and how much typing it’s saved you.</PageHeader>
    {stats && <>
      <Section title="Stats">
        <Figures stats={stats} />
      </Section>
      <Section title="Last 30 days">
        <Chart stats={stats} />
      </Section>
      <Section title="Top apps" note={stats.apps.length ? 'Notes aren’t counted here, since they’re saved to a file.' : undefined}>
        <TileGroup label="Top apps">
          {stats.apps.length
            ? stats.apps.map(app => <Tile key={app.bundleId || app.name} title={app.name} detail={count(app.words, 'word')}>
              <Share part={app.words} of={stats.wordsTotal} label={`${app.name}’s share of your words`} />
            </Tile>)
            : <Tile title="No apps yet" detail="The apps you dictate into most will show up here." dim />}
        </TileGroup>
      </Section>
    </>}
    <Section title="History" note="Your stats count every word, even when what you said isn’t kept.">
      <TileGroup>
        {narrowing
          ? <Tile title={narrowing.keep === 'off' ? 'Stop keeping what you say?' : `Keep what you said${FOR[narrowing.keep]}?`}
            detail={`This deletes ${count(narrowing.removes, 'dictation')} for good, but your stats stay.`}>
            <Button variant="quiet" onClick={() => narrow(false)} autoFocus>Cancel</Button>
            <Button variant="danger" onClick={() => narrow(true)}>Remove</Button>
          </Tile>
          : <Tile title="Keep what you said" detail="Anything older is deleted for good.">
            <Select label="Keep what you said" value={keep} options={KEEP} onChange={choose} />
          </Tile>}
        <Tile title={clearing ? 'Clear all of your history?' : 'Clear history'} detail="Your saved notes and stats won’t be touched.">
          {clearing
            ? <><Button variant="quiet" onClick={() => { setClearing(false); refocus('[data-action="clear"]'); }} autoFocus>Cancel</Button>
              <Button variant="danger" onClick={clear}>Clear</Button></>
            : <Button variant="danger" data-action="clear" disabled={!entries?.length} onClick={() => setClearing(true)}>Clear…</Button>}
        </Tile>
      </TileGroup>
    </Section>
    {entries && (keep === 'off' && !entries.length
      ? <EmptyState icon="history" title="History is off" action={<Button onClick={() => update({ history: { keep: 'week' } })}>Keep for a week</Button>}>
        What you say isn’t being kept, so there’s nothing to search.
      </EmptyState>
      : !entries.length
        ? stats?.dictations
          ? <EmptyState icon="history" title="Nothing here yet">What you say next will show up here{FOR[keep]}.</EmptyState>
          : <EmptyState icon="history" title="Nothing here yet">Hold {KEY_NAMES[settings.shortcuts.dictate]} and talk in any app, and it’ll show up here.</EmptyState>
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
  return <dl className="stats-figures">
    {figures(stats).map(figure => <div key={figure.label} className="stats-figure">
      <dt>{figure.label}</dt>
      <dd><span className="value">{figure.value}</span>{figure.unit && <span className="unit">{figure.unit}</span>}{figure.hint && <span className="hint">{figure.hint}</span>}</dd>
    </div>)}
  </dl>;
}

// The chart's drawing grid: one column per day, the bars rising from the baseline.
const COLUMN = 20, BAR = 12;

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
  return <div className="stats-chart" tabIndex={0} role="group" aria-label="Words each day for the last 30 days. Use the arrow keys to go through the days." aria-describedby={readout}
    onKeyDown={keys} onFocus={() => setPicked(picked ?? days.length - 1)} onBlur={() => setPicked(null)} onMouseLeave={() => setPicked(null)}>
    <p id={readout} className="stats-readout" aria-live="polite">
      {picked == null
        ? <><strong>{count(total, 'word')}</strong> in the last 30 days</>
        : <><strong>{count(days[picked], 'word')}</strong> {dayOf(picked) === today ? 'today' : `on ${dateOf(dayOf(picked), { weekday: 'long', month: 'long', day: 'numeric' })}`}</>}
    </p>
    <svg viewBox={`0 0 ${days.length * COLUMN} ${HEIGHT}`} aria-hidden="true">
      {days.map((words, i) => {
        const height = barHeight(words, most);
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
  const percent = sharePercent(part, of);
  return <span className="stats-share">
    <span className="ui-progress" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span>
    <span className="percent">{share(part, of)}%</span>
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
