import { describe, expect, it } from 'vitest';
import { dropIndex, gapAt, moved } from './reorder';

describe('moved', () => {
  it('moves an item forward and back', () => {
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'c', 'b']);
  });
  it('leaves the input alone', () => {
    const items = ['a', 'b', 'c'];
    moved(items, 0, 2);
    expect(items).toEqual(['a', 'b', 'c']);
  });
  it('declines a move to the same place', () => {
    expect(moved(['a', 'b'], 1, 1)).toBeNull();
  });
  it('declines a move out of range, at both ends', () => {
    expect(moved(['a', 'b', 'c'], 0, 3)).toBeNull();
    expect(moved(['a', 'b', 'c'], 0, -1)).toBeNull();
    expect(moved(['a', 'b', 'c'], 3, 0)).toBeNull();
    expect(moved(['a', 'b', 'c'], -1, 0)).toBeNull();
    expect(moved([], 0, 0)).toBeNull();
  });
  it('declines to move a falsy item', () => {
    expect(moved([0, 1, 2], 0, 2)).toBeNull(); // Today's behaviour; see the report. Rows and cells are never falsy.
  });
});

describe('gapAt', () => {
  const bands = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }]; // midpoints 5, 15, 25
  it('is 0 above the first band, and before its middle', () => {
    expect(gapAt(bands, -50)).toBe(0);
    expect(gapAt(bands, 4)).toBe(0);
  });
  it('picks the nearer gap between bands, switching at a middle', () => {
    expect(gapAt(bands, 5)).toBe(1);
    expect(gapAt(bands, 14)).toBe(1);
    expect(gapAt(bands, 15)).toBe(2);
    expect(gapAt(bands, 24)).toBe(2);
  });
  it('is the band count below the last middle', () => {
    expect(gapAt(bands, 25)).toBe(3);
    expect(gapAt(bands, 1000)).toBe(3);
  });
  it('is 0 with no bands', () => {
    expect(gapAt([], 10)).toBe(0);
  });
});

describe('dropIndex', () => {
  it('is the gap itself above or at the origin', () => {
    expect(dropIndex(2, 0)).toBe(0);
    expect(dropIndex(2, 2)).toBe(2);
  });
  it('closes up by one past the origin', () => {
    expect(dropIndex(2, 3)).toBe(2); // the gap just below it: nowhere
    expect(dropIndex(2, 5)).toBe(4);
    expect(dropIndex(0, 1)).toBe(0);
  });
});
