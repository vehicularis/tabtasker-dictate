import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { closeWindow, listen } from '../bridge';
import { Menu, MenuItem, MenuLine } from '../editor/Menu';
import { Onboarding } from '../onboarding/Onboarding';
import { PLACE_GLYPHS, SETTINGS_GLYPHS } from '../overlay/glyphs';
import { Logo } from '../overlay/icons';
import { updateSettings, useSettings, type PageProps, type Patch } from '../store';
import { applyTheme, Icon, leave, Toast, useFlip, type IconName } from '../ui';
import { ColumnHead } from './Column';
import { About } from './pages/About';
import { Appearance } from './pages/Appearance';
import { AppStyles } from './pages/AppStyles';
import { Dictation } from './pages/Dictation';
import { General } from './pages/General';
import { History } from './pages/History';
import { Meetings } from './pages/Meetings';
import { Notes } from './pages/Notes';
import { SettingsAI } from './pages/SettingsAI';
import { Shortcuts } from './pages/Shortcuts';
import { Vocabulary } from './pages/Vocabulary';
import { HelpView } from './views/HelpView';
import { NotePage, NotesColumn, useLibrary } from './views/NotesView';
import { StickiesView } from './views/StickiesView';
import { closeTabs, cycleTabs, duplicateTab, moveTab, openTab, reopenTab, selectTab, useTabDrag, type Closed, type Tabs } from './tabs';

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
/// The settings, a page each, in three groups as Business's settings column groups its sections.
const SETTINGS: (Place & { Page: ComponentType<PageProps>; group: string })[] = [
  { route: 'settings', title: 'General', icon: 'general', Page: General, group: 'Dictation' },
  { route: 'settings/shortcuts', title: 'Shortcuts', icon: 'keyboard', Page: Shortcuts, group: 'Dictation' },
  { route: 'settings/speech', title: 'Speech', icon: 'waveform', Page: Dictation, group: 'Dictation' },
  { route: 'settings/apps', title: 'App styles', icon: 'apps', Page: AppStyles, group: 'Dictation' },
  { route: 'settings/vocabulary', title: 'Vocabulary', icon: 'book', Page: Vocabulary, group: 'Dictation' },
  { route: 'settings/notes', title: 'Notes', icon: 'note', Page: Notes, group: 'Notes' },
  { route: 'settings/meetings', title: 'Meetings', icon: 'meeting', Page: Meetings, group: 'Notes' },
  { route: 'settings/agents', title: 'Agents', icon: 'agents', Page: SettingsAI, group: 'App' },
  { route: 'settings/appearance', title: 'Appearance', icon: 'appearance', Page: Appearance, group: 'App' },
  { route: 'settings/history', title: 'History & stats', icon: 'history', Page: History, group: 'App' },
];
const SETTINGS_GROUPS = [...new Set(SETTINGS.map(page => page.group))];
const EXTRA: Record<string, Place> = {
  about: { route: 'about', title: 'About', icon: 'about' },
  help: { route: 'help', title: 'Help', icon: 'help' },
  setup: { route: 'setup', title: 'Set up', icon: 'general' },
  settings: { route: 'settings', title: 'Settings', icon: 'general' },
};

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
  const items = useLibrary(place === 'notes' ? 'note' : place === 'meetings' ? 'meeting' : null, arg, setToast);
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
  // A tab opened or closed: the others and the plus slide to make room or close the gap.
  const strip = useRef<HTMLDivElement>(null);
  useFlip(strip, tabs.map(t => t.id).join());
  // One element, two refs: the FLIP's and the drag's.
  const theme = settings?.appearance.theme;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  const hideToast = useCallback(() => setToast(null), []);
  const update = useCallback((patch: Patch) => updateSettings(patch).catch(error => { setToast(typeof error === 'string' ? error : 'Couldn’t save that change.'); return undefined; }), []);

  const go = useCallback((to: string) => setState(s => visit(s, to)), []);
  // Every tab action, from the keys, the menu bar (`dictate-tab`), the strip and a tab's menu. The tabs as they
  // are now are read from a ref, so closing the last one can close the window outside a state update.
  const now = useRef(state); now.current = state;
  const closed = useRef<Closed[]>([]); // newest last, for Reopen Closed Tab
  const close = useCallback((ids: number[]) => {
    const result = closeTabs(now.current, new Set(ids));
    if (!result) { closed.current = [...closed.current, ...now.current.tabs.map((tab, at) => ({ tab, at }))].slice(-20); closeWindow(); return; }
    closed.current = [...closed.current, ...result.closed].slice(-20);
    setState(result.state);
  }, []);
  const tabAction = useCallback((action: string, index = now.current.active) => {
    const s = now.current, tab = s.tabs[index];
    if (action === 'new') setState(openTab(s));
    else if (action === 'close' && tab) close([tab.id]);
    else if (action === 'close-others' && tab) close(s.tabs.filter(other => other.id !== tab.id).map(other => other.id));
    else if (action === 'close-right') close(s.tabs.slice(index + 1).map(other => other.id));
    else if (action === 'reopen') { const last = closed.current.at(-1); if (last) { closed.current = closed.current.slice(0, -1); setState(reopenTab(s, last)); } }
    else if (action === 'duplicate') setState(duplicateTab(s, index));
    else if (action === 'next' || action === 'prev') { if (s.tabs.length > 1) setState(cycleTabs(s, action === 'next' ? 1 : -1)); }
    else if (action === 'left' || action === 'right') setState(moveTab(s, s.active, s.active + (action === 'right' ? 1 : -1)));
    else if (action === 'window') closeWindow();
    else if (/^select:[1-9]$/.test(action)) setState(selectTab(s, Number(action.slice(7))));
  }, [close]);
  const newTab = useCallback(() => tabAction('new'), [tabAction]);
  const closeTab = useCallback((at: number) => tabAction('close', at), [tabAction]);
  // The menu bar's File and Window items (lib.rs), when the page didn't take the key first.
  useEffect(() => listen<string>('dictate-tab', action => tabAction(action)), [tabAction]);
  const drag = useTabDrag((from, to) => setState(s => moveTab(s, from, to)));
  const [tabMenu, setTabMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const dragRef = drag.ref;
  const stripRef = useCallback((el: HTMLDivElement | null) => { strip.current = el; dragRef.current = el; }, [dragRef]);
  // The tab on screen is never scrolled out of the strip.
  const tabId = tab.id;
  useEffect(() => { strip.current?.querySelector(`[data-tab-id="${tabId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }, [tabId]);
  const back = useCallback(() => setState(s => {
    const t = s.tabs[s.active]; const to = t.back.at(-1); if (!to) return s;
    return { ...s, tabs: s.tabs.map((x, i) => i === s.active ? { ...x, route: to, back: x.back.slice(0, -1), forward: [x.route, ...x.forward] } : x) };
  }), []);
  const forward = useCallback(() => setState(s => {
    const t = s.tabs[s.active]; const to = t.forward[0]; if (!to) return s;
    return { ...s, tabs: s.tabs.map((x, i) => i === s.active ? { ...x, route: to, back: [...x.back, x.route], forward: x.forward.slice(1) } : x) };
  }), []);
  useEffect(() => {
    // The tab keys of Safari and Chrome. ⌃Tab and ⌃⇧Tab; ⌘⇧] and ⌘⇧[, or ⌘⌥→ and ⌘⌥←, for the next and the
    // previous tab; ⌘⌥⇧→ and ⌘⌥⇧← move the tab itself. The menu bar lists them too (lib.rs), and acts only on a
    // key the page has not taken. `event.code` for the brackets and digits: they are on the same keys whatever
    // the layout prints on them.
    const key = (event: KeyboardEvent) => {
      const { metaKey: cmd, ctrlKey: ctrl, altKey: alt, shiftKey: shift, code } = event;
      let action: string | null = null;
      if (ctrl && !cmd && !alt && code === 'Tab') action = shift ? 'prev' : 'next';
      else if (cmd && !ctrl) {
        if (alt && shift && (code === 'ArrowLeft' || code === 'ArrowRight')) action = code === 'ArrowRight' ? 'right' : 'left';
        else if (alt && !shift && (code === 'ArrowLeft' || code === 'ArrowRight')) action = code === 'ArrowRight' ? 'next' : 'prev';
        else if (!alt && shift && (code === 'BracketLeft' || code === 'BracketRight')) action = code === 'BracketRight' ? 'next' : 'prev';
        else if (!alt && !shift && code === 'BracketLeft') { back(); event.preventDefault(); return; }
        else if (!alt && !shift && code === 'BracketRight') { forward(); event.preventDefault(); return; }
        else if (!alt && !shift && code === 'Comma') { go('settings'); event.preventDefault(); return; }
        else if (!alt && code === 'KeyT') action = shift ? 'reopen' : 'new';
        else if (!alt && code === 'KeyW') action = shift ? 'window' : 'close';
        else if (!alt && !shift && /^Digit[1-9]$/.test(code)) action = `select:${code.slice(5)}`;
      }
      if (!action) return;
      event.preventDefault();
      tabAction(action);
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [go, tabAction, back, forward]);

  if (place === 'setup') return <Onboarding />;
  const props: PageProps | null = settings && { settings, update };
  const settingsOpen = place === 'settings';
  // A column only where there is a list to put in it: the notes and the meetings once there are some (known,
  // not assumed, or an empty place would flash one), the settings pages. With none, the page has the window to
  // itself; the stickies page is its own list.
  const hasColumn = (place === 'notes' || place === 'meetings') && !!items?.length || settingsOpen; // archived ones count: the archive is in the column
  const listed = items && items.filter(item => !item.archived);
  const withColumn = column && hasColumn;
  const railItem = (candidate: Place, on: boolean, onClick: () => void) => { const Glyph = PLACE_GLYPHS[candidate.route]; return <li key={candidate.route}>
    <button type="button" className="rail-item" aria-label={candidate.title} title={candidate.title} aria-current={on ? 'page' : undefined} onClick={onClick}>{Glyph ? <Glyph size={24} /> : <Icon name={candidate.icon} size={18} />}</button>
  </li>; }

  return <div className="window">
    <header className="titlebar" data-tauri-drag-region>
      <span className="bar-tools">
        <button type="button" className="bar-tool" aria-label={column ? 'Hide the column' : 'Show the column'} title="Toggle sidebar" aria-pressed={column} disabled={!hasColumn} onClick={() => setColumn(open => !open)}><Icon name="sidebar" size={16} /></button>
        <button type="button" className="bar-tool" aria-label="Back" title="Back (⌘[)" disabled={!tab.back.length} onClick={back}><Icon name="chevronLeft" size={16} /></button>
        <button type="button" className="bar-tool" aria-label="Forward" title="Forward (⌘])" disabled={!tab.forward.length} onClick={forward}><Icon name="chevronRight" size={16} /></button>
      </span>
      <div ref={stripRef} className="tabs" role="tablist" aria-label="Tabs" data-tauri-drag-region
        onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove} onPointerUp={drag.onPointerUp} onPointerCancel={drag.onPointerCancel}
        onLostPointerCapture={drag.onLostPointerCapture} onClickCapture={drag.onClickCapture}
        onKeyDown={event => {
          // The tabs as one control: the arrows, Home and End walk them, and the tab walked to is shown.
          const to = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: tabs.length - 1 }[event.key];
          if (to === undefined || !(event.target as Element).closest('.tab-select') || event.metaKey || event.altKey) return;
          event.preventDefault();
          const next = (to + tabs.length) % tabs.length;
          setState(s => ({ ...s, active: next }));
          requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab-id="${tabs[next].id}"] .tab-select`)?.focus());
        }}>
        {tabs.map((t, i) => { const p = placeOf(t.route); const title = titleOf(t.route); const on = i === active; return <div key={t.id} className="tab" aria-selected={on} data-flip={t.id} data-tab-id={t.id}
          onContextMenu={event => { event.preventDefault(); setTabMenu({ index: i, x: event.clientX, y: event.clientY }); }}>
          <button type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} title={title} className="tab-select" onClick={() => setState(s => ({ ...s, active: i }))}
            onMouseDown={event => { if (event.button === 1) event.preventDefault(); }} onAuxClick={event => { if (event.button === 1) closeTab(i); }}>
            <Icon name={p.icon} size={16} /><span className="tab-title">{title}</span>
          </button>
          {tabs.length > 1 && <button type="button" className="tab-close" aria-label={`Close ${title}`} title="Close tab (⌘W)" onClick={() => closeTab(i)}><Icon name="close" size={12} /></button>}
        </div>; })}
        <button type="button" className="bar-tool" aria-label="New tab" title="New tab (⌘T)" data-flip="new" onClick={() => newTab()}><Icon name="plus" size={16} /></button>
      </div>
      {tabMenu && tabs[tabMenu.index] && <Menu label="Tab" className="tab-menu" keep={false} anchor={() => new DOMRect(tabMenu.x, tabMenu.y, 0, 0)} onClose={() => setTabMenu(null)}>
        <MenuItem onSelect={() => { setTabMenu(null); tabAction('new'); }}>New tab<kbd>⌘T</kbd></MenuItem>
        <MenuItem onSelect={() => { setTabMenu(null); tabAction('duplicate', tabMenu.index); }}>Duplicate tab</MenuItem>
        <MenuItem disabled={!closed.current.length} onSelect={() => { setTabMenu(null); tabAction('reopen'); }}>Reopen closed tab<kbd>⇧⌘T</kbd></MenuItem>
        <MenuLine />
        <MenuItem disabled={tabMenu.index === 0} onSelect={() => { setTabMenu(null); setState(s => moveTab(s, tabMenu.index, 0)); }}>Move to the start</MenuItem>
        <MenuItem disabled={tabMenu.index === tabs.length - 1} onSelect={() => { setTabMenu(null); setState(s => moveTab(s, tabMenu.index, s.tabs.length - 1)); }}>Move to the end</MenuItem>
        <MenuLine />
        <MenuItem onSelect={() => { setTabMenu(null); tabAction('close', tabMenu.index); }}>Close tab<kbd>⌘W</kbd></MenuItem>
        <MenuItem disabled={tabs.length < 2} onSelect={() => { setTabMenu(null); tabAction('close-others', tabMenu.index); }}>Close other tabs</MenuItem>
        <MenuItem disabled={tabMenu.index === tabs.length - 1} onSelect={() => { setTabMenu(null); tabAction('close-right', tabMenu.index); }}>Close tabs to the right</MenuItem>
      </Menu>}
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
      {withColumn && <aside ref={leave} className="column" aria-label={`${here.title} sidebar`}>
        {props && place === 'notes' && <NotesColumn kind="note" path={arg} items={items} {...props} onError={setToast} onOpen={go} />}
        {props && place === 'meetings' && <NotesColumn kind="meeting" path={arg} items={items} {...props} onError={setToast} onOpen={go} />}
        {props && settingsOpen && <SettingsColumn current={here.route} onOpen={go} />}
      </aside>}
      <main key={`${tab.id}:${place}`} className="content" aria-label={here.title}>
        {props && place === 'notes' && <NotePage kind="note" path={arg} items={listed} {...props} onError={setToast} onOpen={go} />}
        {props && place === 'meetings' && <NotePage kind="meeting" path={arg} items={listed} {...props} onError={setToast} onOpen={go} />}
        {props && place === 'stickies' && <div className="page wide"><StickiesView onError={setToast} /></div>}
        {props && place === 'about' && <div className="page"><About {...props} /></div>}
        {props && place === 'help' && <div className="page help"><HelpView settings={props.settings} /></div>}
        {props && settingsOpen && <div key={here.route} className="page">{(() => { const Page = (SETTINGS.find(p => p.route === here.route) ?? SETTINGS[0]).Page; return <Page {...props} />; })()}</div>}
      </main>
    </div>
    {toast && <Toast message={toast} error onDone={hideToast} />}
  </div>;
}

/// The settings pages as the column's rows, under their group's heading.
function SettingsColumn({ current, onOpen }: { current: string; onOpen: (route: string) => void }) {
  return <>
    <ColumnHead title="Settings" />
    <div className="column-scroll">
      {SETTINGS_GROUPS.map(group => <section key={group} className="column-section">
        <h3 className="column-heading">{group}</h3>
        <ul className="column-rows">
          {SETTINGS.filter(page => page.group === group).map(page => { const Glyph = SETTINGS_GLYPHS[page.route]; return <li key={page.route}>
            <button type="button" className="column-row" aria-current={current === page.route || undefined} onClick={() => onOpen(page.route)}>
              <span className="column-row-icon">{Glyph ? <Glyph size={22} /> : <Icon name={page.icon} size={16} />}</span>
              <span className="column-row-words"><span className="t">{page.title}</span></span>
            </button>
          </li>; })}
        </ul>
      </section>)}
    </div>
  </>;
}
