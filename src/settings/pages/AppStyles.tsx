import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '../../bridge';
import type { AppStyle, PageProps, Style } from '../../store';
import { Button, Icon, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';
import './speech.css';

const STYLES: { value: Style; label: string; detail: string; said?: string; typed?: string }[] = [
  { value: 'default', label: 'Default', detail: 'As Whisper writes it, with your replacements and no fillers.' },
  { value: 'casual', label: 'Casual', detail: 'No full stop at the end of a single sentence.', said: 'Sounds good.', typed: 'Sounds good' },
  { value: 'formal', label: 'Formal', detail: 'A capital to start and a full stop to end.', said: 'thanks for the update', typed: 'Thanks for the update.' },
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
    <span className="label">{name}</span>
  </span>;
}

/// Running and recent apps without a style yet, to search and pick from, or any app by its bundle ID.
function Picker({ apps, failed, taken, onPick, onClose }: { apps: App[] | null; failed: boolean; taken: (bundleId: string) => boolean; onPick: (app: Pick<App, 'bundleId' | 'name'>) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const words = query.trim().toLowerCase();
  const candidates = (apps ?? []).filter(app => !taken(app.bundleId) && (app.running || app.recent))
    .filter(app => !words || app.name.toLowerCase().includes(words) || app.bundleId.toLowerCase().includes(words));
  const typed = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(query.trim()) && !taken(query.trim()) && !candidates.some(app => same(app.bundleId, query.trim())) ? query.trim() : null;
  const buttons = () => [...(list.current?.querySelectorAll('button') ?? [])];
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const all = buttons();
    if (!all.length) return;
    event.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[Math.max(0, Math.min(all.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  };
  return <div className="app-picker" onKeyDown={keys}>
    <div className="head">
      <input className="ui-field wide" autoFocus aria-label="Search apps" placeholder="Search apps, or type a bundle ID" value={query} spellCheck={false}
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
    {apps !== null && !candidates.length && !typed && <p className="quiet">{words ? 'No open or recent app matches. Type its bundle ID, like com.example.app.' : 'Every app you have used lately has a style already.'}</p>}
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
  const taken = (bundleId: string) => apps.styles.some(app => same(app.bundleId, bundleId));
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
    <Section title="Apps" note={claude ? 'Polish asks Claude to tidy your words in that app, within a few seconds. Your own words stand if it can’t.'
      : <>Claude can also polish your words in the apps you choose. <button type="button" className="link" onClick={() => { location.hash = 'claude'; }}>Connect Claude</button></>}>
      <TileGroup label="Apps">
        <Tile title={picking ? 'Add an app' : `${apps.styles.length} ${apps.styles.length === 1 ? 'app' : 'apps'}`} stack={picking}>
          {picking
            ? <Picker apps={found} failed={failed} taken={taken} onPick={pick} onClose={close} />
            : <Button data-add-app icon="plus" small onClick={() => setPicking(true)}>Add an app</Button>}
        </Tile>
        {apps.styles.map(app => <Tile key={app.bundleId} title={<AppName name={app.name} icon={icon(app.bundleId)} />}>
          <Select label={`Style in ${app.name}`} value={app.style} options={STYLES} onChange={style => set(app.bundleId, { style })} />
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
