/// A band of the table along one axis, in pixels.
export interface Band { start: number; end: number }

/// A copy of `items` with the one at `from` moved to `to`, or null when that moves nothing or reaches outside the list.
export const moved = <T,>(items: T[], from: number, to: number): T[] | null => {
  if (from === to || !items[from] || to < 0 || to >= items.length) return null;
  const next = items.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};
/// Which gap the pointer is over: 0 before the first band, `bands.length` after the last.
export const gapAt = (bands: Band[], pointer: number) => { for (let i = 0; i < bands.length; i++) if (pointer < (bands[i].start + bands[i].end) / 2) return i; return bands.length; };
/// The index a band lands on when it leaves `from` for `gap`: past the origin, the gaps close up by one.
export const dropIndex = (from: number, gap: number) => gap > from ? gap - 1 : gap;
