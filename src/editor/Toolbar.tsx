import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { Icon } from '../ui/Icon';
import { keep, Menu, MenuKeys } from './Menu';

export type Action = {
  id: string; label: string; text?: string; icon: ReactNode; run: () => void; active?: boolean; disabled?: boolean;
  group?: 'Text style' | 'Blocks & media' | 'History';
};

/// One button of a bar, Business's ToolbarButton: an icon, or the icon and its name in a menu. A
/// toggle says whether it is on; a one-shot command does not pretend to be a toggle.
export function Tool({ action, labelled = false }: { action: Action; labelled?: boolean }) {
  return <button type="button" className="ed-tool" data-slot="tool" aria-label={action.label} title={action.label} aria-pressed={action.active}
    disabled={action.disabled} onMouseDown={keep} onClick={action.run}>
    {action.icon}{labelled && <span>{action.text}</span>}
  </button>;
}

// Where each control sits on the bar. The list below is a different order, the one they give way in.
const DISPLAY_ORDER = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link', 'h1', 'h2', 'h3', 'bullets', 'numbers', 'tasks', 'quote', 'code-block', 'table', 'image', 'undo', 'redo'];
const GROUPS = ['Text style', 'Blocks & media', 'History'] as const;
const icon = (name: Parameters<typeof Icon>[0]['name']) => <Icon name={name} size={16} />;

/// Business's RichToolbar: one row, never two. As the pane narrows the controls give way from the end of
/// a priority list into a "More" popover, grouped and labelled, so the essentials are the last to go.
export function Toolbar({ editor, onImage, onLink }: { editor: Editor; onImage?: () => void; onLink: () => void }) {
  const fmt = useEditorState({
    editor,
    selector: ({ editor }) => ({
      h1: editor.isActive('heading', { level: 1 }), h2: editor.isActive('heading', { level: 2 }), h3: editor.isActive('heading', { level: 3 }),
      bold: editor.isActive('bold'), italic: editor.isActive('italic'), underline: editor.isActive('underline'), strike: editor.isActive('strike'),
      code: editor.isActive('code'), codeBlock: editor.isActive('codeBlock'), link: editor.isActive('link'), highlight: editor.isActive('highlight'),
      bullets: editor.isActive('bulletList'), numbers: editor.isActive('orderedList'), tasks: editor.isActive('taskList'), quote: editor.isActive('blockquote'),
      table: editor.isActive('table'), canUndo: editor.can().undo(), canRedo: editor.can().redo(),
    }),
  });
  const [more, setMore] = useState<{ keyboard: boolean } | null>(null);
  const chain = () => editor.chain().focus();
  // Priority order: the essentials survive longest as space shrinks. DISPLAY_ORDER sets where they show.
  const actions: Action[] = [
    { id: 'bold', label: 'Bold (⌘B)', text: 'Bold', group: 'Text style', icon: icon('bold'), active: fmt?.bold, run: () => chain().toggleBold().run() },
    { id: 'italic', label: 'Italic (⌘I)', text: 'Italic', group: 'Text style', icon: icon('italic'), active: fmt?.italic, run: () => chain().toggleItalic().run() },
    { id: 'link', label: fmt?.link ? 'Remove link (⌘K)' : 'Link (⌘K)', text: 'Link', group: 'Text style', icon: icon('link'), active: fmt?.link, run: () => { setMore(null); onLink(); } },
    { id: 'bullets', label: 'Bulleted list (⌘⇧8)', text: 'Bulleted list', group: 'Blocks & media', icon: icon('bullets'), active: fmt?.bullets, run: () => chain().toggleBulletList().run() },
    { id: 'tasks', label: 'To-do list (⌘⇧9)', text: 'To-do list', group: 'Blocks & media', icon: icon('tasks'), active: fmt?.tasks, run: () => chain().toggleTaskList().run() },
    { id: 'h2', label: 'Heading 2 (⌘⌥2)', text: 'Heading 2', group: 'Text style', icon: icon('h2'), active: fmt?.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
    { id: 'numbers', label: 'Numbered list (⌘⇧7)', text: 'Numbered list', group: 'Blocks & media', icon: icon('numbers'), active: fmt?.numbers, run: () => chain().toggleOrderedList().run() },
    ...(onImage ? [{ id: 'image', label: 'Picture', text: 'Picture', group: 'Blocks & media' as const, icon: icon('image'), run: () => { setMore(null); onImage(); } }] : []),
    { id: 'underline', label: 'Underline (⌘U)', text: 'Underline', group: 'Text style', icon: icon('underline'), active: fmt?.underline, run: () => chain().toggleUnderline().run() },
    { id: 'h1', label: 'Heading 1 (⌘⌥1)', text: 'Heading 1', group: 'Text style', icon: icon('h1'), active: fmt?.h1, run: () => chain().toggleHeading({ level: 1 }).run() },
    { id: 'highlight', label: 'Highlight (⌘⇧H)', text: 'Highlight', group: 'Text style', icon: icon('highlight'), active: fmt?.highlight, run: () => chain().toggleHighlight().run() },
    { id: 'quote', label: 'Quote (⌘⇧B)', text: 'Quote', group: 'Blocks & media', icon: icon('quote'), active: fmt?.quote, run: () => chain().toggleBlockquote().run() },
    { id: 'strike', label: 'Strikethrough (⌘⇧S)', text: 'Strikethrough', group: 'Text style', icon: icon('strike'), active: fmt?.strike, run: () => chain().toggleStrike().run() },
    { id: 'code', label: 'Inline code (⌘E)', text: 'Inline code', group: 'Text style', icon: icon('code'), active: fmt?.code, run: () => chain().toggleCode().run() },
    { id: 'h3', label: 'Heading 3 (⌘⌥3)', text: 'Heading 3', group: 'Text style', icon: icon('h3'), active: fmt?.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
    // In a table the table controls own its rows and columns; a second table inside one is no help.
    ...(!fmt?.table ? [{ id: 'table', label: 'Table (3 × 3)', text: 'Table', group: 'Blocks & media' as const, icon: icon('table'), run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() }] : []),
    { id: 'code-block', label: 'Code block (⌘⌥C)', text: 'Code block', group: 'Blocks & media', icon: icon('codeBlock'), active: fmt?.codeBlock, run: () => chain().toggleCodeBlock().run() },
    { id: 'undo', label: 'Undo (⌘Z)', text: 'Undo', group: 'History', icon: icon('undo'), disabled: !fmt?.canUndo, run: () => chain().undo().run() },
    { id: 'redo', label: 'Redo (⌘⇧Z)', text: 'Redo', group: 'History', icon: icon('redo'), disabled: !fmt?.canRedo, run: () => chain().redo().run() },
  ];
  const bar = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [visibleCount, setVisibleCount] = useState(5);
  const actionCount = actions.length;
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      const buttonWidth = el.querySelector<HTMLElement>('[data-slot="tool"]')?.getBoundingClientRect().width ?? 0;
      if (!width || !buttonWidth) return; // hidden: measured when it shows again
      const style = getComputedStyle(el);
      const gap = parseFloat(style.columnGap) || 4;
      const available = width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const capacity = Math.floor((available + gap) / (buttonWidth + gap));
      // Not all of them: one slot goes to "More".
      setVisibleCount(capacity >= actionCount ? actionCount : Math.max(0, capacity - 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [actionCount]);
  const byDisplay = (a: Action, b: Action) => DISPLAY_ORDER.indexOf(a.id) - DISPLAY_ORDER.indexOf(b.id);
  const shown = actions.slice(0, visibleCount).sort(byDisplay);
  const overflow = actions.slice(visibleCount).sort(byDisplay);
  useEffect(() => { if (!overflow.length) setMore(null); }, [overflow.length]);
  return <div ref={bar} className="ed-toolbar" role="toolbar" aria-label="Formatting">
    {shown.map(action => <Tool key={action.id} action={action} />)}
    {overflow.length > 0 && <button ref={moreButton} type="button" className="ed-tool" data-slot="tool" aria-label="More formatting" title="More formatting" aria-haspopup="dialog" aria-expanded={!!more}
      onMouseDown={keep} onClick={event => setMore(open => open ? null : { keyboard: event.detail === 0 })}>
      <Icon name="dots" size={18} />
    </button>}
    {more && moreButton.current && <Menu anchor={moreButton.current} label="More formatting" className="ed-more" cols={2} focus={more.keyboard} onClose={() => setMore(null)}>
      {GROUPS.map(group => {
        const items = overflow.filter(action => action.group === group);
        return items.length > 0 && <fieldset key={group}><legend>{group}</legend>{items.map(action => <Tool key={action.id} action={action} labelled />)}</fieldset>;
      })}
      <MenuKeys grid />
    </Menu>}
  </div>;
}
