import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { closeWindow } from '../bridge';
import { Onboarding } from '../onboarding/Onboarding';
import { Logo } from '../overlay/icons';
import { updateSettings, useSettings, type PageProps, type Patch } from '../store';
import { applyTheme, Icon, Toast, type IconName } from '../ui';
import { ColumnHead } from './Column';
import { About } from './pages/About';
import { Appearance } from './pages/Appearance';
import { SettingsAI } from './pages/SettingsAI';
import { SettingsGeneral } from './pages/SettingsGeneral';
import { SettingsNotes } from './pages/SettingsNotes';
import { HelpView } from './views/HelpView';
import { NotePage, NotesColumn } from './views/NotesView';
import { StickiesView } from './views/StickiesView';

// The app's one window, in TabTasker Business's Mac shell: a title bar across the top with the traffic
// lights, the column's toggle, back and forward, the open places as tabs and a plus for one more; a spine
// of icons down the left (notes, meetings, stickies; settings at its foot; the otter at its head); the
// column of the place you are in, with its name, its search and its things in groups; and the page itself
// on a raised pane beside it. A tab is a remembered place: its route and the routes it came through, so
// back and forward are the tab's own. Routes: `notes`, `notes/<path>`, `meetings`, `meetings/<path>`,
// `stickies`, `settings`, `settings/<page>`, `setup`, `about`, `help`. The window's hash is the open
// tab's route, so a note opened from the dots lands in it.
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
const EXTRA: Record<string, Place> = {
  about: { route: 'about', title: 'About', icon: 'about' },
  help: { route: 'help', title: 'Help', icon: 'help' },
  setup: { route: 'setup', title: 'Set up', icon: 'general' },
  settings: { route: 'settings', title: 'Settings', icon: 'general' },
};

type Tab = { id: number; route: string; back: string[]; forward: string[] };
type Tabs = { tabs: Tab[]; active: number };
const TABS = 'tabtasker-dictate:tabs';
const routeOf = () => decodeURIComponent(location.hash.slice(1)) || 'notes';
/// `notes//Users/you/Documents/TabTasker Dictate/Hello.md` is the place `notes` with that path.
const split = (route: string): [string, string | null] => {
  const slash = route.indexOf('/');
  return slash < 0 ? [route, null] : [route.slice(0, slash), route.slice(slash + 1) || null];
};
const placeOf = (route: string): Place => {
  const [place] = split(route);
  if (place === 'settings') return SETTINGS.find(page => page.route === route) ?? SETTINGS[0];
  return PLACES.find(candidate => candidate.route === place) ?? EXTRA[place] ?? PLACES[0];
};
/// A tab's name: the place, or the note's own title without its date stamp.
const titleOf = (route: string) => {
  const place = placeOf(route);
  const [kind, arg] = split(route);
  if (!arg || (kind !== 'notes' && kind !== 'meetings')) return place.title;
  const file = decodeURIComponent(arg).split('/').pop() ?? '';
  return file.replace(/\.md$/, '').replace(/^\d{4}-\d\d-\d\d( \d\d\.\d\d)? ?/, '') || place.title;
};
const loadTabs = (): Tabs => {
  const fallback: Tabs = { tabs: [{ id: 1, route: routeOf(), back: [], forward: [] }], active: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(TABS) ?? 'null') as Tabs | null;
    if (!saved?.tabs?.length) return fallback;
    const active = Math.min(Math.max(0, saved.active | 0), saved.tabs.length - 1);
    const tabs = saved.tabs.map(tab => ({ id: tab.id, route: tab.route || 'notes', back: tab.back ?? [], forward: tab.forward ?? [] }));
    // The hash is what was asked for (a note from the dots, a settings page from the menu): it goes to the open tab.
    if (location.hash.length > 1) tabs[active] = { ...tabs[active], route: routeOf(), forward: [] };
    return { tabs, active };
  } catch { return fallback; }
};
/// The open tab routed to `to`, remembering where it was.
const visit = (state: Tabs, to: string): Tabs => {
  const open = state.tabs[state.active];
  if (open.route === to) return state;
  return { ...state, tabs: state.tabs.map((tab, i) => i === state.active ? { ...tab, route: to, back: [...tab.back, tab.route].slice(-50), forward: [] } : tab) };
};

export function App() {
  const settings = useSettings();
  const [state, setState] = useState(loadTabs);
  const [toast, setToast] = useState<string | null>(null);
  const [column, setColumn] = useState(() => { try { return localStorage.getItem(`${TABS}:column`) !== 'closed'; } catch { return true; } });
  const { tabs, active } = state;
  const tab = tabs[active];
  const route = tab.route;
  const [place, arg] = split(route);
  const here = placeOf(route);
  // The hash follows the open tab; a hash set from outside (a note opened from the dots) moves the tab.
  useEffect(() => {
    try { localStorage.setItem(TABS, JSON.stringify(state)); } catch { /* a convenience */ }
    if (routeOf() !== route) location.hash = route;
  }, [state, route]);
  useEffect(() => {
    const changed = () => setState(s => visit(s, routeOf()));
    addEventListener('hashchange', changed); return () => removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => { try { localStorage.setItem(`${TABS}:column`, column ? 'open' : 'closed'); } catch { /* a convenience */ } }, [column]);
  const theme = settings?.appearance.theme;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  const hideToast = useCallback(() => setToast(null), []);
  const update = useCallback((patch: Patch) => updateSettings(patch).catch(error => { setToast(typeof error === 'string' ? error : 'Couldn’t save that change'); return undefined; }), []);

  const go = useCallback((to: string) => setState(s => visit(s, to)), []);
  const newTab = useCallback((to = 'notes') => setState(s => ({ tabs: [...s.tabs, { id: Date.now(), route: to, back: [], forward: [] }], active: s.tabs.length })), []);
  const closeTab = useCallback((at: number) => setState(s => {
    if (s.tabs.length === 1) { closeWindow(); return s; }
    const tabs = s.tabs.filter((_, i) => i !== at);
    return { tabs, active: at < s.active ? s.active - 1 : Math.min(s.active, tabs.length - 1) };
  }), []);
  const back = useCallback(() => setState(s => {
    const t = s.tabs[s.active]; const to = t.back.at(-1); if (!to) return s;
    return { ...s, tabs: s.tabs.map((x, i) => i === s.active ? { ...x, route: to, back: x.back.slice(0, -1), forward: [x.route, ...x.forward] } : x) };
  }), []);
  const forward = useCallback(() => setState(s => {
    const t = s.tabs[s.active]; const to = t.forward[0]; if (!to) return s;
    return { ...s, tabs: s.tabs.map((x, i) => i === s.active ? { ...x, route: to, back: [...x.back, x.route], forward: x.forward.slice(1) } : x) };
  }), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const k = event.key;
      if (k === ',') go('settings');
      else if (k === 't') newTab();
      else if (k === 'w') setState(s => { if (s.tabs.length === 1) { closeWindow(); return s; } const tabs = s.tabs.filter((_, i) => i !== s.active); return { tabs, active: Math.min(s.active, tabs.length - 1) }; });
      else if (k === '[' && !event.shiftKey) back();
      else if (k === ']' && !event.shiftKey) forward();
      else if (k === '{' || (event.shiftKey && k === '[')) setState(s => ({ ...s, active: (s.active - 1 + s.tabs.length) % s.tabs.length }));
      else if (k === '}' || (event.shiftKey && k === ']')) setState(s => ({ ...s, active: (s.active + 1) % s.tabs.length }));
      else if (/^[1-9]$/.test(k)) setState(s => ({ ...s, active: Math.min(Number(k) - 1, s.tabs.length - 1) }));
      else return;
      event.preventDefault();
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [go, newTab, back, forward]);

  if (place === 'setup') return <Onboarding />;
  const props: PageProps | null = settings && { settings, update };
  const settingsOpen = place === 'settings';
  // A column only where there is a list to put in it: the notes, the meetings, the settings pages. The stickies page is its own list.
  const hasColumn = place === 'notes' || place === 'meetings' || settingsOpen;
  const withColumn = column && hasColumn;
  const railItem = (candidate: Place, on: boolean, onClick: () => void) => <li key={candidate.route}>
    <button type="button" className="rail-item" aria-label={candidate.title} title={candidate.title} aria-current={on ? 'page' : undefined} onClick={onClick}><Icon name={candidate.icon} size={18} /></button>
  </li>;

  return <div className="window">
    <header className="titlebar" data-tauri-drag-region>
      <span className="bar-tools">
        <button type="button" className="bar-tool" aria-label={column ? 'Hide the column' : 'Show the column'} title="Toggle sidebar" aria-pressed={column} disabled={!hasColumn} onClick={() => setColumn(open => !open)}><Icon name="sidebar" size={16} /></button>
        <button type="button" className="bar-tool" aria-label="Back" title="Back (⌘[)" disabled={!tab.back.length} onClick={back}><Icon name="chevronLeft" size={16} /></button>
        <button type="button" className="bar-tool" aria-label="Forward" title="Forward (⌘])" disabled={!tab.forward.length} onClick={forward}><Icon name="chevronRight" size={16} /></button>
      </span>
      <div className="tabs" role="tablist" aria-label="Tabs" data-tauri-drag-region>
        {tabs.map((t, i) => { const p = placeOf(t.route); const title = titleOf(t.route); const on = i === active; return <div key={t.id} className="tab" aria-selected={on}>
          <button type="button" role="tab" aria-selected={on} title={title} className="tab-select" onClick={() => setState(s => ({ ...s, active: i }))} onAuxClick={event => { if (event.button === 1) closeTab(i); }}>
            <Icon name={p.icon} size={16} /><span className="tab-title">{title}</span>
          </button>
          {tabs.length > 1 && <button type="button" className="tab-close" aria-label={`Close ${title}`} title="Close tab (⌘W)" onClick={() => closeTab(i)}><Icon name="close" size={12} /></button>}
        </div>; })}
        <button type="button" className="bar-tool" aria-label="New tab" title="New tab (⌘T)" onClick={() => newTab()}><Icon name="plus" size={16} /></button>
      </div>
      <span className="bar-end">
        <button type="button" className="titlebar-help" aria-label="Help" aria-pressed={place === 'help'} onClick={() => go('help')}><Icon name="help" size={16} /><span>Help</span></button>
      </span>
    </header>
    <div className="row">
      <nav className="rail" aria-label="TabTasker Dictate">
        <button type="button" className="rail-brand" aria-label="About TabTasker Dictate" title="TabTasker Dictate" aria-current={place === 'about' ? 'page' : undefined} onClick={() => go('about')}><Logo size={28} /></button>
        <ul className="rail-group">{PLACES.map(p => railItem(p, place === p.route, () => go(p.route)))}</ul>
        <ul className="rail-group rail-foot">{railItem(EXTRA.settings, settingsOpen, () => go('settings'))}</ul>
      </nav>
      {withColumn && <aside className="column" aria-label={`${here.title} sidebar`}>
        {props && place === 'notes' && <NotesColumn kind="note" path={arg} {...props} onError={setToast} onOpen={go} />}
        {props && place === 'meetings' && <NotesColumn kind="meeting" path={arg} {...props} onError={setToast} onOpen={go} />}
        {props && settingsOpen && <SettingsColumn current={here.route} onOpen={go} />}
      </aside>}
      <main key={`${tab.id}:${place}`} className="content" aria-label={here.title}>
        {props && place === 'notes' && <NotePage kind="note" path={arg} {...props} onError={setToast} onOpen={go} />}
        {props && place === 'meetings' && <NotePage kind="meeting" path={arg} {...props} onError={setToast} onOpen={go} />}
        {props && place === 'stickies' && <div className="page wide"><StickiesView onError={setToast} /></div>}
        {props && place === 'about' && <div className="page"><About {...props} /></div>}
        {props && place === 'help' && <div className="page help"><HelpView settings={props.settings} /></div>}
        {props && settingsOpen && <div className="page">{(() => { const Page = (SETTINGS.find(p => p.route === here.route) ?? SETTINGS[0]).Page; return <Page {...props} />; })()}</div>}
      </main>
    </div>
    {toast && <Toast message={toast} error onDone={hideToast} />}
  </div>;
}

/// The settings pages as the column's rows.
function SettingsColumn({ current, onOpen }: { current: string; onOpen: (route: string) => void }) {
  return <>
    <ColumnHead title="Settings" />
    <div className="column-scroll">
      <ul className="column-rows">
        {SETTINGS.map(page => <li key={page.route}>
          <button type="button" className="column-row" aria-current={current === page.route || undefined} onClick={() => onOpen(page.route)}>
            <span className="column-row-icon"><Icon name={page.icon} size={16} /></span>
            <span className="column-row-words"><span className="t">{page.title}</span></span>
          </button>
        </li>)}
      </ul>
    </div>
  </>;
}
