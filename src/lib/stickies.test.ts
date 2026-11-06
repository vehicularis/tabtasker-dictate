import { describe, expect, it } from 'vitest';
import { firstLine, glance, ordered, shape, tiltOf } from './stickies';
import type { Sticky } from '../api/types';

const sticky = (over: Partial<Sticky>): Sticky => ({
  id: 'a', text: '', hue: 'amber', x: 0, y: 0, width: 100, height: 100, gutter: 0, pinned: false, folded: false, closed: false, archived: false,
  title: '', titled: false, tilt: 'none', weight: 'regular', createdMs: 0, updatedMs: 0, ...over,
});

describe('ordered', () => {
  const list = [sticky({ id: 'closed1', closed: true }), sticky({ id: 'open1' }), sticky({ id: 'arch1', archived: true }), sticky({ id: 'open2' }), sticky({ id: 'closed2', closed: true }), sticky({ id: 'arch2', archived: true, closed: true })];
  const ids = (stickies: Sticky[]) => stickies.map(one => one.id);
  it('puts the open ones first, then the closed, each keeping its order, and leaves out the archive', () => {
    expect(ids(ordered(list, false))).toEqual(['open1', 'open2', 'closed1', 'closed2']);
  });
  it('is only the archive in the archive view', () => {
    expect(ids(ordered(list, true))).toEqual(['arch1', 'arch2']);
  });
  // Today's behaviour; see the report.
  it('falls back to the list when asked for an archive that is empty', () => {
    expect(ids(ordered(list.filter(one => !one.archived), true))).toEqual(['open1', 'open2', 'closed1', 'closed2']);
  });
  it('is empty for none', () => {
    expect(ordered([], false)).toEqual([]);
    expect(ordered([], true)).toEqual([]);
  });
});

describe('glance', () => {
  it('drops heading marks, emphasis and code ticks', () => {
    expect(glance('## Title\n**bold** _it_ `code`')).toBe('Title\nbold it code');
  });
  it('turns list marks and checkboxes into bullets, line by line', () => {
    expect(glance('- one\n* two\n- [ ] three\n- [x] four')).toBe('• one\n• two\n• three\n• four');
  });
  it('trims, and an empty or blank one is empty', () => {
    expect(glance('  hello \n')).toBe('hello');
    expect(glance('')).toBe('');
    expect(glance(' \n ')).toBe('');
  });
});

describe('firstLine', () => {
  it('is the first line that has words, marks dropped', () => {
    expect(firstLine('\n\n## Title\nsecond')).toBe('Title');
    expect(firstLine('- [ ] buy **milk**\nmore')).toBe('buy milk');
    expect(firstLine('  \n* \n- eggs')).toBe('eggs');
  });
  it('is empty when there is nothing', () => {
    expect(firstLine('')).toBe('');
    expect(firstLine('  \n  ')).toBe('');
    expect(firstLine('**')).toBe('');
  });
  // It is not glance: glance keeps every line and writes the bullets, firstLine is one line with the marks dropped.
  it('differs from glance on a list', () => {
    expect(firstLine('- one\n- two')).toBe('one');
    expect(glance('- one\n- two')).toBe('• one\n• two');
    expect(firstLine('#hashtag')).toBe('hashtag');
    expect(glance('#hashtag')).toBe('hashtag');
  });
});

describe('shape', () => {
  it('is the width to height ratio of the paper', () => {
    expect(shape(sticky({ width: 200, height: 200 }))).toBe('1 / 1.000');
    expect(shape(sticky({ width: 200, height: 250 }))).toBe('1 / 1.250');
    expect(shape(sticky({ width: 300, height: 200 }))).toBe('1 / 0.667');
  });
  it('is clamped at 0.6 and 1.4', () => {
    expect(shape(sticky({ width: 1000, height: 100 }))).toBe('1 / 0.600');
    expect(shape(sticky({ width: 100, height: 1000 }))).toBe('1 / 1.400');
    expect(shape(sticky({ width: 100, height: 60 }))).toBe('1 / 0.600');
    expect(shape(sticky({ width: 100, height: 140 }))).toBe('1 / 1.400');
  });
  it('is 1.4 for a paper with no width, and NaN for none at all', () => {
    expect(shape(sticky({ width: 0, height: 100 }))).toBe('1 / 1.400');
    // Today's behaviour; see the report.
    expect(shape(sticky({ width: 0, height: 0 }))).toBe('1 / NaN');
  });
});

describe('tiltOf', () => {
  it('is 0 for none, whatever the id', () => {
    expect(tiltOf('a', 'none')).toBe(0);
    expect(tiltOf('', 'none')).toBe(0);
  });
  it('is stable for the same id', () => {
    expect(tiltOf('sticky-1', 'random')).toBe(tiltOf('sticky-1', 'random'));
    expect(tiltOf('sticky-1', 'slight')).toBe(tiltOf('sticky-1', 'slight'));
  });
  it('leans slight 1.2 degrees one way or the other, by id', () => {
    expect(tiltOf('a', 'slight')).toBe(1.2);
    expect(tiltOf('b', 'slight')).toBe(-1.2);
  });
  it('picks random within 2.4 degrees either way, by id', () => {
    expect(tiltOf('a', 'random')).toBeCloseTo(-1.43, 5);
    expect(tiltOf('abc', 'random')).toBeCloseTo(1.14, 5);
    for (const id of ['', 'x', 'sticky-9', 'é😀', 'a'.repeat(200)]) {
      const degrees = tiltOf(id, 'random');
      expect(degrees).toBeGreaterThanOrEqual(-2.4);
      expect(degrees).toBeLessThan(2.4);
    }
  });
});
