import { useCallback, useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Onboarding } from '../onboarding/Onboarding';
import { updateSettings, useSettings, type PageProps, type Patch } from '../store';
import { applyTheme, Icon, Toast, type IconName } from '../ui';
import { About } from './pages/About';
import { Agents } from './pages/Agents';
import { AppStyles } from './pages/AppStyles';
import { Appearance } from './pages/Appearance';
import { Claude } from './pages/Claude';
import { Dictation } from './pages/Dictation';
import { General } from './pages/General';
import { History } from './pages/History';
import { Library } from './pages/Library';
import { Meetings } from './pages/Meetings';
import { Notes } from './pages/Notes';
import { Shortcuts } from './pages/Shortcuts';
import { Vocabulary } from './pages/Vocabulary';

type Page = { route: string; title: string; icon: IconName; Page: ComponentType<PageProps>; keywords: string };
// The rail, in named groups. Search also matches the keywords: what each page lets you change.
const GROUPS: { name: string; pages: Page[] }[] = [
  { name: 'Basics', pages: [
    { route: 'general', title: 'General', icon: 'general', Page: General, keywords: 'open at login startup microphone input pause reset set up menu bar icon tray accessibility permissions privacy' },
    { route: 'shortcuts', title: 'Shortcuts', icon: 'keyboard', Page: Shortcuts, keywords: 'fn key dictate hands-free double tap command modifier chord note meeting paste last write sticky ask claude' },
  ] },
  { name: 'Speech', pages: [
    { route: 'dictation', title: 'Dictation', icon: 'waveform', Page: Dictation, keywords: 'language translate english live typing fillers um sounds volume start stop cue chime whisper model turbo small' },
    { route: 'vocabulary', title: 'Vocabulary', icon: 'book', Page: Vocabulary, keywords: 'words names terms spelling replacements learn suggestions' },
    { route: 'apps', title: 'App styles', icon: 'apps', Page: AppStyles, keywords: 'style casual formal code raw polish apps' },
  ] },
  { name: 'Notes & meetings', pages: [
    { route: 'library', title: 'Library', icon: 'library', Page: Library, keywords: 'library all notes meetings files saved transcripts open finder search browse' },
    { route: 'notes', title: 'Notes', icon: 'note', Page: Notes, keywords: 'folder file name template front matter yaml daily note tags obsidian title action items' },
    { route: 'meetings', title: 'Meetings', icon: 'meeting', Page: Meetings, keywords: 'record system audio summary decisions speakers labels folder' },
  ] },
  { name: 'Connections', pages: [
    { route: 'claude', title: 'Claude', icon: 'claude', Page: Claude, keywords: 'anthropic api key account subscription sign in model haiku sonnet opus commands polish claude code project' },
    { route: 'agents', title: 'Agents (MCP)', icon: 'agents', Page: Agents, keywords: 'mcp server claude code desktop share notes meetings history write' },
  ] },
  { name: 'App', pages: [
    { route: 'history', title: 'History & stats', icon: 'history', Page: History, keywords: 'keep words stats streak time saved' },
    { route: 'appearance', title: 'Appearance', icon: 'appearance', Page: Appearance, keywords: 'theme dark light edge size dots orb idle hidden hint margin distance position dock' },
    { route: 'about', title: 'About', icon: 'about', Page: About, keywords: 'version licence license privacy third-party notices' },
  ] },
];
const PAGES = GROUPS.flatMap(group => group.pages);

const routeOf = () => decodeURIComponent(location.hash.slice(1)) || 'general';

export function Settings() {
  const settings = useSettings();
  const [route, setRoute] = useState(routeOf);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => { const changed = () => setRoute(routeOf()); addEventListener('hashchange', changed); return () => removeEventListener('hashchange', changed); }, []);
  const theme = settings?.appearance.theme;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => { if (event.metaKey && event.key === 'f') { event.preventDefault(); search.current?.focus(); search.current?.select(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  const hideToast = useCallback(() => setToast(null), []);
  const update = useCallback((patch: Patch) => updateSettings(patch).catch(error => { setToast(typeof error === 'string' ? error : 'Couldn’t save that change'); return undefined; }), []);

  if (route === 'setup') return <Onboarding />;
  const page = PAGES.find(candidate => candidate.route === route) ?? PAGES[0];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (candidate: Page) => words.every(word => `${candidate.title} ${candidate.keywords}`.toLowerCase().includes(word));
  const groups = GROUPS.map(group => ({ ...group, pages: group.pages.filter(matches) })).filter(group => group.pages.length);
  // One link takes Tab: the open page's, or the first match while a search hides it.
  const tabbable = groups.some(group => group.pages.some(candidate => candidate.route === page.route)) ? page.route : groups[0]?.pages[0].route;
  const go = (to: string) => { if (to !== route) location.hash = to; };

  // Up and down move through the pages, as in the Mac's own sidebars.
  const arrows = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...(nav.current?.querySelectorAll<HTMLAnchorElement>('a[data-route]') ?? [])];
    if (!links.length) return;
    event.preventDefault();
    // The focused link first: `route` lags until the hash change re-renders, so quick presses would stall.
    let at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) at = links.findIndex(link => link.dataset.route === route);
    const next = links[Math.min(links.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    go(next.dataset.route!);
  };

  // The workspace shell from TabTasker Business: a title strip with the traffic lights and, to their right
  // as in Business's Mac app, the app's name and the page that is open (the window holds your Library as
  // well as settings, so it is never called Settings); then a rail panel and the page as a raised island on
  // a tinted frame. The strip and the frame drag the window.
  return <div className="window" data-tauri-drag-region>
    <header className="titlebar" data-tauri-drag-region><span className="titlebar-app" data-tauri-drag-region>TabTasker Dictate</span><span className="titlebar-page" data-tauri-drag-region>{page.title}</span></header>
    <nav ref={nav} className="rail" aria-label="TabTasker Dictate" onKeyDown={arrows}>
      <label className="search">
        <Icon name="search" size={15} />
        <input ref={search} type="search" placeholder="Search" aria-label="Search settings" value={query} spellCheck={false}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && groups.length) { go(groups[0].pages[0].route); setQuery(''); }
            if (event.key === 'Escape') setQuery('');
          }} />
      </label>
      {groups.map(group => <ul key={group.name} className="group" aria-label={group.name}>
        <li className="group-name" aria-hidden="true">{group.name}</li>
        {group.pages.map(candidate => <li key={candidate.route}>
          <a href={`#${candidate.route}`} data-route={candidate.route} aria-current={candidate.route === page.route ? 'page' : undefined}
            tabIndex={candidate.route === tabbable ? 0 : -1}>
            <Icon name={candidate.icon} size={17} />{candidate.title}
          </a>
        </li>)}
      </ul>)}
      {!groups.length && <p className="no-match">No settings match “{query.trim()}”</p>}
    </nav>
    <main key={page.route} className="content" aria-label={page.title}>
      {settings && <div className="page"><page.Page settings={settings} update={update} /></div>}
    </main>
    {toast && <Toast message={toast} error onDone={hideToast} />}
  </div>;
}
