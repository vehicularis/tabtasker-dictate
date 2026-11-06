import { describe, expect, it } from 'vitest';
import { closeTabs, cycleTabs, duplicateTab, moveTab, openTab, reopenTab, selectTab, type Tabs } from './tabs';

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
