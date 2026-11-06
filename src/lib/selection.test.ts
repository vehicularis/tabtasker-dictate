import { describe, expect, it } from 'vitest';
import { nextPicked } from './selection';

const order = ['a', 'b', 'c', 'd', 'e'];
const picked = (ids: string[], anchor: string | null) => ({ ids: new Set(ids), anchor });
const of = (state: ReturnType<typeof picked>) => ({ ids: [...state.ids].sort(), anchor: state.anchor });

describe('nextPicked', () => {
  it('a plain click picks nothing and moves the anchor', () => {
    expect(of(nextPicked(picked(['a', 'b'], 'a'), order, 'c', false, false))).toEqual({ ids: [], anchor: 'c' });
  });
  it('⌘ adds one, and takes it away again', () => {
    const on = nextPicked(picked([], null), order, 'b', true, false);
    expect(of(on)).toEqual({ ids: ['b'], anchor: 'b' });
    const more = nextPicked(on, order, 'd', true, false);
    expect(of(more)).toEqual({ ids: ['b', 'd'], anchor: 'd' });
    expect(of(nextPicked(more, order, 'b', true, false))).toEqual({ ids: ['d'], anchor: 'b' });
  });
  it('⇧ adds the range forwards from the anchor', () => {
    expect(of(nextPicked(picked(['b'], 'b'), order, 'd', false, true))).toEqual({ ids: ['b', 'c', 'd'], anchor: 'b' });
  });
  it('⇧ adds the range backwards from the anchor', () => {
    expect(of(nextPicked(picked(['d'], 'd'), order, 'b', false, true))).toEqual({ ids: ['b', 'c', 'd'], anchor: 'd' });
  });
  it('⇧ keeps what was already picked', () => {
    expect(of(nextPicked(picked(['a', 'c'], 'c'), order, 'e', false, true))).toEqual({ ids: ['a', 'c', 'd', 'e'], anchor: 'c' });
  });
  it('⇧ on the anchor itself adds just it', () => {
    expect(of(nextPicked(picked([], 'c'), order, 'c', false, true))).toEqual({ ids: ['c'], anchor: 'c' });
  });
  it('⇧ with no anchor acts like ⌘: it toggles the one clicked', () => {
    expect(of(nextPicked(picked([], null), order, 'c', false, true))).toEqual({ ids: ['c'], anchor: 'c' });
    expect(of(nextPicked(picked(['c'], null), order, 'c', false, true))).toEqual({ ids: [], anchor: 'c' });
  });
  it('⇧ with an anchor that left the list also toggles', () => {
    expect(of(nextPicked(picked([], 'gone'), order, 'c', false, true))).toEqual({ ids: ['c'], anchor: 'c' });
  });
  it('⌘⇧ together makes the range, as ⇧ does', () => {
    expect(of(nextPicked(picked(['a'], 'a'), order, 'c', true, true))).toEqual({ ids: ['a', 'b', 'c'], anchor: 'a' });
  });
  it('does not change the state it was given', () => {
    const before = picked(['a'], 'a');
    nextPicked(before, order, 'c', false, true);
    expect(of(before)).toEqual({ ids: ['a'], anchor: 'a' });
  });
});
