import { useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { TabAction } from '../api/types';
import { routeOf } from '../lib/routes';
import { reduced } from '../ui/motion';

// The window's tabs, as TabTasker Business's desktop app keeps them (desktopTabs.ts): a tab is a remembered
// place with its own back and forward, not a second page. Every change here keeps the tab on screen by who
// it is, not by where it stands, so moving, closing or reopening others never swaps it for a neighbour.
type Tab = { id: number; route: string; back: string[]; forward: string[] };
export type Tabs = { tabs: Tab[]; active: number };
/// A closed tab and where it stood, for Reopen Closed Tab.
export type Closed = { tab: Tab; at: number };

const idOf = (state: Tabs) => state.tabs[state.active]?.id;
const at = (tabs: Tab[], id: number | undefined) => Math.max(0, tabs.findIndex(tab => tab.id === id));
const freshId = (state: Tabs) => Math.max(0, ...state.tabs.map(tab => tab.id)) + 1;

/// A new tab at `route`, at the end (as ⌘T opens one in a browser) or at `index`, on screen.
export function openTab(state: Tabs, route = 'notes', index = state.tabs.length): Tabs {
  const tab = { id: freshId(state), route, back: [], forward: [] };
  const tabs = [...state.tabs];
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
  return { tabs, active: tabs.indexOf(tab) };
}

/// The tabs in `ids` closed, and what they were, for Reopen. When the tab on screen goes, the one to its
/// right takes the screen, or the last one when it was the last, as in a browser. Null when none would be
/// left: the window closes instead.
export function closeTabs(state: Tabs, ids: Set<number>): { state: Tabs; closed: Closed[] } | null {
  const tabs = state.tabs.filter(tab => !ids.has(tab.id));
  if (!tabs.length) return null;
  // Last out, first back: reopened from the front of the strip, each lands back where it stood.
  const closed = state.tabs.flatMap((tab, i) => ids.has(tab.id) ? [{ tab, at: i }] : []).reverse();
  const shown = idOf(state);
  if (shown !== undefined && !ids.has(shown)) return { state: { tabs, active: at(tabs, shown) }, closed };
  const right = state.tabs.slice(state.active + 1).find(tab => !ids.has(tab.id));
  return { state: { tabs, active: right ? at(tabs, right.id) : tabs.length - 1 }, closed };
}

/// A closed tab back where it stood (or at the end, if fewer tabs are open now), with its history, on screen.
export function reopenTab(state: Tabs, closed: Closed): Tabs {
  const tab = state.tabs.some(open => open.id === closed.tab.id) ? { ...closed.tab, id: freshId(state) } : closed.tab;
  const tabs = [...state.tabs];
  tabs.splice(Math.min(closed.at, tabs.length), 0, tab);
  return { tabs, active: tabs.indexOf(tab) };
}

/// The tab at `from` moved to `to`; the tab on screen stays on screen.
export function moveTab(state: Tabs, from: number, to: number): Tabs {
  if (from === to || from < 0 || from >= state.tabs.length) return state;
  const shown = idOf(state), tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
  return { tabs, active: at(tabs, shown) };
}

/// The next (1) or previous (-1) tab, round the ends.
export const cycleTabs = (state: Tabs, by: 1 | -1): Tabs => ({ ...state, active: (state.active + by + state.tabs.length) % state.tabs.length });

/// ⌘1 to ⌘8 for the first eight tabs, ⌘9 for the last, as in Safari and Chrome.
export const selectTab = (state: Tabs, n: number): Tabs => ({ ...state, active: n === 9 ? state.tabs.length - 1 : Math.min(n - 1, state.tabs.length - 1) });

/// A copy of the tab at `index` beside it, with its history, on screen.
export function duplicateTab(state: Tabs, index: number): Tabs {
  const source = state.tabs[index];
  if (!source) return state;
  const tabs = [...state.tabs], copy = { ...source, id: freshId(state), back: [...source.back], forward: [...source.forward] };
  tabs.splice(index + 1, 0, copy);
  return { tabs, active: index + 1 };
}

/// The window's tabs from what was saved (the raw `localStorage` string, or null) and the `location.hash`. Saved
/// tabs from an older build or a broken write fall back to one tab on the hash (or notes). The hash is what was
/// asked for (a note from the dots, a settings page from the menu): it goes to the open tab.
export function loadTabs(saved: string | null, hash: string): Tabs {
  const fallback: Tabs = { tabs: [{ id: 1, route: routeOf(hash), back: [], forward: [] }], active: 0 };
  try {
    const parsed = JSON.parse(saved ?? 'null') as Tabs | null;
    if (!parsed?.tabs?.length) return fallback;
    const active = Math.min(Math.max(0, parsed.active | 0), parsed.tabs.length - 1);
    const tabs = parsed.tabs.map(tab => ({ id: tab.id, route: tab.route || 'notes', back: tab.back ?? [], forward: tab.forward ?? [] }));
    if (hash.length > 1) tabs[active] = { ...tabs[active], route: routeOf(hash), forward: [] };
    return { tabs, active };
  } catch { return fallback; }
}

/// The open tab routed to `to`, remembering where it was (the last 50 places).
export function visit(state: Tabs, to: string): Tabs {
  const open = state.tabs[state.active];
  if (open.route === to) return state;
  return { ...state, tabs: state.tabs.map((tab, i) => i === state.active ? { ...tab, route: to, back: [...tab.back, tab.route].slice(-50), forward: [] } : tab) };
}

/// The open tab one place back; the same state when there is none.
export function goBack(state: Tabs): Tabs {
  const to = state.tabs[state.active].back.at(-1);
  if (!to) return state;
  return { ...state, tabs: state.tabs.map((x, i) => i === state.active ? { ...x, route: to, back: x.back.slice(0, -1), forward: [x.route, ...x.forward] } : x) };
}

/// The open tab one place forward; the same state when there is none.
export function goForward(state: Tabs): Tabs {
  const to = state.tabs[state.active].forward[0];
  if (!to) return state;
  return { ...state, tabs: state.tabs.map((x, i) => i === state.active ? { ...x, route: to, back: [...x.back, x.route], forward: x.forward.slice(1) } : x) };
}

/// Every tab action, from the keys, the menu bar, the strip and a tab's menu: the tabs after it, the closed list
/// (newest last, the last 20) and whether the window closes. `index` is the tab it is about (the active one for
/// keys); closing every tab, or `'window'`, closes the window and leaves the tabs as they are.
export function applyTabAction(state: Tabs, closed: Closed[], action: TabAction, index: number): { state: Tabs; closed: Closed[]; closeWindow: boolean } {
  const tab = state.tabs[index];
  const keep = { state, closed, closeWindow: false };
  const shut = (ids: number[]) => {
    if (!ids.length) return keep;
    const result = closeTabs(state, new Set(ids));
    if (!result) return { state, closed: [...closed, ...state.tabs.map((t, at) => ({ tab: t, at }))].slice(-20), closeWindow: true };
    return { state: result.state, closed: [...closed, ...result.closed].slice(-20), closeWindow: false };
  };
  switch (action) {
    case 'new': return { ...keep, state: openTab(state) };
    case 'close': return tab ? shut([tab.id]) : keep;
    case 'close-others': return tab ? shut(state.tabs.filter(other => other.id !== tab.id).map(other => other.id)) : keep;
    case 'close-right': return shut(state.tabs.slice(index + 1).map(other => other.id));
    case 'reopen': { const last = closed.at(-1); return last ? { ...keep, state: reopenTab(state, last), closed: closed.slice(0, -1) } : keep; }
    case 'duplicate': return { ...keep, state: duplicateTab(state, index) };
    case 'next': case 'prev': return state.tabs.length > 1 ? { ...keep, state: cycleTabs(state, action === 'next' ? 1 : -1) } : keep;
    case 'left': case 'right': return { ...keep, state: moveTab(state, state.active, state.active + (action === 'right' ? 1 : -1)) };
    case 'window': return { ...keep, closeWindow: true };
    default: return { ...keep, state: selectTab(state, Number(action.slice(7))) };
  }
}

// ---------- dragging a tab along the strip ----------

const SLIDE = 'transform 180ms cubic-bezier(.22, 1, .36, 1)';
type Hold = { id: string; pointer: number; x: number; y: number; live: boolean; grab: number; pointerX: number; from: string[]; order: string };

/// Dragging a tab works as in a browser's tab strip (Business's useTabDrag): past 6 px the tab comes up and
/// follows the pointer along the strip, the others slide aside (the strip's FLIP, data-flip, moves them: the
/// held tab is taken out of it while it follows the pointer), and the order changes as it passes their
/// middles. Escape puts it back where it started; the click a drag ends with selects nothing. Following the
/// pointer is styled on the tab directly, so it re-renders nothing. `move` takes the tab's index and its new one.
export function useTabDrag(move: (from: number, to: number) => void) {
  const list = useRef<HTMLDivElement>(null);
  const hold = useRef<Hold | null>(null);
  const dragged = useRef(false);
  const escape = useRef<(event: KeyboardEvent) => void>(() => {});

  const tabs = () => [...(list.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])];
  const tabOf = (id: string) => tabs().find(tab => tab.dataset.tabId === id);
  /// Where layout puts a tab, whatever it is being slid by: offsets ignore transforms.
  const slot = (tab: HTMLElement) => ({ left: list.current!.getBoundingClientRect().left - list.current!.scrollLeft + tab.offsetLeft, width: tab.offsetWidth });
  /// The strip with tab `id` let go at `x`: before the first other tab whose middle `x` has not passed.
  const orderAt = (x: number, id: string) => {
    const others = tabs().filter(tab => tab.dataset.tabId !== id);
    const before = others.findIndex(tab => { const box = slot(tab); return x < box.left + box.width / 2; });
    const ids = others.map(tab => tab.dataset.tabId!);
    ids.splice(before < 0 ? ids.length : before, 0, id);
    return ids;
  };
  const arrange = (ids: string[], held: string) => {
    const from = tabs().findIndex(tab => tab.dataset.tabId === held);
    move(from, ids.indexOf(held));
  };
  /// The held tab under the pointer, from wherever layout has put it now.
  const follow = () => {
    const h = hold.current, tab = h && tabOf(h.id);
    if (!h || !tab || !h.live) return;
    tab.style.transition = 'none';
    tab.style.transform = `translateX(${h.pointerX - h.grab - slot(tab).left}px)`;
  };
  const settle = (tab: HTMLElement | undefined) => {
    if (!tab) return;
    tab.style.transition = reduced() ? 'none' : SLIDE;
    tab.style.transform = '';
    // The transition goes back to the stylesheet, whose hover fades it would otherwise override.
    setTimeout(() => { if (!tab.style.transform) tab.style.transition = ''; }, 220);
  };
  // After every render (a reorder mid-drag above all) the held tab keeps following from its new slot.
  useLayoutEffect(follow);

  const end = (restore = false) => {
    const h = hold.current;
    hold.current = null;
    window.removeEventListener('keydown', escape.current);
    if (!h) return;
    if (restore && h.live && h.order !== h.from.join(' ')) arrange(h.from, h.id);
    const tab = tabOf(h.id);
    if (tab) { delete tab.dataset.lifted; tab.dataset.flip = h.id; }
    settle(tab);
    if (list.current) delete list.current.dataset.tabDragging;
  };
  escape.current = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); end(true); } };
  const pressed = (event: ReactPointerEvent) => { const h = hold.current; return h && h.pointer === event.pointerId ? h : null; };

  return {
    ref: list,
    onPointerDown: (event: ReactPointerEvent) => {
      const target = event.target as Element, tab = target.closest<HTMLElement>('[data-tab-id]');
      if (event.button !== 0 || !tab || target.closest('.tab-close')) return;
      hold.current = { id: tab.dataset.tabId!, pointer: event.pointerId, x: event.clientX, y: event.clientY, live: false, grab: 0, pointerX: event.clientX, from: [], order: '' };
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const h = pressed(event);
      if (!h) return;
      if (!h.live) {
        if (Math.hypot(event.clientX - h.x, event.clientY - h.y) < 6) return;
        const tab = tabOf(h.id);
        if (!tab || !list.current) return;
        h.live = true;
        try { list.current.setPointerCapture(event.pointerId); } catch { /* a pointer already let go cannot be captured */ }
        list.current.dataset.tabDragging = '';
        tab.dataset.lifted = '';
        delete tab.dataset.flip; // the pointer moves it, not the strip's glide
        h.grab = h.x - slot(tab).left;
        h.from = tabs().map(box => box.dataset.tabId!);
        h.order = h.from.join(' ');
        window.addEventListener('keydown', escape.current);
      }
      h.pointerX = event.clientX;
      const ids = orderAt(event.clientX, h.id);
      if (ids.join(' ') !== h.order) { h.order = ids.join(' '); arrange(ids, h.id); }
      follow();
    },
    onPointerUp: (event: ReactPointerEvent) => {
      const h = pressed(event);
      if (!h) return;
      if (h.live) { dragged.current = true; setTimeout(() => { dragged.current = false; }, 0); } // the click this release makes
      end();
    },
    onPointerCancel: () => end(true),
    onLostPointerCapture: () => { if (hold.current?.live) end(); },
    onClickCapture: (event: ReactMouseEvent) => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); } },
  };
}
