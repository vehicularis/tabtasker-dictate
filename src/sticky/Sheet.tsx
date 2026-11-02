import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { STICKY_HUES, type StickyHue } from '../store';
import { Icon } from '../ui/Icon';

export const HUES = Object.keys(STICKY_HUES) as StickyHue[];
/// A sticky's first line, as words: for the folded bar.
export const firstLine = (text: string) => text.split('\n').map(line => line.replace(/^#+\s*|^[-*]\s+(\[[ x]\]\s*)?/g, '').replace(/[*_`]/g, '').trim()).find(Boolean) ?? '';
export type SheetActions = { recolour: (hue: StickyHue) => void; fold: () => void; pin: () => void; note: () => void; close: () => void };

/// The sticker itself, as TabTasker Business draws one (boardColor.ts hueSurface): paper in the hue, ink
/// from the hue, a thin bar in a deeper tint to drag it by. The bar holds one swatch (its colour; click
/// for the others), then fold, pin, make a note, close; the words go in `children`. Sticky.tsx puts it in
/// its own window; the Help page shows the very same sheet on its Mac.
export function Sheet({ hue, folded, pinned, text, picking, onPicking, actions, children, ...rest }: {
  hue: StickyHue; folded: boolean; pinned: boolean; text: string; picking: boolean; onPicking: (on: boolean) => void; actions: SheetActions; children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return <div className="sticky" data-folded={folded || undefined} style={{ '--hue': STICKY_HUES[hue] } as CSSProperties} {...rest}>
    <header className="sticky-bar" data-tauri-drag-region onDoubleClick={actions.fold}>
      {picking
        ? <span className="sticky-palette" role="radiogroup" aria-label="Colour" onPointerDown={event => event.stopPropagation()}>
          {HUES.map(one => <button key={one} type="button" role="radio" aria-checked={one === hue} aria-label={one} className="sticky-hue" style={{ '--hue': STICKY_HUES[one] } as CSSProperties} onClick={() => actions.recolour(one)} />)}
        </span>
        : <button type="button" className="sticky-swatch" aria-label={`Colour: ${hue}. Change it`} aria-expanded={picking} title="Colour" onPointerDown={event => event.stopPropagation()} onClick={() => onPicking(true)} />}
      {folded && !picking && <span className="sticky-peek" data-tauri-drag-region>{firstLine(text) || 'Empty sticky'}</span>}
      <span className="sticky-tools">
        <button type="button" className="sticky-tool" title={folded ? 'Open it up' : 'Fold to its bar'} aria-label={folded ? 'Open the sticky up' : 'Fold the sticky to its bar'} onClick={actions.fold}><Icon name={folded ? 'chevronDown' : 'chevronUp'} size={14} /></button>
        <button type="button" className="sticky-tool" data-on={pinned || undefined} title={pinned ? 'On top of everything. Click to let other windows cover it' : 'Behind other windows. Click to keep it on top'} aria-label={pinned ? 'Let other windows cover it' : 'Keep on top of everything'} aria-pressed={pinned} onClick={actions.pin}><Icon name={pinned ? 'pin' : 'pinOff'} size={14} /></button>
        <button type="button" className="sticky-tool" title="Save as a note" aria-label="Save as a note" disabled={!text.trim()} onClick={actions.note}><Icon name="note" size={14} /></button>
        <button type="button" className="sticky-tool" title="Close" aria-label="Close this sticky" onClick={actions.close}><Icon name="close" size={12} /></button>
      </span>
    </header>
    {children}
  </div>;
}
