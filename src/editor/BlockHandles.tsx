import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { Icon, type IconName } from '../ui/Icon';
import { canTurn, deleteBlock, fitHandle, insertBlockBelow, NESTED, turnInto, type BlockKind } from './blocks';
import { keep, Menu, MenuItem, MenuKeys, MenuLine } from './Menu';

// Atlas's gutters (richEditor.css): 80 px on the left for "+" and the grip, 48 on the right for the bin.
const LEFT = 80, RIGHT = 48;
// The left gutter needs this much to hold both; narrower, the grip stays and "+" lives in its menu.
const BOTH = 62;
const RIGHT_START = { placement: 'right-start' as const };
const KINDS: { kind: BlockKind; label: string; icon: IconName }[] = [
  { kind: 'text', label: 'Text', icon: 'text' },
  { kind: 'h1', label: 'Heading 1', icon: 'h1' }, { kind: 'h2', label: 'Heading 2', icon: 'h2' }, { kind: 'h3', label: 'Heading 3', icon: 'h3' },
  { kind: 'bullets', label: 'Bulleted list', icon: 'bullets' }, { kind: 'numbers', label: 'Numbered list', icon: 'numbers' }, { kind: 'tasks', label: 'To-do list', icon: 'tasks' },
  { kind: 'quote', label: 'Quote', icon: 'quote' }, { kind: 'code', label: 'Code block', icon: 'codeBlock' },
];

/// The Atlas block handle (RichEditor.tsx): beside every block, in the gutter left of the text, a "+"
/// that opens a fresh line under it and the grip that drags it; right of the text, a bin. A click on
/// the grip opens the block's menu: turn it into another kind, put a line under it, delete it.
/// `wrap` is the scroller the gutters are cut into and the handles are positioned in.
export function BlockHandles({ editor, wrap }: { editor: Editor; wrap: RefObject<HTMLDivElement | null> }) {
  const group = useRef<HTMLSpanElement>(null), grip = useRef<HTMLSpanElement>(null), bin = useRef<HTMLSpanElement>(null);
  const hovered = useRef(-1), binPos = useRef(0);
  const [menu, setMenu] = useState<{ pos: number; keyboard: boolean } | null>(null);
  const menuOpen = useRef(false); menuOpen.current = menu !== null;
  const locked = useRef(false);
  const lock = (on: boolean) => {
    if (locked.current === on || editor.isDestroyed) return;
    locked.current = on;
    editor.view.dispatch(editor.state.tr.setMeta('lockDragHandle', on));
  };

  // The gutters: as wide as Atlas's, or as wide as the room beside the text column, so they never push
  // past the pane and give it a sideways scrollbar. (An effect, not a layout effect: the scroller's ref,
  // on an element above this one, is only attached once the commit is through.)
  useEffect(() => {
    const el = wrap.current, column = el?.parentElement;
    if (!el || !column) return;
    let clip = column.parentElement;
    while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
    const fit = () => {
      const c = column.getBoundingClientRect(), box = clip?.getBoundingClientRect();
      const left = box ? c.left - box.left - (clip?.clientLeft ?? 0) : c.left;
      const right = box && clip ? box.left + clip.clientLeft + clip.clientWidth - c.right : innerWidth - c.right;
      const l = Math.max(0, Math.min(LEFT, Math.floor(left))), r = Math.max(0, Math.min(RIGHT, Math.floor(right)));
      el.style.setProperty('--gutter-l', `${l}px`);
      el.style.setProperty('--gutter-r', `${r}px`);
      el.toggleAttribute('data-narrow', l < BOTH);
      el.toggleAttribute('data-no-bin', r < 30);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(column);
    if (clip) observer.observe(clip);
    return () => observer.disconnect();
  }, [wrap]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // The gutters are the scroller's, outside ProseMirror: their movement is handed to the handle
    // plugins so the handle follows the block level with the pointer.
    const gutter = (event: MouseEvent) => { if (event.target === el) editor.view.dispatchEvent(event); };
    // Reaching left for a nested item's handle crosses the strip its bullet is drawn in, which belongs to
    // the parent item. While the pointer is level with the hovered block and outside it, the handle is
    // held; on a handle, or inside the block, it is free again.
    const reach = (event: MouseEvent) => {
      if (menuOpen.current) return;
      const dom = hovered.current >= 0 ? editor.view.nodeDOM(hovered.current) : null;
      const onHandle = event.target instanceof Element && event.target.closest('.ed-handle-anchor, .ed-bin-anchor');
      if (onHandle || !(dom instanceof HTMLElement)) { lock(false); return; }
      const r = dom.getBoundingClientRect(), slack = 12, { clientX: x, clientY: y } = event;
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      lock(!inside && y >= r.top - slack && y <= r.bottom + slack);
    };
    const leave = () => { if (menuOpen.current || editor.isDestroyed) return; locked.current = false; editor.view.dispatch(editor.state.tr.setMeta('hideDragHandle', true)); };
    el.addEventListener('mousemove', reach, true);
    el.addEventListener('mousemove', gutter);
    el.addEventListener('mouseleave', leave);
    return () => { el.removeEventListener('mousemove', reach, true); el.removeEventListener('mousemove', gutter); el.removeEventListener('mouseleave', leave); };
  }, [editor, wrap]);

  const close = () => {
    setMenu(null);
    if (editor.isDestroyed) return;
    locked.current = false;
    editor.view.dispatch(editor.state.tr.setMeta('lockDragHandle', false).setMeta('hideDragHandle', true));
  };
  const open = (keyboard: boolean) => {
    if (hovered.current < 0) return;
    lock(true);
    setMenu({ pos: hovered.current, keyboard });
  };
  const then = (run: () => void) => () => { close(); run(); };
  const node = menu ? editor.state.doc.nodeAt(menu.pos) : null;
  return <>
    <DragHandle editor={editor} nested={NESTED} className="ed-handle-anchor"
      onNodeChange={({ node, pos }) => { if (node) fitHandle(editor.view.nodeDOM(pos), group.current); hovered.current = node ? pos : -1; }}>
      <span ref={group} className="ed-handle-group">
        <button type="button" className="ed-add" aria-label="Insert a block below" title="Insert a block below" onMouseDown={keep} onClick={() => insertBlockBelow(editor, hovered.current)}>
          <Icon name="plus" size={17} />
        </button>
        <span ref={grip} className="ed-grip" role="button" tabIndex={-1} aria-label="Drag to move, or click for options" title="Drag to move, or click for options" aria-haspopup="menu" aria-expanded={!!menu}
          onMouseDown={event => event.stopPropagation()} onClick={event => (menu ? close() : open(event.detail === 0))}>
          <Icon name="grip" size={19} />
        </span>
      </span>
    </DragHandle>
    <DragHandle editor={editor} pluginKey="deleteBlockHandle" nested={NESTED} className="ed-bin-anchor" computePositionConfig={RIGHT_START}
      onNodeChange={({ node, pos }) => {
        if (node) fitHandle(editor.view.nodeDOM(pos), bin.current);
        // Clear of the table's own add-column bar, which sits where this would.
        if (node && bin.current) bin.current.style.marginLeft = node.type.name === 'table' ? '20px' : '';
        if (pos >= 0) binPos.current = pos;
      }}>
      <span ref={bin} className="ed-bin-group">
        <button type="button" className="ed-bin" aria-label="Delete this block" title="Delete this block" onMouseDown={keep} onClick={() => deleteBlock(editor, binPos.current)}>
          <Icon name="trash" size={16} />
        </button>
      </span>
    </DragHandle>
    {menu && grip.current && <Menu anchor={grip.current} label="Block" className="ed-block-menu" focus={menu.keyboard} onClose={close}>
      {canTurn(node) && <>
        <div className="ed-menu-label">Turn into</div>
        {KINDS.map(({ kind, label, icon }) => <MenuItem key={kind} onSelect={then(() => turnInto(editor, menu.pos, kind))}><Icon name={icon} size={16} />{label}</MenuItem>)}
        <MenuLine />
      </>}
      <MenuItem onSelect={then(() => insertBlockBelow(editor, menu.pos))}><Icon name="plus" size={16} />Insert below</MenuItem>
      <MenuItem danger onSelect={then(() => deleteBlock(editor, menu.pos))}><Icon name="trash" size={16} />Delete</MenuItem>
      <MenuKeys />
    </Menu>}
  </>;
}
