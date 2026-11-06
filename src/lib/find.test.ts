import { describe, expect, it } from 'vitest';
import { BOUNDARY, filterSlash, findMatches, posAt, wrap, type FindSegment } from './find';

/// Builds what Find's flatten gives for a document: one entry per paragraph, each a list of text runs.
function flat(paragraphs: string[][]) {
  const parts: string[] = [], segments: FindSegment[] = [];
  let offset = 0, pos = 0;
  for (const runs of paragraphs) {
    parts.push(BOUNDARY); offset += 1; pos += 1;
    for (const run of runs) { segments.push({ offset, pos, len: run.length }); parts.push(run); offset += run.length; pos += run.length; }
    pos += 1;
  }
  return { text: parts.join(''), segments };
}
const find = (paragraphs: string[][], query: string, matchCase = false) => { const { text, segments } = flat(paragraphs); return findMatches(text, query, matchCase, segments); };

describe('findMatches', () => {
  it('finds every match, case-folded by default', () => {
    expect(find([['Foo foo FOO']], 'foo')).toEqual([{ from: 1, to: 4 }, { from: 5, to: 8 }, { from: 9, to: 12 }]);
  });
  it('is exact with matchCase', () => {
    expect(find([['Foo foo']], 'foo', true)).toEqual([{ from: 5, to: 8 }]);
  });
  it('does not overlap: aa in aaa is one match', () => {
    expect(find([['aaa']], 'aa')).toEqual([{ from: 1, to: 3 }]);
  });
  it('finds nothing for an empty query', () => {
    expect(find([['abc']], '')).toEqual([]);
  });
  it('finds nothing for a query holding the boundary, and never crosses a block', () => {
    expect(find([['foo'], ['bar']], 'o\nb')).toEqual([]);
    expect(find([['foo'], ['bar']], 'oob')).toEqual([]);
    expect(find([['foo'], ['foo']], 'foo')).toEqual([{ from: 1, to: 4 }, { from: 6, to: 9 }]);
  });
  it('finds a match across two text segments in one block', () => {
    expect(find([['foo ', 'bar']], 'o b')).toEqual([{ from: 3, to: 6 }]);
  });
  it('counts positions in code units, so an emoji is two', () => {
    expect(find([['😀 x']], '😀')).toEqual([{ from: 1, to: 3 }]);
    expect(find([['😀 x']], 'x')).toEqual([{ from: 4, to: 5 }]);
  });
  it('folds accents by case only', () => {
    expect(find([['Élan']], 'élan')).toEqual([{ from: 1, to: 5 }]);
    expect(find([['Elan']], 'élan')).toEqual([]);
  });
  it('falls back to exact when a fold changes the length (Turkish İ)', () => {
    expect(find([['İstanbul istanbul']], 'istanbul')).toEqual([{ from: 10, to: 18 }]); // Today's behaviour; see the report.
    expect(find([['istanbul']], 'İSTANBUL')).toEqual([]); // Today's behaviour; see the report.
  });
  it('does not match a dotless ı with I', () => {
    expect(find([['ılık']], 'ILIK')).toEqual([]); // Today's behaviour; see the report.
  });
});

describe('posAt', () => {
  const { segments } = flat([['foo ', 'bar']]); // runs at offset 1 (pos 1) and 5 (pos 5)
  it('maps each segment edge', () => {
    expect(posAt(segments, 1)).toBe(1);
    expect(posAt(segments, 4)).toBe(4);
    expect(posAt(segments, 5)).toBe(5);
    expect(posAt(segments, 7)).toBe(7);
  });
  it('maps an offset between two blocks, and past the end, to 0', () => {
    const two = flat([['foo'], ['bar']]).segments; // 1..4, then 5..8 with the boundary at 4
    expect(posAt(two, 4)).toBe(0); // Today's behaviour; see the report.
    expect(posAt(two, 99)).toBe(0);
    expect(posAt(two, 0)).toBe(0);
    expect(posAt(two, 5)).toBe(6);
  });
  it('is 0 with no segments', () => {
    expect(posAt([], 3)).toBe(0);
  });
});

describe('wrap', () => {
  it('wraps both ways', () => {
    expect(wrap(3, 3)).toBe(0);
    expect(wrap(4, 3)).toBe(1);
    expect(wrap(-1, 3)).toBe(2);
    expect(wrap(-4, 3)).toBe(2);
    expect(wrap(1, 3)).toBe(1);
  });
  it('is 0 with nothing to land on', () => {
    expect(wrap(5, 0)).toBe(0);
    expect(wrap(-5, 0)).toBe(0);
  });
});

describe('filterSlash', () => {
  const items = [
    { title: 'Heading 1', keywords: ['h1', 'title'] },
    { title: 'Bulleted list', keywords: ['ul', 'bullet'] },
    { title: 'To-do list', keywords: ['todo', 'Check'] },
  ];
  it('returns everything, as the same array, for an empty or blank query', () => {
    expect(filterSlash(items, '')).toBe(items);
    expect(filterSlash(items, '   ')).toBe(items);
  });
  it('matches the title in any case, and a part of it', () => {
    expect(filterSlash(items, 'HEAD')).toEqual([items[0]]);
    expect(filterSlash(items, 'list').map(i => i.title)).toEqual(['Bulleted list', 'To-do list']);
  });
  it('matches a keyword, trimmed', () => {
    expect(filterSlash(items, ' ul ')).toEqual([items[1]]);
    expect(filterSlash(items, 'title')).toEqual([items[0]]);
  });
  it('compares keywords as written, so a capital in one is never matched', () => {
    expect(filterSlash(items, 'check')).toEqual([]); // Today's behaviour; see the report.
  });
  it('returns nothing when nothing matches', () => {
    expect(filterSlash(items, 'zzz')).toEqual([]);
  });
});
