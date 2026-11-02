import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '../../bridge';
import { sendsByDefault, type AppStyle, type PageProps, type Style } from '../../store';
import { Button, Icon, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';
import './speech.css';

const STYLES: { value: Style; label: string; detail: string; said?: string; typed?: string }[] = [
  { value: 'default', label: 'Default', detail: 'As Whisper writes it, with your replacements and filler setting.' },
  { value: 'casual', label: 'Casual', detail: 'No full stop at the end of a single sentence.', said: 'Sounds good.', typed: 'Sounds good' },
  { value: 'formal', label: 'Formal', detail: 'A capital to start and a full stop to end.', said: 'see you then', typed: 'See you then.' },
  { value: 'code', label: 'Code', detail: 'Symbols and casing by name, and no capital to start.', said: 'camel case user name', typed: 'userName' },
  { value: 'raw', label: 'Raw', detail: 'Exactly what Whisper heard: no replacements, fillers left in.' },
];
const same = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();

/// An app as list_apps finds it.
type App = { bundleId: string; name: string; icon: string | null; running: boolean; recent: boolean };
// Kept for the window's life, so coming back shows icons at once while a fresh list is made.
let cache: App[] | null = null;

function AppName({ name, icon }: { name: string; icon?: string | null }) {
  return <span className="app-name">
    {icon ? <img src={icon} alt="" /> : <span className="app-glyph" aria-hidden>{[...name][0]?.toUpperCase()}</span>}
    <span className="label" title={name}>{name}</span>
  </span>;
}

/// Running and recent apps without a style yet, to search and pick from, or any app by its bundle ID.
function Picker({ apps, failed, styled, onPick, onClose }: { apps: App[] | null; failed: boolean; styled: AppStyle[]; onPick: (app: Pick<App, 'bundleId' | 'name'>) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const words = query.trim().toLowerCase();
  const matches = (app: Pick<App, 'bundleId' | 'name'>) => !words || app.name.toLowerCase().includes(words) || app.bundleId.toLowerCase().includes(words);
  const taken = (bundleId: string) => styled.some(app => same(app.bundleId, bundleId));
  const candidates = (apps ?? []).filter(app => !taken(app.bundleId) && (app.running || app.recent)).filter(matches);
  const typed = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(query.trim()) && !taken(query.trim()) && !candidates.some(app => same(app.bundleId, query.trim())) ? query.trim() : null;
  const already = words ? styled.find(matches) : undefined;
  const buttons = () => [...(list.current?.querySelectorAll('button') ?? [])];
  // Up and down move by rows of the grid, left and right along it; up from the first row goes back to the search.
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const columns = list.current ? getComputedStyle(list.current).gridTemplateColumns.split(' ').length : 1;
    const step = ({ ArrowDown: columns, ArrowUp: -columns, ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    if (!step || !all.length || (at < 0 && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const next = at < 0 ? 0 : at + step;
    if (next < 0) field.current?.focus(); else all[Math.min(all.length - 1, next)].focus();
  };
  return <div className="app-picker" onKeyDown={keys}>
    <div className="head">
      <input ref={field} className="ui-field wide" autoFocus aria-label="Search apps" placeholder="Search apps, or type a bundle ID" value={query} spellCheck={false}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (candidates[0]) onPick(candidates[0]); else if (typed) onPick({ bundleId: typed, name: typed });
        }} />
      <Button small variant="quiet" onClick={onClose}>Done</Button>
    </div>
    {apps === null && !failed && <p className="quiet" role="status">Finding your apps…</p>}
    {failed && <p className="quiet" role="status">Couldn’t list your apps. Type an app’s bundle ID, like com.apple.Notes.</p>}
    {!!candidates.length && <ul ref={list} aria-label="Apps">
      {candidates.map(app => <li key={app.bundleId}>
        <button type="button" title={app.bundleId} onClick={() => onPick(app)}>
          <AppName name={app.name} icon={app.icon} /><span className="tag">{app.running ? 'Open' : 'Recent'}</span>
        </button>
      </li>)}
    </ul>}
    {typed && <span><Button small icon="plus" onClick={() => onPick({ bundleId: typed, name: typed })}>Add {typed}</Button></span>}
    {apps !== null && !candidates.length && !typed && <p className="quiet">{already ? `${already.name} already has a style.`
      : words ? 'No open or recent app matches. Type its bundle ID, like com.example.app.' : 'Every app you have used lately has a style already.'}</p>}
  </div>;
}

export function AppStyles({ settings, update }: PageProps) {
  const apps = settings.apps;
  const [found, setFound] = useState<App[] | null>(cache);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  // Once per visit: apps added meanwhile come from this list, with their icons.
  const known = useRef(apps.styles.map(app => app.bundleId));
  useEffect(() => {
    let live = true;
    void invoke<App[]>('list_apps', { known: known.current })
      .then(list => { cache = list; if (live) setFound(list); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const icon = (bundleId: string) => found?.find(app => same(app.bundleId, bundleId))?.icon;
  const set = (bundleId: string, change: Partial<AppStyle>) => update({ apps: { styles: apps.styles.map(app => app.bundleId === bundleId ? { ...app, ...change } : app) } });
  const close = () => { setPicking(false); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-add-app]')?.focus()); };
  const pick = (app: Pick<App, 'bundleId' | 'name'>) => {
    setPicking(false);
    void update({ apps: { styles: [{ bundleId: app.bundleId, name: app.name, style: apps.defaultStyle, polish: false }, ...apps.styles] } })
      .then(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-label="Style in ${CSS.escape(app.name)}"]`)?.focus()));
  };
  const claude = settings.claude.enabled;

  return <>
    <PageHeader icon="apps" title="App styles">How your words are written in each app.</PageHeader>
    <Section title="Everywhere else">
      <TileGroup>
        <Tile title="Default style" detail="For every app without a style of its own.">
          <Select label="Default style" value={apps.defaultStyle} options={STYLES} onChange={defaultStyle => update({ apps: { defaultStyle } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Apps" note={<>Send presses Return once your words are typed, as in a chat: on by default in Slack, Messages, WhatsApp, Teams, Telegram, Discord and Signal. Saying “send” at the end sends one message anywhere.
      {claude ? ' Polish asks Claude to tidy your words in that app, within a few seconds; your own words stand if it can’t.'
        : <> Claude can also polish your words in the apps you choose. <button type="button" className="link" onClick={() => { location.hash = 'claude'; }}>Connect Claude</button></>}</>}>
      <TileGroup label="Apps">
        <Tile title={picking ? 'Add an app' : `${apps.styles.length} ${apps.styles.length === 1 ? 'app' : 'apps'}`} stack={picking}>
          {picking
            ? <Picker apps={found} failed={failed} styled={apps.styles} onPick={pick} onClose={close} />
            : <Button data-add-app icon="plus" small onClick={() => setPicking(true)}>Add an app</Button>}
        </Tile>
        {apps.styles.map(app => <Tile key={app.bundleId} title={<AppName name={app.name} icon={icon(app.bundleId)} />}>
          <Select label={`Style in ${app.name}`} value={app.style} options={STYLES} onChange={style => set(app.bundleId, { style })} />
          <span className="labelled"><span>Send</span><Toggle label={`Send with Return in ${app.name}`} checked={app.send ?? sendsByDefault(app.bundleId)} onChange={send => set(app.bundleId, { send })} /></span>
          {claude && <span className="labelled"><span>Polish</span><Toggle label={`Polish in ${app.name}`} checked={app.polish} onChange={polish => set(app.bundleId, { polish })} /></span>}
          <Button variant="quiet" small icon="trash" aria-label={`Remove ${app.name}`} onClick={() => update({ apps: { styles: apps.styles.filter(other => other.bundleId !== app.bundleId) } })} />
        </Tile>)}
      </TileGroup>
    </Section>
    <Section title="The styles" note="Every style is applied on this Mac as you speak, live words included.">
      <TileGroup label="The styles">
        {STYLES.map(style => <Tile key={style.value} title={style.label} detail={style.detail}>
          {style.said && <span className="style-example" aria-label={`${style.said} becomes ${style.typed}`}>{style.said}<Icon name="chevronRight" size={12} /><b>{style.typed}</b></span>}
        </Tile>)}
      </TileGroup>
    </Section>
  </>;
}
