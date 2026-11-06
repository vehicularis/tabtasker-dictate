// The stickies page's rules: the order, the words, the shape and the lean of each paper.
import type { Sticky, StickyTilt } from '../api/types';

/// The stickies as the page lists them: the archive, or the ones kept (open ones first, then the closed). The
/// archive view of an archive with nothing in it is the list.
export const ordered = (stickies: Sticky[], archived: boolean) =>
  archived && stickies.some(sticky => sticky.archived) ? stickies.filter(sticky => sticky.archived)
    : [...stickies.filter(sticky => !sticky.archived && !sticky.closed), ...stickies.filter(sticky => !sticky.archived && sticky.closed)];
/// A sticky's words as a glance: Markdown marks dropped.
export const glance = (text: string) => text.replace(/^#+\s*/gm, '').replace(/^[-*]\s+(\[[ x]\]\s*)?/gm, '• ').replace(/[*_`]/g, '').trim();
/// A sticky's first line, as words: for the folded band. Not `glance`: that keeps every line and writes bullets.
export const firstLine = (text: string) => text.split('\n').map(line => line.replace(/^#+\s*|^[-*]\s+(\[[ x]\]\s*)?/g, '').replace(/[*_`]/g, '').trim()).find(Boolean) ?? '';
/// Its paper in the shape it has on the screen, within reason.
export const shape = (sticky: Sticky) => `1 / ${Math.min(1.4, Math.max(0.6, sticky.height / sticky.width)).toFixed(3)}`;
/// A sticky's tilt in degrees, from its id, so it is the same every time it opens and on the Stickies page:
/// slight leans a little, one way or the other; random, anywhere within a few degrees.
export const tiltOf = (id: string, tilt: StickyTilt) => {
  if (tilt === 'none') return 0;
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return tilt === 'slight' ? (hash % 2 ? 1.2 : -1.2) : (hash % 480) / 100 - 2.4;
};
