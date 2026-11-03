import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { STICKY_HUES, type StickyHue } from '../store';
import { Icon } from '../ui/Icon';

export const HUES = Object.keys(STICKY_HUES) as StickyHue[];
/// A sticky's first line, as words: for the folded edge.
export const firstLine = (text: string) => text.split('\n').map(line => line.replace(/^#+\s*|^[-*]\s+(\[[ x]\]\s*)?/g, '').replace(/[*_`]/g, '').trim()).find(Boolean) ?? '';
type SheetActions = { fold: () => void; pin: () => void; more: (at: { x: number; y: number }) => void; close: () => void };

/// The sticky itself: one sheet of paper in its colour with the words on it, and nothing else until the pointer
/// is over it. Then its top edge, where it is dragged, shows three tools: keep on top, more (the colours, fold, save
/// as a note: the menu a right-click opens too), and close. Double-click the edge to fold the paper up to it.
/// Sticky.tsx puts it in its own window; the Stickies and Help pages show the very same sheet.
export function Sheet({ hue, folded, pinned, text, actions, children, ...rest }: {
  hue: StickyHue; folded: boolean; pinned: boolean; text: string; actions: SheetActions; children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return <div className="sticky" data-folded={folded || undefined} style={{ '--hue': STICKY_HUES[hue] } as CSSProperties} {...rest}>
    <header className="sticky-bar" data-tauri-drag-region onDoubleClick={actions.fold}>
      {folded && <span className="sticky-peek" data-tauri-drag-region>{firstLine(text) || 'Empty sticky'}</span>}
      <span className="sticky-tools">
        <button type="button" className="sticky-tool" data-on={pinned || undefined} title={pinned ? 'Let other windows cover it' : 'Keep on top of other windows'} aria-label={pinned ? 'Let other windows cover it' : 'Keep on top of other windows'} aria-pressed={pinned} onClick={actions.pin}><Icon name={pinned ? 'pin' : 'pinOff'} size={14} /></button>
        <button type="button" className="sticky-tool sticky-more" title="More" aria-label="More" aria-haspopup="menu" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); actions.more({ x: box.left, y: box.bottom + 4 }); }}><Icon name="dots" size={14} /></button>
        <button type="button" className="sticky-tool" title="Close" aria-label="Close this sticky" onClick={actions.close}><Icon name="close" size={12} /></button>
      </span>
    </header>
    {children}
  </div>;
}
