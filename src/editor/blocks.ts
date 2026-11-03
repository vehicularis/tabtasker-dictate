import { Extension, InputRule, type Editor } from '@tiptap/core';
import type { DragHandleRule } from '@tiptap/extension-drag-handle';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

// Blocks, as TabTasker Business's Atlas editor moves and edits them: where a dragged block lands and the
// line that shows it (blockDrop.ts), the handle fitted to the block it hovers (dragHandleOffset.ts),
// the handle's insert and delete (insertBelow.ts, deleteBlock.ts), and "- [ ] " in a bullet
// (taskListMarkdownShortcut.ts). "Turn into" is Dictate's, for the handle's menu.

// ---- the drag handle's rules (RichEditor.tsx) ----

/** Inside a table the block is the table: a cell's paragraph is never a handle's target. */
const tableIsOneBlock: DragHandleRule = {
  id: 'tableIsOneBlock',
  evaluate: ({ $pos, depth }) => {
    for (let d = depth - 1; d >= 1; d--) if ($pos.node(d).type.name === 'table') return 1000;
    return 0;
  },
};
/** Nested blocks (list items, a quote's paragraphs) get their own handle, with no edge detection: the
 *  parent's handle is reached by hovering the parent's own line. One object: the wrapper re-normalises on identity. */
export const NESTED = { rules: [tableIsOneBlock], edgeDetection: 'none' as const };

// ---- where a dragged block lands (blockDrop.ts) ----

interface DropTarget { pos: number; rect: DOMRect; side: 'before' | 'after'; insertPos: number }

/** The deepest block under the pointer whose parent takes the dragged node, split at its vertical
 *  middle: above the middle is before it, below is after. Not ProseMirror's character-position rule,
 *  which put the same drop above or below depending on how far right the hand let go. */
export function blockDropTarget(view: EditorView, coords: { left: number; top: number }, dragged: PMNode): DropTarget | null {
  const found = view.posAtCoords(coords);
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.pos);
  for (let d = $pos.depth; d >= 1; d--) {
    const parent = $pos.node(d - 1), index = $pos.index(d - 1);
    if (d > 1 && !parent.canReplaceWith(index, index, dragged.type)) continue;
    const pos = $pos.before(d);
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    const side = coords.top > (rect.top + rect.bottom) / 2 ? 'after' : 'before';
    return { pos, rect, side, insertPos: side === 'after' ? pos + $pos.node(d).nodeSize : pos };
  }
  return null;
}

const draggedNode = (view: EditorView): NodeSelection | undefined => (view.dragging as { node?: NodeSelection } | null)?.node;

function blockDropCursor(): Plugin {
  let line: HTMLElement | null = null;
  const hide = () => { line?.remove(); line = null; };
  const show = (view: EditorView, target: DropTarget) => {
    const parent = view.dom.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    if (!line) { line = document.createElement('div'); line.className = 'ed-block-drop'; parent.appendChild(line); }
    const p = parent.getBoundingClientRect();
    const y = target.side === 'before' ? target.rect.top : target.rect.bottom;
    Object.assign(line.style, { left: `${target.rect.left - p.left + parent.scrollLeft}px`, width: `${target.rect.width}px`, top: `${y - p.top + parent.scrollTop - 1.5}px` });
  };
  return new Plugin({
    key: new PluginKey('blockDropCursor'),
    view: () => ({ destroy: hide }),
    props: {
      handleDOMEvents: {
        dragover(view, event) {
          const dragged = draggedNode(view);
          const target = dragged && blockDropTarget(view, { left: event.clientX, top: event.clientY }, dragged.node);
          if (target) show(view, target); else hide();
          return false;
        },
        dragleave(view, event) { if (!(event.relatedTarget instanceof Node) || !view.dom.contains(event.relatedTarget)) hide(); return false; },
        dragend() { hide(); return false; },
        drop() { hide(); return false; },
      },
      handleDrop(view, event, _slice, moved) {
        const dragged = draggedNode(view);
        if (!moved || !dragged) return false;
        const target = blockDropTarget(view, { left: event.clientX, top: event.clientY }, dragged.node);
        if (!target) return false;
        event.preventDefault();
        const tr = view.state.tr;
        dragged.replace(tr);
        const pos = tr.mapping.map(target.insertPos);
        tr.replaceRangeWith(pos, pos, dragged.node);
        if (tr.doc.eq(view.state.doc)) return true; // dropped back where it was
        const landed = tr.doc.nodeAt(pos);
        if (landed && landed.sameMarkup(dragged.node)) tr.setSelection(NodeSelection.create(tr.doc, pos));
        view.focus();
        view.dispatch(tr.setMeta('uiEvent', 'drop'));
        return true;
      },
    },
  });
}

export const BlockDrop = Extension.create({ name: 'blockDrop', addProseMirrorPlugins: () => [blockDropCursor()] });

// ---- the handle fitted to its block (dragHandleOffset.ts) ----

/** Height of `.ed-grip`, in px (editor.css). */
const HANDLE_PX = 26;

/** Centres the handle on the block's FIRST line, steps it left of a list's bullet, and makes the anchor
 *  as tall as the block, so the whole gutter beside a long paragraph keeps the handle up. */
export function fitHandle(block: unknown, group: HTMLElement | null): void {
  if (!group || !(block instanceof HTMLElement)) return;
  const lineHeight = parseFloat(getComputedStyle(block).lineHeight);
  group.style.marginTop = `${Number.isFinite(lineHeight) ? Math.max(0, Math.round((lineHeight - HANDLE_PX) / 2)) : 0}px`;
  group.style.marginRight = block.tagName === 'LI' && block.parentElement ? getComputedStyle(block.parentElement).paddingLeft : '';
  if (group.parentElement) group.parentElement.style.height = `${block.getBoundingClientRect().height}px`;
}

// ---- insert below, delete (insertBelow.ts, deleteBlock.ts) ----

/** An empty paragraph right after the top-level block at `pos`, with the caret in it. */
export function insertBlockBelow(editor: Editor, pos: number): void {
  const doc = editor.state.doc;
  const $pos = doc.resolve(pos);
  let after: number;
  if ($pos.depth >= 1) after = $pos.after(1);
  else { const node = doc.nodeAt(pos); after = node ? pos + node.nodeSize : pos; }
  editor.chain().focus().insertContentAt(after, { type: 'paragraph' }).setTextSelection(after + 1).run();
}

function tableRowStart($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d > 0; d -= 1) if ($pos.node(d).type.name === 'tableRow') return $pos.start(d);
  return null;
}

/** Deletes the block the handle points at. In a table that is one row, never the table. */
export function deleteBlock(editor: Editor, pos: number): void {
  const { doc } = editor.state;
  const rowStart = tableRowStart(doc.resolve(pos)) ?? tableRowStart(doc.resolve(Math.min(pos + 1, doc.content.size)));
  if (rowStart !== null) { editor.chain().focus().setTextSelection(rowStart + 2).deleteRow().run(); return; }
  const node = doc.nodeAt(pos);
  if (node) editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
}

// ---- turn into (the handle's menu) ----

export type BlockKind = 'text' | 'h1' | 'h2' | 'h3' | 'bullets' | 'numbers' | 'tasks' | 'quote' | 'code';

const TURNABLE = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'listItem', 'taskItem', 'bulletList', 'orderedList', 'taskList']);
/** A block that holds text can become another kind: a picture, a rule or a table cannot. */
export const canTurn = (node: PMNode | null | undefined) => !!node && TURNABLE.has(node.type.name);

/** The block at `pos` as a `kind`: its text kept, its wrapping (list, quote) taken off first so the
 *  new kind applies to the block itself rather than to whatever holds it. */
export function turnInto(editor: Editor, pos: number, kind: BlockKind): void {
  const { doc } = editor.state;
  const node = doc.nodeAt(pos);
  if (!node) return;
  const selection = TextSelection.between(doc.resolve(pos + 1), doc.resolve(pos + node.nodeSize - 1));
  const chain = editor.chain().focus().command(({ tr }) => { tr.setSelection(selection); return true; }).clearNodes();
  if (kind === 'h1' || kind === 'h2' || kind === 'h3') chain.setNode('heading', { level: Number(kind[1]) });
  else if (kind === 'bullets') chain.toggleBulletList();
  else if (kind === 'numbers') chain.toggleOrderedList();
  else if (kind === 'tasks') chain.toggleTaskList();
  else if (kind === 'quote') chain.toggleBlockquote();
  else if (kind === 'code') chain.setNode('codeBlock');
  // The caret at the end of the block, not its whole text selected (which would raise the selection bar).
  chain.command(({ tr }) => { tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to), -1)); return true; }).run();
}

// ---- "- [ ] " in a bullet (taskListMarkdownShortcut.ts) ----

/** `- ` has already made the line a bullet, so TaskItem's own rule (bare paragraphs only) cannot see
 *  the checkbox typed after it. This one turns that bullet list into a to-do list. */
export const TaskListMarkdownShortcut = Extension.create({
  name: 'taskListMarkdownShortcut',
  addInputRules() {
    return [new InputRule({
      find: /^\s*\[([ x])?\]\s$/,
      handler: ({ state, range, match, chain }) => {
        const { $from } = state.selection;
        let inBulletList = false;
        for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'bulletList') { inBulletList = true; break; }
        if (!inBulletList) return null;
        chain().deleteRange(range).toggleTaskList().updateAttributes('taskItem', { checked: match[1] === 'x' }).run();
        return undefined;
      },
    })];
  },
});
