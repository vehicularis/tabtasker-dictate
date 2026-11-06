import { describe, expect, it } from 'vitest';
import type { TabAction } from '../api/types';
import { applyTabAction, closeTabs, cycleTabs, duplicateTab, goBack, goForward, loadTabs, moveTab, openTab, reopenTab, selectTab, visit, type Closed, type Tabs } from './tabs';

const tab = (id: number, route = `r${id}`) => ({ id, route, back: [] as string[], forward: [] as string[] });
/// Tabs with the given ids, `active` being an index.
const strip = (ids: number[], active: number): Tabs => ({ tabs: ids.map(id => tab(id)), active });
const ids = (state: Tabs) => state.tabs.map(t => t.id);
const shown = (state: Tabs) => state.tabs[state.active].id;

describe('openTab', () => {
  it('opens at the end on notes, and shows it', () => {
    const next = openTab(strip([1, 2], 0));
    expect(ids(next)).toEqual([1, 2, 3]);
    expect(next.tabs[2]).toEqual({ id: 3, route: 'notes', back: [], forward: [] });
    expect(next.active).toBe(2);
  });
  it('opens at a route and an index', () => {
    const next = openTab(strip([1, 2, 3], 2), 'agents', 1);
    expect(ids(next)).toEqual([1, 4, 2, 3]);
    expect(next.tabs[1].route).toBe('agents');
    expect(next.active).toBe(1);
  });
  it('clamps the index to the strip', () => {
    expect(ids(openTab(strip([1, 2], 0), 'x', 99))).toEqual([1, 2, 3]);
    expect(openTab(strip([1, 2], 1), 'x', -5).active).toBe(0);
    expect(ids(openTab(strip([1, 2], 1), 'x', -5))).toEqual([3, 1, 2]);
  });
  it('takes an id above every open one, even when the highest sits in the middle', () => {
    expect(ids(openTab(strip([7, 2], 0)))).toEqual([7, 2, 8]);
  });
  it('does not change the strip it was given', () => {
    const before = strip([1, 2], 0);
    openTab(before);
    expect(ids(before)).toEqual([1, 2]);
  });
});

describe('closeTabs', () => {
  it('keeps the shown tab shown when another one closes', () => {
    const out = closeTabs(strip([1, 2, 3], 2), new Set([1]))!;
    expect(ids(out.state)).toEqual([2, 3]);
    expect(shown(out.state)).toBe(3);
  });
  it('shows the right neighbour when the shown tab closes', () => {
    const out = closeTabs(strip([1, 2, 3], 1), new Set([2]))!;
    expect(ids(out.state)).toEqual([1, 3]);
    expect(shown(out.state)).toBe(3);
  });
  it('shows the left neighbour when the shown tab was the last', () => {
    const out = closeTabs(strip([1, 2, 3], 2), new Set([3]))!;
    expect(shown(out.state)).toBe(2);
  });
  it('closes several at once, remembering them last first with where they stood', () => {
    const out = closeTabs(strip([1, 2, 3, 4], 0), new Set([2, 4]))!;
    expect(ids(out.state)).toEqual([1, 3]);
    expect(out.closed.map(c => [c.tab.id, c.at])).toEqual([[4, 3], [2, 1]]);
    expect(shown(out.state)).toBe(1);
  });
  it('skips closing neighbours when the shown tab goes with them', () => {
    const out = closeTabs(strip([1, 2, 3, 4], 1), new Set([2, 3]))!;
    expect(ids(out.state)).toEqual([1, 4]);
    expect(shown(out.state)).toBe(4);
  });
  it('shows the last tab when the shown one and everything right of it close', () => {
    const out = closeTabs(strip([1, 2, 3, 4], 2), new Set([3, 4]))!;
    expect(ids(out.state)).toEqual([1, 2]);
    expect(shown(out.state)).toBe(2);
  });
  it('closes nothing for ids that are not open', () => {
    const out = closeTabs(strip([1, 2], 1), new Set([9]))!;
    expect(ids(out.state)).toEqual([1, 2]);
    expect(out.closed).toEqual([]);
    expect(out.state.active).toBe(1);
  });
  it('is null when all of them close: the window closes instead', () => {
    expect(closeTabs(strip([1, 2], 0), new Set([1, 2]))).toBeNull();
  });
});

describe('reopenTab', () => {
  it('puts the tab back at its index, with its history, on screen', () => {
    const closed = { tab: { id: 2, route: 'agents', back: ['notes'], forward: ['stats'] }, at: 1 };
    const next = reopenTab(strip([1, 3], 0), closed);
    expect(ids(next)).toEqual([1, 2, 3]);
    expect(next.tabs[1]).toEqual(closed.tab);
    expect(next.active).toBe(1);
  });
  it('puts it at the end when fewer tabs are open now', () => {
    const next = reopenTab(strip([1], 0), { tab: tab(5), at: 4 });
    expect(ids(next)).toEqual([1, 5]);
    expect(next.active).toBe(1);
  });
  it('gives a fresh id when its id is taken again, keeping the rest', () => {
    const closed = { tab: { id: 2, route: 'agents', back: ['notes'], forward: [] }, at: 0 };
    const next = reopenTab(strip([2, 3], 1), closed);
    expect(ids(next)).toEqual([4, 2, 3]);
    expect(next.tabs[0]).toEqual({ id: 4, route: 'agents', back: ['notes'], forward: [] });
    expect(next.active).toBe(0);
  });
});

describe('moveTab', () => {
  it('moves a tab, and the shown tab stays shown when it is the one moved', () => {
    const next = moveTab(strip([1, 2, 3], 0), 0, 2);
    expect(ids(next)).toEqual([2, 3, 1]);
    expect(shown(next)).toBe(1);
  });
  it('keeps another shown tab shown as it shifts', () => {
    const next = moveTab(strip([1, 2, 3], 1), 0, 2);
    expect(ids(next)).toEqual([2, 3, 1]);
    expect(shown(next)).toBe(2);
    expect(next.active).toBe(0);
  });
  it('moves backwards', () => {
    const next = moveTab(strip([1, 2, 3], 2), 2, 0);
    expect(ids(next)).toEqual([3, 1, 2]);
    expect(next.active).toBe(0);
  });
  it('clamps the destination', () => {
    expect(ids(moveTab(strip([1, 2, 3], 0), 0, 99))).toEqual([2, 3, 1]);
    expect(ids(moveTab(strip([1, 2, 3], 0), 2, -4))).toEqual([3, 1, 2]);
  });
  it('is a no-op for the same place or a source out of range', () => {
    const state = strip([1, 2, 3], 1);
    expect(moveTab(state, 1, 1)).toBe(state);
    expect(moveTab(state, -1, 0)).toBe(state);
    expect(moveTab(state, 3, 0)).toBe(state);
  });
});

describe('cycleTabs', () => {
  it('goes to the next and the previous', () => {
    expect(cycleTabs(strip([1, 2, 3], 0), 1).active).toBe(1);
    expect(cycleTabs(strip([1, 2, 3], 2), -1).active).toBe(1);
  });
  it('wraps both ways', () => {
    expect(cycleTabs(strip([1, 2, 3], 2), 1).active).toBe(0);
    expect(cycleTabs(strip([1, 2, 3], 0), -1).active).toBe(2);
  });
  it('stays on a lone tab', () => {
    expect(cycleTabs(strip([1], 0), 1).active).toBe(0);
    expect(cycleTabs(strip([1], 0), -1).active).toBe(0);
  });
});

describe('selectTab', () => {
  const state = strip([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0);
  it('1 to 8 pick the first eight', () => {
    expect(selectTab(state, 1).active).toBe(0);
    expect(selectTab(state, 8).active).toBe(7);
  });
  it('9 is the last tab, as in Safari', () => {
    expect(selectTab(state, 9).active).toBe(9);
    expect(selectTab(strip([1, 2, 3], 0), 9).active).toBe(2);
  });
  it('a number past the end is the last tab', () => {
    expect(selectTab(strip([1, 2, 3], 0), 5).active).toBe(2);
  });
});

describe('duplicateTab', () => {
  it('copies the tab beside it with its own history, on screen', () => {
    const state: Tabs = { tabs: [{ id: 1, route: 'notes', back: ['a'], forward: ['b'] }, tab(2)], active: 1 };
    const next = duplicateTab(state, 0);
    expect(ids(next)).toEqual([1, 3, 2]);
    expect(next.tabs[1]).toEqual({ id: 3, route: 'notes', back: ['a'], forward: ['b'] });
    expect(next.tabs[1].back).not.toBe(state.tabs[0].back);
    expect(next.tabs[1].forward).not.toBe(state.tabs[0].forward);
    expect(next.active).toBe(1);
  });
  it('is a no-op for an index with no tab', () => {
    const state = strip([1, 2], 0);
    expect(duplicateTab(state, 5)).toBe(state);
    expect(duplicateTab(state, -1)).toBe(state);
  });
});

describe('loadTabs', () => {
  const one = (route: string): Tabs => ({ tabs: [{ id: 1, route, back: [], forward: [] }], active: 0 });
  it.each([[null], ['{}'], ['not json'], ['{"tabs":"x"}'], ['{"tabs":[]}'], ['{"tabs":[null]}']])('falls back to one tab on notes for %s', saved => {
    expect(loadTabs(saved, '')).toEqual(one('notes'));
  });
  it('opens on a malformed hash', () => expect(loadTabs(null, '#notes/100%')).toEqual(one('notes/100%')));
  it('falls back to the hash', () => expect(loadTabs('not json', '#help')).toEqual(one('help')));
  it('fills a missing back, forward and route', () => {
    expect(loadTabs('{"tabs":[{"id":4}],"active":0}', '').tabs).toEqual([{ id: 4, route: 'notes', back: [], forward: [] }]);
  });
  it('guards each field: a route that is not a string, back that is not a list, non-strings in a list', () => {
    const state = loadTabs('{"tabs":[{"id":1,"route":5,"back":"x","forward":["a",3,null]}],"active":0}', '');
    expect(state.tabs).toEqual([{ id: 1, route: 'notes', back: [], forward: ['a'] }]);
  });
  it('gives a tab without a usable id a fresh one, distinct from every other, and closing one closes only it', () => {
    const state = loadTabs('{"tabs":[{"route":"a"},{"id":"7","route":"b"},{"id":3,"route":"c"},{"id":null,"route":"d"}],"active":0}', '');
    expect(ids(state)).toEqual([4, 5, 3, 6]);
    expect(new Set(ids(state)).size).toBe(4);
    const closed = closeTabs(state, new Set([state.tabs[0].id]))!;
    expect(closed.state.tabs.map(t => t.route)).toEqual(['b', 'c', 'd']);
  });
  it('clamps active', () => {
    const saved = (active: number) => JSON.stringify({ tabs: [tab(1), tab(2)], active });
    expect(loadTabs(saved(-1), '').active).toBe(0);
    expect(loadTabs(saved(99), '').active).toBe(1);
  });
  it('sends the hash to the open tab and clears its forward list', () => {
    const saved = JSON.stringify({ tabs: [tab(1), { ...tab(2), back: ['a'], forward: ['b'] }], active: 1 });
    const state = loadTabs(saved, '#about');
    expect(state.tabs[1]).toEqual({ id: 2, route: 'about', back: ['a'], forward: [] });
    expect(state.tabs[0]).toEqual(tab(1));
  });
  it('keeps the saved routes when there is no hash', () => {
    expect(loadTabs(JSON.stringify(strip([1, 2], 1)), '#').tabs[1].route).toBe('r2');
  });
});

describe('visit', () => {
  it('is the same object for the same route', () => {
    const state = strip([1], 0);
    expect(visit(state, 'r1')).toBe(state);
  });
  it('remembers where it was and clears forward', () => {
    const state: Tabs = { tabs: [{ ...tab(1), forward: ['x'] }], active: 0 };
    expect(visit(state, 'b').tabs[0]).toEqual({ id: 1, route: 'b', back: ['r1'], forward: [] });
  });
  it('drops the oldest past 50', () => {
    let state = strip([1], 0);
    for (let i = 0; i < 51; i++) state = visit(state, `v${i}`);
    expect(state.tabs[0].back).toHaveLength(50);
    expect(state.tabs[0].back[0]).toBe('v0');
    expect(state.tabs[0].back.at(-1)).toBe('v49');
  });
  it('only moves the open tab', () => expect(visit(strip([1, 2], 1), 'b').tabs[0].route).toBe('r1'));
});

describe('goBack and goForward', () => {
  it('do nothing with empty stacks', () => {
    const state = strip([1], 0);
    expect(goBack(state)).toBe(state);
    expect(goForward(state)).toBe(state);
  });
  it('round trip', () => {
    const state = visit(visit(strip([1], 0), 'b'), 'c');
    const back = goBack(state);
    expect(back.tabs[0]).toEqual({ id: 1, route: 'b', back: ['r1'], forward: ['c'] });
    expect(goForward(back).tabs[0]).toEqual(state.tabs[0]);
  });
});

describe('applyTabAction', () => {
  const run = (state: Tabs, action: TabAction, index = state.active, closed: Closed[] = []) => applyTabAction(state, closed, action, index);
  const four = () => strip([1, 2, 3, 4], 1);
  it('new opens at the end', () => {
    const r = run(four(), 'new');
    expect(ids(r.state)).toEqual([1, 2, 3, 4, 5]);
    expect(r.state.active).toBe(4);
    expect(r.closeWindow).toBe(false);
  });
  it('close closes the tab at index and remembers it', () => {
    const r = run(four(), 'close', 2);
    expect(ids(r.state)).toEqual([1, 2, 4]);
    expect(shown(r.state)).toBe(2);
    expect(r.closed.map(c => c.tab.id)).toEqual([3]);
  });
  it('close with no tab at index does nothing', () => {
    const state = four();
    expect(run(state, 'close', 9)).toEqual({ state, closed: [], closeWindow: false });
  });
  it('closing the last tab closes the window and remembers all', () => {
    const state = strip([1], 0);
    const r = run(state, 'close');
    expect(r.closeWindow).toBe(true);
    expect(r.state).toBe(state);
    expect(r.closed.map(c => c.tab.id)).toEqual([1]);
  });
  it('close-others keeps the tab at index, not the active one', () => {
    const r = run(four(), 'close-others', 3);
    expect(ids(r.state)).toEqual([4]);
    expect(r.closed.map(c => c.tab.id)).toEqual([3, 2, 1]);
    expect(r.closeWindow).toBe(false);
  });
  it('close-others with one tab closes nothing and not the window', () => {
    const state = strip([1], 0);
    const r = run(state, 'close-others');
    expect(r.state).toBe(state);
    expect(r.closeWindow).toBe(false);
  });
  it('close-right closes those right of index', () => {
    const r = run(four(), 'close-right', 1);
    expect(ids(r.state)).toEqual([1, 2]);
    expect(r.closed.map(c => c.tab.id)).toEqual([4, 3]);
  });
  it('close-right on the last tab changes nothing', () => {
    const state = four();
    const r = run(state, 'close-right', 3);
    expect(r.state).toBe(state);
    expect(r.closed).toEqual([]);
  });
  it('reopen brings back the last closed, newest first', () => {
    let r = run(four(), 'close', 0);
    r = run(r.state, 'close', 0, r.closed);
    expect(ids(r.state)).toEqual([3, 4]);
    r = run(r.state, 'reopen', 0, r.closed);
    expect(ids(r.state)).toEqual([2, 3, 4]);
    expect(r.closed.map(c => c.tab.id)).toEqual([1]);
    r = run(r.state, 'reopen', 0, r.closed);
    expect(ids(r.state)).toEqual([1, 2, 3, 4]);
    expect(r.closed).toEqual([]);
  });
  it('reopen with nothing closed changes nothing', () => {
    const state = four();
    expect(run(state, 'reopen')).toEqual({ state, closed: [], closeWindow: false });
  });
  it('duplicate copies the tab at index', () => {
    const r = run(four(), 'duplicate', 2);
    expect(ids(r.state)).toEqual([1, 2, 3, 5, 4]);
    expect(r.state.active).toBe(3);
  });
  it('next and prev cycle, and do nothing with one tab', () => {
    expect(run(four(), 'next').state.active).toBe(2);
    expect(run(four(), 'prev').state.active).toBe(0);
    const one = strip([1], 0);
    expect(run(one, 'next').state).toBe(one);
    expect(run(one, 'prev').state).toBe(one);
  });
  it('left and right move the active tab', () => {
    expect(ids(run(four(), 'right').state)).toEqual([1, 3, 2, 4]);
    expect(ids(run(four(), 'left').state)).toEqual([2, 1, 3, 4]);
    expect(shown(run(four(), 'left').state)).toBe(2);
  });
  it('window closes the window and leaves the tabs', () => {
    const state = four();
    expect(run(state, 'window')).toEqual({ state, closed: [], closeWindow: true });
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9] as const)('select:%i', n => {
    expect(run(four(), `select:${n}`).state.active).toBe(n === 9 ? 3 : Math.min(n - 1, 3));
  });
  it('keeps only the newest 20 closed', () => {
    const old: Closed[] = Array.from({ length: 20 }, (_, i) => ({ tab: tab(100 + i), at: 0 }));
    const r = run(four(), 'close', 0, old);
    expect(r.closed).toHaveLength(20);
    expect(r.closed.at(-1)?.tab.id).toBe(1);
    expect(r.closed[0].tab.id).toBe(101);
  });
  it('keeps the newest 20 when every tab closes', () => {
    const old: Closed[] = Array.from({ length: 19 }, (_, i) => ({ tab: tab(100 + i), at: 0 }));
    const r = run(strip([1, 2, 3], 0), 'close-right', -1, old);
    expect(r.closeWindow).toBe(true);
    expect(r.closed.map(c => c.tab.id)).toEqual([...old.map(c => c.tab.id).slice(2), 1, 2, 3]);
  });
  it('ignores an action it does not know', () => {
    const state = four(), closed: Closed[] = [{ tab: tab(9), at: 0 }];
    const r = applyTabAction(state, closed, 'select:10' as TabAction, 0);
    expect(r.state).toBe(state);
    expect(r.closed).toBe(closed);
    expect(r.closeWindow).toBe(false);
    expect(applyTabAction(state, closed, 'bogus' as TabAction, 0).state).toBe(state);
  });
});
