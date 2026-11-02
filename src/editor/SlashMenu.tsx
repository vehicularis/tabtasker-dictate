import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Icon, type IconName } from '../ui/Icon';

/// What "/" offers, as TabTasker Business's Text editor offers it (slashItems.ts): blocks to turn the
/// line into or put in, each found by its name or a few other words.
export type SlashItem = { id: string; title: string; detail: string; icon?: IconName; text?: string; keywords: string[]; run: (editor: Editor, range: { from: number; to: number }) => void };

export const slashItems = (onImage?: () => void): SlashItem[] => {
  const block = (run: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => (editor: Editor, range: { from: number; to: number }) => { run(editor.chain().focus().deleteRange(range)).run(); };
  const items: SlashItem[] = [
    { id: 'h1', title: 'Heading 1', detail: 'A big section heading', text: 'H1', keywords: ['h1', 'title', 'heading'], run: block(chain => chain.setNode('heading', { level: 1 })) },
    { id: 'h2', title: 'Heading 2', detail: 'A medium heading', text: 'H2', keywords: ['h2', 'subtitle', 'heading'], run: block(chain => chain.setNode('heading', { level: 2 })) },
    { id: 'h3', title: 'Heading 3', detail: 'A small heading', text: 'H3', keywords: ['h3', 'heading'], run: block(chain => chain.setNode('heading', { level: 3 })) },
    { id: 'bullets', title: 'Bulleted list', detail: 'A simple list', icon: 'bullets', keywords: ['ul', 'bullet', 'list', 'unordered'], run: block(chain => chain.toggleBulletList()) },
    { id: 'numbers', title: 'Numbered list', detail: 'A list with numbers', icon: 'numbers', keywords: ['ol', 'ordered', 'number', 'list'], run: block(chain => chain.toggleOrderedList()) },
    { id: 'tasks', title: 'To-do list', detail: 'Things to do, with boxes to tick', icon: 'tasks', keywords: ['todo', 'task', 'check', 'to-do'], run: block(chain => chain.toggleTaskList()) },
    { id: 'quote', title: 'Quote', detail: 'Something someone said', icon: 'quote', keywords: ['quote', 'blockquote', 'citation'], run: block(chain => chain.toggleBlockquote()) },
    { id: 'code', title: 'Code block', detail: 'Code in a box, with colours', icon: 'codeBlock', keywords: ['code', 'pre', 'snippet'], run: block(chain => chain.toggleCodeBlock()) },
    { id: 'table', title: 'Table', detail: 'Three by three, with a header row', icon: 'table', keywords: ['table', 'grid', 'rows', 'columns'], run: block(chain => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })) },
    { id: 'divider', title: 'Divider', detail: 'A line across the page', icon: 'divider', keywords: ['hr', 'rule', 'separator', 'line'], run: block(chain => chain.setHorizontalRule()) },
  ];
  if (onImage) items.push({ id: 'image', title: 'Picture', detail: 'A picture from your Mac, kept beside the note', icon: 'image', keywords: ['image', 'picture', 'photo', 'img', 'screenshot'], run: (editor, range) => { editor.chain().focus().deleteRange(range).run(); onImage(); } });
  return items;
};

export const filterSlash = (items: SlashItem[], query: string) => {
  const q = query.trim().toLowerCase();
  return q ? items.filter(item => item.title.toLowerCase().includes(q) || item.keywords.some(word => word.includes(q))) : items;
};

export type SlashMenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

/// The menu itself: arrows move, Return takes, Escape leaves. Positioned by the suggestion plugin.
export const SlashMenu = forwardRef<SlashMenuHandle, { items: SlashItem[]; command: (item: SlashItem) => void }>(function SlashMenu({ items, command }, ref) {
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: event => {
      if (event.key === 'ArrowDown') { setAt(n => (n + 1) % Math.max(1, items.length)); return true; }
      if (event.key === 'ArrowUp') { setAt(n => (n - 1 + items.length) % Math.max(1, items.length)); return true; }
      if (event.key === 'Enter') { if (items[at]) command(items[at]); return true; }
      return false;
    },
  }), [items, at, command]);
  if (!items.length) return <div className="slash" role="listbox"><p className="slash-none">Nothing called that</p></div>;
  return <div className="slash" role="listbox" aria-label="Insert">
    {items.map((item, i) => <button key={item.id} type="button" role="option" aria-selected={i === at} className="slash-item" onMouseDown={event => event.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => command(item)}>
      <span className="slash-icon">{item.icon ? <Icon name={item.icon} size={16} /> : <b>{item.text}</b>}</span>
      <span className="slash-words"><span className="slash-title">{item.title}</span><span className="slash-detail">{item.detail}</span></span>
    </button>)}
  </div>;
});
