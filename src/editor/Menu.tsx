import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { leave } from '../ui/motion';

// Business's popover geometry (popover.tsx): a 6 px gap to the anchor, plus the tray ring drawn round the plate.
const GAP = 6, TRAY = 6;

type Anchor = HTMLElement | (() => DOMRect | null);

/// A menu or popover in Business's inverted tray (richEditor's dropdowns, the "More" popover, the "/"
/// list): under its anchor, or over it when there is no room below, kept on screen, closed by Escape or
/// by a press anywhere else. A press inside never takes the caret out of the text (`keep`), so the
/// command a row runs acts on the selection the person made. Opened from the keyboard (`focus`), it
/// takes the keyboard: arrows walk the rows, `cols` across when it is a grid.
export function Menu({ anchor, onClose, label, children, className = '', focus = false, cols = 1, keep = true, plain = false, role = 'menu', minWidth }: {
  anchor: Anchor; onClose: () => void; label: string; children: ReactNode; className?: string; focus?: boolean; cols?: number; keep?: boolean;
  /** The bubble's own surface instead of the inverted tray: for a field, not a menu. */
  plain?: boolean;
  /** 'listbox' for a Select's choices. */
  role?: 'menu' | 'listbox';
  /** At least as wide as the field that opened it. */
  minWidth?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const place = () => {
    const el = box.current, r = typeof anchor === 'function' ? anchor() : anchor.getBoundingClientRect();
    if (!el || !r) return;
    const width = el.offsetWidth, height = el.offsetHeight, gap = GAP + TRAY, edge = 8 + TRAY;
    const below = r.bottom + gap, above = r.top - gap - height;
    const top = below + height <= innerHeight - edge || above < edge ? below : above;
    const next = { left: Math.round(Math.max(edge, Math.min(r.left, innerWidth - edge - width))), top: Math.round(Math.max(edge, top)) };
    // It grows out of its anchor, as Radix's popovers do: the anchor's middle, on the side the anchor is.
    el.style.transformOrigin = `${Math.round(Math.max(0, Math.min(width, r.left + r.width / 2 - next.left)))}px ${top === below ? 0 : height}px`;
    setAt(now => now && now.left === next.left && now.top === next.top ? now : next);
  };
  // And it fades out where it was when it closes, rather than vanishing (motion.ts).
  const hold = useCallback((el: HTMLDivElement | null) => { box.current = el; return leave(el); }, []);
  const placeRef = useRef(place); placeRef.current = place;
  useLayoutEffect(() => {
    placeRef.current();
    if (focus) box.current?.querySelector<HTMLElement>('button:not(:disabled), input')?.focus();
    // Its rows can change while it is open (the toolbar folding more into it): it is placed again.
    const size = new ResizeObserver(() => placeRef.current());
    if (box.current) size.observe(box.current);
    return () => size.disconnect();
  }, [focus]);
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || (anchor instanceof HTMLElement && anchor.contains(target))) return;
      closeRef.current();
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); } };
    const move = () => placeRef.current();
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', escape, true);
    addEventListener('resize', move);
    document.addEventListener('scroll', move, true);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', escape, true);
      removeEventListener('resize', move);
      document.removeEventListener('scroll', move, true);
    };
  }, [anchor]);
  const walk = (event: KeyboardEvent) => {
    const step = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: cols > 1 ? 1 : 0, ArrowLeft: cols > 1 ? -1 : 0 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    if (!rows.length) return;
    event.preventDefault();
    const now = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : now < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, now + (step ?? 0)));
    rows[next].focus();
  };
  return createPortal(<div ref={hold} className={`${plain ? 'ed-float' : 'ed-menu'} ${className}`} role={plain ? 'dialog' : role} aria-label={label}
    style={{ ...(at ?? { left: -9999, top: -9999 }), '--anchor-width': minWidth && `${minWidth}px` } as CSSProperties} onMouseDown={keep ? event => { if (!(event.target as HTMLElement).closest('input')) event.preventDefault(); } : undefined} onKeyDown={walk}>
    {children}
  </div>, document.body);
}

/// One row. `danger` for what removes something.
export function MenuItem({ children, onSelect, danger = false, disabled = false }: { children: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }) {
  return <button type="button" role="menuitem" className={`ed-menu-item${danger ? ' danger' : ''}`} disabled={disabled} onClick={onSelect}>{children}</button>;
}

export const MenuLine = () => <div className="ed-menu-line" role="separator" />;

/// The keys a menu answers to, as Business's MenuKeyboardHints prints them under every menu.
export function MenuKeys({ grid = false }: { grid?: boolean }) {
  return <div className="ed-keys" aria-hidden="true">
    <span><span className="ed-kbds">{grid && <><kbd>←</kbd><kbd>→</kbd></>}<kbd>↑</kbd><kbd>↓</kbd></span>Move</span>
    <span><kbd>↵</kbd>Select</span>
    <span><kbd>Esc</kbd>Close</span>
  </div>;
}

/// A press on a bar or menu must not take the selection out of the text.
export const keep = (event: { preventDefault: () => void }) => event.preventDefault();
