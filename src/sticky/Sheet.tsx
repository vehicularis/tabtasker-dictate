import { useEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { STICKY_HUES, type StickyHue, type StickyTilt, type StickyWeight } from '../store';
import { Icon } from '../ui/Icon';

export const HUES = Object.keys(STICKY_HUES) as StickyHue[];
/// A sticky's first line, as words: for the folded band.
export const firstLine = (text: string) => text.split('\n').map(line => line.replace(/^#+\s*|^[-*]\s+(\[[ x]\]\s*)?/g, '').replace(/[*_`]/g, '').trim()).find(Boolean) ?? '';
/// A sticky's tilt in degrees, from its id, so it is the same every time it opens and on the Stickies page:
/// slight leans a little, one way or the other; random, anywhere within a few degrees.
export const tiltOf = (id: string, tilt: StickyTilt) => {
  if (tilt === 'none') return 0;
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return tilt === 'slight' ? (hash % 2 ? 1.2 : -1.2) : (hash % 480) / 100 - 2.4;
};
export type SheetActions = { fold: () => void; pin: () => void; note: () => void; close: () => void; recolour: (hue: StickyHue) => void; retitle: (title: string) => void; more?: (at: { x: number; y: number }) => void };

/// The sticker, as TabTasker Business's whiteboard sticker is: paper in its hue with the ink from it, corners
/// nearly square, heavier type, and a band across its top where it is dragged. The band holds the title if the
/// sticky has one; while the pointer is over the sticker, a dark pill floats in at the band's right with the
/// swatch (click for the other colours), fold, keep on top, save as a note, more and close. Folded, the sticker
/// is the band alone, its first words on it. A tilt, if it has one, leans the whole sheet.
/// Sticky.tsx puts it in its own window; the Stickies and Help pages show the very same sheet.
export function Sheet({ id, hue, folded, pinned, text, title, titled, tilt, weight, actions, still = false, children, ...rest }: {
  id: string; hue: StickyHue; folded: boolean; pinned: boolean; text: string; title: string; titled: boolean; tilt: StickyTilt; weight: StickyWeight; actions: SheetActions;
  /** No tilt, where the sheet sits in a grid (the Stickies page). */
  still?: boolean; children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'id'>) {
  const [picking, setPicking] = useState(false);
  // A press anywhere but on the colours folds the picker; so does Escape.
  useEffect(() => {
    if (!picking) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest('.sticky-swatch-wrap')) setPicking(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setPicking(false); };
    addEventListener('pointerdown', away, { capture: true }); addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', away, { capture: true }); removeEventListener('keydown', key); };
  }, [picking]);
  const degrees = still ? 0 : tiltOf(id, tilt);
  const tool = (icon: Parameters<typeof Icon>[0]['name'], label: string, run: () => void, extra?: { on?: boolean; disabled?: boolean; size?: number }) =>
    <button type="button" className="sticky-tool" data-on={extra?.on || undefined} title={label} aria-label={label} disabled={extra?.disabled} onClick={run}><Icon name={icon} size={extra?.size ?? 14} /></button>;
  return <div className="sticky" data-folded={folded || undefined} data-weight={weight} data-tilted={degrees ? '' : undefined}
    style={{ '--hue': STICKY_HUES[hue], '--tilt': `${degrees}deg`, '--fit': degrees ? (tilt === 'random' ? .955 : .975) : 1 } as CSSProperties} {...rest}>
    <header className="sticky-band" data-tauri-drag-region onDoubleClick={actions.fold}>
      {folded
        ? <span className="sticky-peek" data-tauri-drag-region>{firstLine(text) || title || 'Empty sticky'}</span>
        : titled && <input className="sticky-title" value={title} placeholder="Title" aria-label="Title" spellCheck={false} maxLength={120} onChange={event => actions.retitle(event.target.value)} onPointerDown={event => event.stopPropagation()} />}
      <span className="sticky-pill" role="toolbar" aria-label="Sticky">
        <span className="sticky-swatch-wrap">
          <button type="button" className="sticky-swatch" aria-label={`Colour: ${hue}. Change it`} aria-expanded={picking} aria-haspopup="dialog" title="Colour" onPointerDown={event => event.stopPropagation()} onClick={() => setPicking(!picking)} />
          {picking && <span className="sticky-picker" role="radiogroup" aria-label="Colour" onPointerDown={event => event.stopPropagation()}>
            {HUES.map(one => <button key={one} type="button" role="radio" aria-checked={one === hue} aria-label={one} title={one} className="sticky-hue" style={{ '--hue': STICKY_HUES[one] } as CSSProperties} onClick={() => { setPicking(false); actions.recolour(one); }} />)}
          </span>}
        </span>
        {tool(folded ? 'chevronDown' : 'chevronUp', folded ? 'Unfold' : 'Fold up', actions.fold)}
        {tool(pinned ? 'pin' : 'pinOff', pinned ? 'Let other windows cover it' : 'Keep on top of other windows', actions.pin, { on: pinned })}
        {tool('note', 'Save as a note', actions.note, { disabled: !text.trim() })}
        {actions.more && <button type="button" className="sticky-tool sticky-more" title="Look and size" aria-label="Look and size" aria-haspopup="menu" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); actions.more!({ x: box.left, y: box.bottom + 6 }); }}><Icon name="dots" size={14} /></button>}
        {tool('close', 'Close', actions.close, { size: 12 })}
      </span>
    </header>
    {children}
  </div>;
}
