import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { Icon, type IconName } from '../ui/Icon';
import { leave } from '../ui/motion';

/// What "/" offers, as TabTasker Business's Text editor offers it (slashItems.ts): blocks to turn the
/// line into or put in, each found by its name or a few other words.
export type SlashItem = { id: string; title: string; detail: string; icon: IconName; keywords: string[]; run: (editor: Editor, range: Range) => void };

export const slashItems = (onImage?: () => void): SlashItem[] => {
  const block = (run: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => (editor: Editor, range: Range) => { run(editor.chain().focus().deleteRange(range)).run(); };
  const items: SlashItem[] = [
    { id: 'h1', title: 'Heading 1', detail: 'Big section heading', icon: 'h1', keywords: ['h1', 'title', 'heading'], run: block(chain => chain.setNode('heading', { level: 1 })) },
    { id: 'h2', title: 'Heading 2', detail: 'Medium section heading', icon: 'h2', keywords: ['h2', 'subtitle', 'heading'], run: block(chain => chain.setNode('heading', { level: 2 })) },
    { id: 'h3', title: 'Heading 3', detail: 'Small section heading', icon: 'h3', keywords: ['h3', 'heading'], run: block(chain => chain.setNode('heading', { level: 3 })) },
    { id: 'bullets', title: 'Bulleted list', detail: 'A simple bullet list', icon: 'bullets', keywords: ['ul', 'unordered', 'bullet', 'list'], run: block(chain => chain.toggleBulletList()) },
    { id: 'numbers', title: 'Numbered list', detail: 'A list with numbering', icon: 'numbers', keywords: ['ol', 'ordered', 'number', 'list'], run: block(chain => chain.toggleOrderedList()) },
    { id: 'tasks', title: 'To-do list', detail: 'Track tasks with checkboxes', icon: 'tasks', keywords: ['todo', 'task', 'checkbox', 'check', 'to-do'], run: block(chain => chain.toggleTaskList()) },
    { id: 'quote', title: 'Quote', detail: 'Capture a quotation', icon: 'quote', keywords: ['quote', 'blockquote', 'citation'], run: block(chain => chain.toggleBlockquote()) },
    { id: 'code', title: 'Code block', detail: 'Monospace code with syntax', icon: 'codeBlock', keywords: ['code', 'pre', 'snippet'], run: block(chain => chain.toggleCodeBlock()) },
    { id: 'divider', title: 'Divider', detail: 'A horizontal rule', icon: 'divider', keywords: ['hr', 'rule', 'separator', 'line'], run: block(chain => chain.setHorizontalRule()) },
    { id: 'table', title: 'Table', detail: 'Insert a 3x3 table', icon: 'table', keywords: ['table', 'grid', 'rows', 'columns'], run: block(chain => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })) },
  ];
  if (onImage) items.push({ id: 'image', title: 'Picture', detail: 'A picture from your Mac, kept beside the note', icon: 'image', keywords: ['image', 'img', 'picture', 'photo', 'screenshot'], run: (editor, range) => { editor.chain().focus().deleteRange(range).run(); onImage(); } });
  return items;
};

/** Case-insensitive match on the title and the keywords. An empty query is everything. */
export const filterSlash = (items: SlashItem[], query: string) => {
  const q = query.trim().toLowerCase();
  return q ? items.filter(item => item.title.toLowerCase().includes(q) || item.keywords.some(word => word.includes(q))) : items;
};

type SlashMenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

/// Business's SlashMenu: the inverted tray, a group label, a glyph on a plate, the name and what it
/// does, and the keys it answers to. Arrows move, Return takes, Escape leaves.
const SlashMenu = forwardRef<SlashMenuHandle, { items: SlashItem[]; command: (item: SlashItem) => void }>(function SlashMenu({ items, command }, ref) {
  const [at, setAt] = useState(0);
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => setAt(0), [items]);
  useEffect(() => { active.current?.scrollIntoView({ block: 'nearest' }); }, [at]);
  useImperativeHandle(ref, () => ({
    onKeyDown: event => {
      if (event.key === 'ArrowDown') { setAt(n => (n + 1) % Math.max(1, items.length)); return true; }
      if (event.key === 'ArrowUp') { setAt(n => (n - 1 + items.length) % Math.max(1, items.length)); return true; }
      // Nothing matched: Return is a new line, not swallowed by a menu with nothing in it.
      if (event.key === 'Enter') { if (!items.length) return false; if (items[at]) command(items[at]); return true; }
      return false;
    },
  }), [items, at, command]);
  return <div className="ed-menu ed-slash">
    {items.length === 0
      ? <p className="ed-slash-none">No matching blocks</p>
      : <div className="ed-slash-list" role="listbox" aria-label="Insert block">
        <div className="ed-menu-label">Blocks</div>
        {items.map((item, i) => <button key={item.id} ref={i === at ? active : undefined} type="button" role="option" aria-selected={i === at} className="ed-slash-item"
          onMouseDown={event => { event.preventDefault(); command(item); }} onMouseEnter={() => setAt(i)}>
          <span className="ed-slash-icon"><Icon name={item.icon} size={16} /></span>
          <span className="ed-slash-words"><span className="ed-slash-title">{item.title}</span><span className="ed-slash-detail">{item.detail}</span></span>
        </button>)}
      </div>}
    <div className="ed-keys ed-slash-keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>navigate</span><span><kbd>↵</kbd>select</span><span><kbd>esc</kbd>dismiss</span></div>
  </div>;
});

/// "/" at the start of a line or after a space opens the menu, positioned from the caret: under it,
/// or over it when the window has no room below.
export const SlashCommand = Extension.create<{ onImage?: () => void }>({
  name: 'slashCommand',
  addOptions: () => ({ onImage: undefined }),
  addProseMirrorPlugins() {
    const items = slashItems(this.options.onImage);
    let root: Root | null = null, box: HTMLDivElement | null = null, handle: SlashMenuHandle | null = null;
    const draw = (props: SuggestionProps<SlashItem>) => root?.render(<SlashMenu ref={h => { handle = h; }} items={props.items} command={item => props.command(item)} />);
    const place = (props: SuggestionProps<SlashItem>) => {
      const rect = props.clientRect?.();
      if (!box || !rect) return;
      const gap = 12, room = innerHeight - rect.bottom - gap - 12, height = box.offsetHeight || 380;
      const below = room >= Math.min(height, 240) || rect.top < height;
      box.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 300))}px`;
      box.style.top = `${below ? rect.bottom + gap : rect.top - gap - height}px`;
      box.toggleAttribute('data-above', !below); // it grows from the caret's side
    };
    return [Suggestion<SlashItem>({
      editor: this.editor, char: '/', startOfLine: false, allowSpaces: false,
      items: ({ query }) => filterSlash(items, query),
      command: ({ editor, range, props }) => props.run(editor, range),
      render: () => ({
        onStart: props => {
          box = document.createElement('div'); box.className = 'ed-slash-box'; document.body.append(box);
          root = createRoot(box);
          draw(props);
          requestAnimationFrame(() => place(props));
          place(props);
        },
        onUpdate: props => { draw(props); place(props); },
        onKeyDown: ({ event }) => event.key === 'Escape' || (handle?.onKeyDown(event) ?? false),
        onExit: () => { const r = root, b = box; root = null; box = null; handle = null; leave(b)?.(); queueMicrotask(() => { r?.unmount(); b?.remove(); }); },
      }),
    })];
  },
});
