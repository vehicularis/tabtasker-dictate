import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../ui';

// How much wider than its own width the column is, as Business's SidebarRail allows: 0 to 100 points, 10 a key press.
const WIDER = 'dictate.column-wider', MOST = 100, STEP = 10;
const fit = (px: number) => Math.round(Math.max(0, Math.min(MOST, px)));
const savedWidth = () => { try { return fit(Number(localStorage.getItem(WIDER)) || 0); } catch { return 0; } };

/// The column's edge: drag it, or use Left and Right, Home and End, to make the column wider. Escape puts a drag back.
/// The width is this Mac's, kept for next time, and set on the window as --column-extra (styles/column.css).
export function ColumnResizer() {
  const [wider, setWider] = useState(savedWidth);
  const edge = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; from: number; pointer: number } | null>(null);
  const frame = () => edge.current?.closest<HTMLElement>('.window');
  useLayoutEffect(() => { frame()?.style.setProperty('--column-extra', `${wider}px`); }, [wider]);
  const keep = (px: number) => { setWider(fit(px)); try { localStorage.setItem(WIDER, String(fit(px))); } catch { /* kept for this window only */ } };
  const end = () => { drag.current = null; const shell = frame(); if (shell) delete shell.dataset.resizing; };
  const putBack = () => { if (drag.current) setWider(drag.current.from); end(); };
  return <div ref={edge} className="column-resize" role="separator" aria-orientation="vertical" aria-label="Sidebar width" tabIndex={0}
    aria-valuemin={0} aria-valuemax={MOST} aria-valuenow={wider} aria-valuetext={wider ? `${wider} points wider than usual` : 'Usual width'}
    title="Drag to resize the sidebar. Use Left or Right arrow keys."
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, from: wider, pointer: event.pointerId };
      const shell = frame(); if (shell) shell.dataset.resizing = '';
    }}
    onPointerMove={event => { const start = drag.current; if (start?.pointer === event.pointerId) setWider(fit(start.from + event.clientX - start.x)); }}
    onPointerUp={event => {
      const start = drag.current;
      if (start?.pointer !== event.pointerId) return;
      keep(start.from + event.clientX - start.x);
      end();
    }}
    onPointerCancel={putBack} onLostPointerCapture={putBack}
    onKeyDown={event => {
      if (event.key === 'Escape') { putBack(); return; }
      if (drag.current) return;
      const to = ({ ArrowLeft: wider - STEP, ArrowRight: wider + STEP, Home: 0, End: MOST } as Record<string, number>)[event.key];
      if (to === undefined) return;
      event.preventDefault();
      keep(to);
    }} />;
}

/// A column's head, as Business's rail column draws it: the place's name at 18 points and one action
/// flush right (the pencil over Chat; our new note, our record button).
export function ColumnHead({ title, action }: { title: string; action?: ReactNode }) {
  return <header className="column-head"><h2>{title}</h2>{action}</header>;
}

/// A group of rows under an uppercase heading that folds; folded, the heading carries the count. `flip` keys the
/// heading for a list that glides when it changes (motion.ts useFlip).
export function ColumnGroup({ title, children, count, flip }: { title: string; children: ReactNode; count?: number; flip?: string }) {
  const [open, setOpen] = useState(true);
  return <section className="column-group" data-open={open || undefined}>
    <button type="button" className="column-group-head" data-flip={flip} aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name="chevronDown" size={10} />{title}{count !== undefined && <span className="count">{count}</span>}</button>
    {open && children}
  </section>;
}
