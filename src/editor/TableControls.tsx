import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { Icon } from '../ui/Icon';
import { keep, Menu, MenuItem, MenuKeys, MenuLine } from './Menu';

// Business's TableControls.tsx and tableMoves.ts: over the hovered table, a grip left of its row and one
// above its column (click for the line's menu, drag to move the line), and a "+" bar along the bottom
// and the right edge. Painted from outside the document, in the scroller's space; nothing is stored.
// No header row or header column switch and no column widths: a Markdown table has a header row,
// always, and no widths, so neither would survive the file.

type Axis = 'row' | 'col';
interface Band { start: number; end: number }

/// A Markdown table's header is its first row and only that row, whatever the file is read as. So it
/// is kept that way on screen too: a row moved to the top, put above, or left on top by a delete becomes
/// the header, and the old header a plain row, exactly as the file will have them.
export const MarkdownTableHeader = Extension.create({
  name: 'markdownTableHeader',
  addProseMirrorPlugins: () => [new Plugin({
    appendTransaction(transactions, _old, state) {
      const { tableHeader, tableCell } = state.schema.nodes;
      if (!tableHeader || !tableCell || !transactions.some(tr => tr.docChanged)) return null;
      const tr = state.tr;
      state.doc.descendants((node, pos) => {
        if (node.isTextblock) return false;
        if (node.type.name !== 'table') return true;
        node.forEach((row, rowOffset, r) => row.forEach((cell, cellOffset) => {
          const type = r === 0 ? tableHeader : tableCell;
          if (cell.type !== type) tr.setNodeMarkup(pos + 1 + rowOffset + 1 + cellOffset, type, cell.attrs, cell.marks);
        }));
        return false;
      });
      return tr.docChanged ? tr : null;
    },
  })],
});

// ---- moving a row or a column, as node surgery (tableMoves.ts) ----

/** ponytail: plain grids only; a merged cell would need TableMap arithmetic, so the move declines. Markdown has no merged cells anyway. */
const isPlainGrid = (table: PMNode) => {
  let plain = true;
  table.forEach(row => row.forEach(cell => { if ((cell.attrs.colspan ?? 1) !== 1 || (cell.attrs.rowspan ?? 1) !== 1) plain = false; }));
  return plain;
};
const children = (node: PMNode) => { const out: PMNode[] = []; node.forEach(child => out.push(child)); return out; };
const moved = <T,>(items: T[], from: number, to: number): T[] | null => {
  if (from === to || !items[from] || to < 0 || to >= items.length) return null;
  const next = items.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};
function moveRow(table: PMNode, from: number, to: number): PMNode | null {
  if (!isPlainGrid(table)) return null;
  const rows = moved(children(table), from, to);
  return rows && table.copy(Fragment.from(rows));
}
function moveColumn(table: PMNode, from: number, to: number): PMNode | null {
  if (!isPlainGrid(table)) return null;
  const rows: PMNode[] = [];
  for (const row of children(table)) {
    const cells = moved(children(row), from, to);
    if (!cells) return null;
    rows.push(row.copy(Fragment.from(cells)));
  }
  return table.copy(Fragment.from(rows));
}
/** Which gap the pointer is over: 0 before the first band, `bands.length` after the last. */
const gapAt = (bands: Band[], pointer: number) => { for (let i = 0; i < bands.length; i++) if (pointer < (bands[i].start + bands[i].end) / 2) return i; return bands.length; };
/** The index a band lands on when it leaves `from` for `gap`: past the origin, the gaps close up by one. */
const dropIndex = (from: number, gap: number) => gap > from ? gap - 1 : gap;

// ---- the controls ----

function locate(editor: Editor, cell: HTMLElement) {
  try {
    const $pos = editor.state.doc.resolve(editor.view.posAtDOM(cell, 0));
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name !== 'table') continue;
      const table = $pos.node(d), tablePos = $pos.before(d);
      const rect = TableMap.get(table).findCell($pos.before(d + 2) - (tablePos + 1));
      return { table, tablePos, row: rect.top, col: rect.left };
    }
  } catch { /* a node ProseMirror is rebuilding: no controls this frame */ }
  return null;
}
const inWrap = (el: Element, wrap: HTMLElement) => {
  const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  return { left: r.left - w.left + wrap.scrollLeft, top: r.top - w.top + wrap.scrollTop, width: r.width, height: r.height };
};
const bandsOf = (table: HTMLTableElement, axis: Axis): Band[] => (axis === 'row' ? [...table.rows] : [...(table.rows[0]?.cells ?? [])]).map(el => {
  const b = el.getBoundingClientRect();
  return axis === 'row' ? { start: b.top, end: b.bottom } : { start: b.left, end: b.right };
});
/** Grips sit just outside the table; a pointer on its way to one is still on the table. */
const NEAR_PX = 40;
type Command = 'addRowBefore' | 'addRowAfter' | 'deleteRow' | 'addColumnBefore' | 'addColumnAfter' | 'deleteColumn' | 'deleteTable';

export function TableControls({ editor, wrap: wrapRef }: { editor: Editor; wrap: RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = useState<{ table: HTMLTableElement; cell: HTMLTableCellElement } | null>(null);
  const [menu, setMenu] = useState<{ axis: Axis; anchor: HTMLElement } | null>(null);
  const [drag, setDrag] = useState<{ axis: Axis; gap: number } | null>(null);
  const [, setTick] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(hover); hoverRef.current = hover;
  const busy = useRef(false); busy.current = menu !== null || drag !== null;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onMove = (event: MouseEvent) => {
      if (busy.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (root.current?.contains(target)) return;
      const cell = target?.closest('.ed-body td, .ed-body th'), table = cell?.closest('table');
      if (cell instanceof HTMLTableCellElement && table instanceof HTMLTableElement) { setHover(h => h?.cell === cell ? h : { table, cell }); return; }
      const now = hoverRef.current;
      if (!now) return;
      const b = now.table.getBoundingClientRect();
      if (!(event.clientX > b.left - NEAR_PX && event.clientX < b.right + NEAR_PX && event.clientY > b.top - NEAR_PX && event.clientY < b.bottom + NEAR_PX)) setHover(null);
    };
    const onLeave = () => { if (!busy.current) setHover(null); };
    wrap.addEventListener('mousemove', onMove);
    wrap.addEventListener('mouseleave', onLeave);
    return () => { wrap.removeEventListener('mousemove', onMove); wrap.removeEventListener('mouseleave', onLeave); };
  }, [wrapRef]);

  // Rows shift under the grips on every edit: measured again, and a cell that is gone is let go.
  useEffect(() => {
    const bump = () => {
      const h = hoverRef.current;
      if (h && !h.cell.isConnected) { setHover(null); setMenu(null); return; }
      setTick(t => t + 1);
    };
    editor.on('transaction', bump);
    return () => { editor.off('transaction', bump); };
  }, [editor]);

  const wrap = wrapRef.current;
  if (!hover || !wrap || !hover.cell.isConnected) return null;
  const loc = locate(editor, hover.cell);
  if (!loc) return null;
  const table = inWrap(hover.table, wrap), row = inWrap(hover.cell.parentElement as HTMLElement, wrap), cell = inWrap(hover.cell, wrap);
  const map = TableMap.get(loc.table), start = loc.tablePos + 1;
  const run = (command: Command) => { setMenu(null); editor.chain().focus()[command]().run(); };

  /** The whole row or column selected, so the menu acts on the line and the person sees which one. */
  const selectLine = (axis: Axis) => {
    const rect = axis === 'row' ? { left: 0, right: map.width, top: loc.row, bottom: loc.row + 1 } : { left: loc.col, right: loc.col + 1, top: 0, bottom: map.height };
    const cells = map.cellsInRect(rect);
    const { doc, tr } = editor.state;
    editor.view.dispatch(tr.setSelection(new CellSelection(doc.resolve(start + cells[0]), doc.resolve(start + cells[cells.length - 1]))));
  };
  /** The "+" bars: a row under the last row, a column after the last column. */
  const addLine = (axis: Axis) => {
    const rect = axis === 'row' ? { left: 0, right: 1, top: map.height - 1, bottom: map.height } : { left: map.width - 1, right: map.width, top: 0, bottom: 1 };
    const [cellPos] = map.cellsInRect(rect);
    const chain = editor.chain().focus().setTextSelection(start + cellPos + 2);
    (axis === 'row' ? chain.addRowAfter() : chain.addColumnAfter()).run();
  };
  /** A still press and release selects the line and opens its menu; a press that travels drags it. */
  const startGrip = (axis: Axis) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY }, button = event.currentTarget, tableEl = hover.table, from = axis === 'row' ? loc.row : loc.col;
    const along = (e: PointerEvent) => axis === 'row' ? e.clientY : e.clientX;
    let travelled = false;
    const onMove = (e: PointerEvent) => {
      if (!travelled && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 4) return;
      travelled = true;
      setDrag({ axis, gap: gapAt(bandsOf(tableEl, axis), along(e)) });
    };
    const onUp = (e: PointerEvent) => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      if (!travelled) { selectLine(axis); setMenu({ axis, anchor: button }); return; }
      setDrag(null);
      const to = dropIndex(from, gapAt(bandsOf(tableEl, axis), along(e)));
      const now = locate(editor, hover.cell); // the document may have changed under a long drag
      if (!now) return;
      const next = axis === 'row' ? moveRow(now.table, from, to) : moveColumn(now.table, from, to);
      if (next) editor.view.dispatch(editor.state.tr.replaceWith(now.tablePos, now.tablePos + now.table.nodeSize, next));
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  };

  const grip = (axis: Axis) => <button type="button" className={`ed-table-grip ed-${axis}`} aria-haspopup="menu" aria-expanded={menu?.axis === axis}
    style={axis === 'row' ? { left: table.left - 5, top: row.top + row.height / 2 - 12 } : { left: cell.left + cell.width / 2 - 12, top: table.top - 5 }}
    aria-label={axis === 'row' ? 'Row options' : 'Column options'} title="Click for options, or drag to move" onPointerDown={startGrip(axis)}>
    <Icon name={axis === 'row' ? 'grip' : 'gripRow'} size={14} />
  </button>;

  let drop: ReactNode = null;
  if (drag) {
    const bands = bandsOf(hover.table, drag.axis);
    const edge = drag.gap < bands.length ? bands[drag.gap].start : bands[bands.length - 1].end;
    const w = wrap.getBoundingClientRect();
    drop = drag.axis === 'row'
      ? <div className="ed-table-drop ed-row" style={{ left: table.left, width: table.width, top: edge - w.top + wrap.scrollTop - 1 }} />
      : <div className="ed-table-drop ed-col" style={{ top: table.top, height: table.height, left: edge - w.left + wrap.scrollLeft - 1 }} />;
  }

  return <div ref={root} className="ed-table-controls">
    {grip('row')}
    {grip('col')}
    <button type="button" className="ed-table-add ed-row" style={{ left: table.left, top: table.top + table.height + 4, width: table.width }} aria-label="Add a row" title="Add a row" onMouseDown={keep} onClick={() => addLine('row')}>
      <Icon name="plus" size={12} />
    </button>
    <button type="button" className="ed-table-add ed-col" style={{ left: table.left + table.width + 4, top: table.top, height: table.height }} aria-label="Add a column" title="Add a column" onMouseDown={keep} onClick={() => addLine('col')}>
      <Icon name="plus" size={12} />
    </button>
    {drop}
    {menu && <Menu anchor={menu.anchor} label={menu.axis === 'row' ? 'Row' : 'Column'} onClose={() => setMenu(null)}>
      {menu.axis === 'row' ? <>
        <MenuItem onSelect={() => run('addRowBefore')}>Insert row above</MenuItem>
        <MenuItem onSelect={() => run('addRowAfter')}>Insert row below</MenuItem>
        <MenuLine />
        <MenuItem danger onSelect={() => run('deleteRow')}>Delete row</MenuItem>
      </> : <>
        <MenuItem onSelect={() => run('addColumnBefore')}>Insert column left</MenuItem>
        <MenuItem onSelect={() => run('addColumnAfter')}>Insert column right</MenuItem>
        <MenuLine />
        <MenuItem danger onSelect={() => run('deleteColumn')}>Delete column</MenuItem>
      </>}
      <MenuItem danger onSelect={() => run('deleteTable')}>Delete table</MenuItem>
      <MenuKeys />
    </Menu>}
  </div>;
}
