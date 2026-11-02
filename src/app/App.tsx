import { useCallback, useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Onboarding } from '../onboarding/Onboarding';
import { updateSettings, useSettings, type PageProps, type Patch } from '../store';
import { applyTheme, Icon, Toast, type IconName } from '../ui';
import { About } from './pages/About';
import { Appearance } from './pages/Appearance';
import { SettingsAI } from './pages/SettingsAI';
import { SettingsGeneral } from './pages/SettingsGeneral';
import { SettingsNotes } from './pages/SettingsNotes';
import { NotesView } from './views/NotesView';
import { HelpView } from './views/HelpView';
import { StickiesView } from './views/StickiesView';

// The app's one window, in TabTasker Business's workspace shell: a title strip with the traffic lights
// and the place you are, a rail with the places (your notes, meetings and stickies, a question for Claude)
// and the four settings pages, and the place itself as a raised island. The rail is Business's
// NavigationRail: 40-point rows with an icon column, separators between its parts (184 points wide here, for our labels). The
// hash is the place: `notes`, `notes/<path>` for one note, `meetings/<path>`, `stickies`, `settings`,
// `settings/<page>`, `setup` (the first-run steps) and `about`.
type Place = { route: string; title: string; icon: IconName };
const PLACES: Place[] = [
  { route: 'notes', title: 'Notes', icon: 'note' },
  { route: 'meetings', title: 'Meetings', icon: 'meeting' },
  { route: 'stickies', title: 'Stickies', icon: 'sticky' },
];
const SETTINGS: (Place & { Page: ComponentType<PageProps> })[] = [
  { route: 'settings', title: 'General', icon: 'general', Page: SettingsGeneral },
  { route: 'settings/notes', title: 'Notes & meetings', icon: 'book', Page: SettingsNotes },
  { route: 'settings/agents', title: 'Agents', icon: 'agents', Page: SettingsAI },
  { route: 'settings/appearance', title: 'Appearance', icon: 'appearance', Page: Appearance },
];

const routeOf = () => decodeURIComponent(location.hash.slice(1)) || 'notes';
/// `notes//Users/you/Documents/TabTasker Dictate/Hello.md` is the place `notes` with that path.
const split = (route: string): [string, string | null] => {
  const slash = route.indexOf('/');
  return slash < 0 ? [route, null] : [route.slice(0, slash), route.slice(slash + 1) || null];
};

export function App() {
  const settings = useSettings();
  const [route, setRoute] = useState(routeOf);
  const [toast, setToast] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => { const changed = () => setRoute(routeOf()); addEventListener('hashchange', changed); return () => removeEventListener('hashchange', changed); }, []);
  const theme = settings?.appearance.theme;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => { if (event.metaKey && event.key === ',') { event.preventDefault(); location.hash = 'settings'; } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  const hideToast = useCallback(() => setToast(null), []);
  const update = useCallback((patch: Patch) => updateSettings(patch).catch(error => { setToast(typeof error === 'string' ? error : 'Couldn’t save that change'); return undefined; }), []);

  const [place, arg] = split(route);
  if (place === 'setup') return <Onboarding />;
  const setting = place === 'settings' ? (SETTINGS.find(page => page.route === route) ?? SETTINGS[0]) : null;
  const here: Place = setting ?? PLACES.find(candidate => candidate.route === place) ?? (place === 'about' ? { route: 'about', title: 'About', icon: 'about' } : place === 'help' ? { route: 'help', title: 'Help', icon: 'help' } : PLACES[0]);
  const current = (candidate: string) => candidate === (setting ? setting.route : here.route);
  const go = (to: string) => { if (to !== route) location.hash = to; };
  const props: PageProps | null = settings && { settings, update };
  const wide = place === 'notes' || place === 'meetings';

  // Up and down move through the rail, as in the Mac's own sidebars.
  const arrows = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...(nav.current?.querySelectorAll<HTMLAnchorElement>('a[data-route]') ?? [])];
    if (!links.length) return;
    event.preventDefault();
    let at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) at = links.findIndex(link => current(link.dataset.route!));
    const next = links[Math.min(links.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    go(next.dataset.route!);
  };
  const link = (candidate: Place) => <li key={candidate.route}>
    <a href={`#${candidate.route}`} data-route={candidate.route} aria-current={current(candidate.route) ? 'page' : undefined} tabIndex={current(candidate.route) ? 0 : -1}>
      <span className="rail-icon"><Icon name={candidate.icon} size={18} /></span><span className="rail-label">{candidate.title}</span>
    </a>
  </li>;

  return <div className="window" data-tauri-drag-region>
    <header className="titlebar" data-tauri-drag-region><span className="titlebar-app" data-tauri-drag-region>TabTasker Dictate</span><span className="titlebar-page" data-tauri-drag-region>{here.title}</span>
      <button type="button" className="titlebar-help" aria-current={place === 'help' ? 'page' : undefined} onClick={() => go('help')}><Icon name="help" size={15} />Help</button>
    </header>
    <nav ref={nav} className="rail" aria-label="TabTasker Dictate" onKeyDown={arrows}>
      <ul className="group" aria-label="Your things">{PLACES.map(link)}</ul>
      <hr className="rail-rule" />
      <ul className="group" aria-label="Settings">{SETTINGS.map(link)}</ul>
      <ul className="group rail-foot" aria-label="About"><hr className="rail-rule" />{link({ route: 'about', title: 'About', icon: 'about' })}</ul>
    </nav>
    <main key={wide ? place : route} className="content" data-wide={wide || undefined} aria-label={here.title}>
      {!settings && null}
      {props && place === 'notes' && <NotesView kind="note" path={arg} {...props} onError={setToast} />}
      {props && place === 'meetings' && <NotesView kind="meeting" path={arg} {...props} onError={setToast} />}
      {props && place === 'stickies' && <div className="page wide"><StickiesView onError={setToast} /></div>}
      {props && place === 'about' && <div className="page"><About {...props} /></div>}
      {props && place === 'help' && <div className="page help"><HelpView settings={props.settings} /></div>}
      {props && setting && <div className="page"><setting.Page {...props} /></div>}
    </main>
    {toast && <Toast message={toast} error onDone={hideToast} />}
  </div>;
}
