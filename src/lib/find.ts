// The text half of Find and the slash menu's filter: plain strings and numbers, no editor. Find.tsx walks
// the document into `text` and `segments`; what is here finds in them.
import { fold } from './text';

export interface FindMatch { from: number; to: number }
/// A run of text in the flattened string: where it starts there, where it sits in the document, and how long it is.
export interface FindSegment { offset: number; pos: number; len: number }
/// Stitched in at every boundary a match must not cross.
export const BOUNDARY = '\n';

/// The document position of a string offset; 0 for one that is not inside a text run (a boundary, or past the end).
export function posAt(segments: FindSegment[], offset: number): number {
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, seg = segments[mid];
    if (offset < seg.offset) hi = mid - 1; else if (offset >= seg.offset + seg.len) lo = mid + 1; else return seg.pos + (offset - seg.offset);
  }
  return 0;
}
/// Literal matches of `query` in `text`, left to right without overlaps, case-folded unless `matchCase`.
export function findMatches(text: string, query: string, matchCase: boolean, segments: FindSegment[]): FindMatch[] {
  if (!query || query.includes(BOUNDARY)) return [];
  let hay = text, needle = query;
  // The fold keeps every length (text.test.ts checks every character), so its offsets are the text's. Were a new case
  // mapping ever to change one, every position after it would shift and Replace would hit the wrong text: then the
  // search is case-sensitive instead, which finds fewer, never the wrong text.
  if (!matchCase && fold(text).length === text.length && fold(query).length === query.length) { hay = fold(text); needle = fold(query); }
  const out: FindMatch[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push({ from: posAt(segments, i), to: posAt(segments, i + needle.length - 1) + 1 });
  return out;
}
/// `index` kept inside 0..length-1, both ways round; 0 when there is nothing to land on.
export const wrap = (index: number, length: number) => length ? ((index % length) + length) % length : 0;

/// A match on the title or a keyword, folded on both sides. An empty query is everything.
export const filterSlash = <T extends { title: string; keywords: string[] }>(items: T[], query: string): T[] => {
  const q = fold(query.trim());
  return q ? items.filter(item => fold(item.title).includes(q) || item.keywords.some(word => fold(word).includes(q))) : items;
};
