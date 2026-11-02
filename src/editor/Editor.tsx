import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Extension, type Editor as TipTap } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Highlight } from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { common, createLowlight } from 'lowlight';
import { fileSrc, invoke } from '../bridge';
import { Icon, type IconName } from '../ui/Icon';
import { filterSlash, SlashMenu, slashItems, type SlashItem, type SlashMenuHandle } from './SlashMenu';
import './editor.css';

const lowlight = createLowlight(common);

// The Text editor, as TabTasker Business writes with it (RichEditor.tsx, on TipTap): headings, lists and
// to-do lists, quotes, code with colours, tables, pictures, links and highlights, typed with Markdown
// shortcuts, from the bar above, from "/" or from the bar that comes up over a selection; a handle to
// drag a block by. Kept as Markdown, so a note is still a plain file any other app can read. `compact`
// is a sticky: the same editor with no bars and smaller type. `notePath` is the file the note is, for
// pictures: a pasted or dropped one is saved beside it and shown from there.
export function Editor({ markdown, onChange, placeholder, compact = false, autoFocus = false, label, bar, notePath }: {
  markdown: string; onChange: (markdown: string) => void; placeholder?: string; compact?: boolean; autoFocus?: boolean; label: string; bar?: ReactNode; notePath?: string;
}) {
  const folder = notePath ? notePath.slice(0, notePath.lastIndexOf('/')) : null;
  const pathRef = useRef(notePath); pathRef.current = notePath;
  const files = useRef<HTMLInputElement>(null);
  // Pictures: saved beside the note, then put in by their relative path, shown from the file.
  const attach = async (editor: TipTap, file: File, at?: number) => {
    const path = pathRef.current;
    if (!path) return false;
    if (!file.type.startsWith('image/')) return false;
    const data = await new Promise<string>((done, fail) => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => fail(reader.error); reader.readAsDataURL(file); });
    const src = await invoke<string>('note_attach', { path, name: file.name || 'picture.png', data });
    const node = { type: 'image', attrs: { src, alt: file.name.replace(/\.[a-z0-9]+$/i, '') } };
    if (at === undefined) editor.chain().focus().insertContent(node).run(); else editor.chain().focus().insertContentAt(at, node).run();
    return true;
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }, codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
      TaskList, TaskItem.configure({ nested: true }),
      Highlight,
      TableKit.configure({ table: { resizable: false } }),
      // A relative `src` (`attachments/…`) is the note's own; it is shown from the file beside the note.
      Image.extend({
        renderHTML({ HTMLAttributes }) {
          const src = String(HTMLAttributes.src ?? '');
          const shown = folder && !/^(?:[a-z]+:|\/)/i.test(src) ? fileSrc(`${folder}/${src}`) : src;
          return ['img', { ...HTMLAttributes, src: shown, 'data-src': src }];
        },
      }).configure({ allowBase64: true }),
      Placeholder.configure({ placeholder: placeholder ?? 'Type, or hold fn and talk' }),
      Markdown,
      ...(compact ? [] : [slash(() => files.current?.click())]),
    ],
    content: markdown, contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: `ed-body${compact ? ' compact' : ''}`, role: 'textbox', 'aria-multiline': 'true', 'aria-label': label },
      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
        if (!file || !pathRef.current || !editorRef.current) return false;
        void attach(editorRef.current, file).catch(() => {});
        return true;
      },
      handleDrop: (view, event) => {
        const file = [...((event as DragEvent).dataTransfer?.files ?? [])].find(file => file.type.startsWith('image/'));
        if (!file || !pathRef.current || !editorRef.current) return false;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
        void attach(editorRef.current, file, at).catch(() => {});
        return true;
      },
    },
    onUpdate: ({ editor, transaction }) => { if (transaction.docChanged) onChange(editor.getMarkdown()); },
  });
  const editorRef = useRef<TipTap | null>(null); editorRef.current = editor;
  return <div className={`ed${compact ? ' compact' : ''}`}>
    {!compact && editor && <Toolbar editor={editor} tail={bar} onImage={notePath ? () => files.current?.click() : undefined} />}
    {!compact && editor && <BubbleMenu editor={editor} className="ed-bubble" shouldShow={({ editor, state }) => !state.selection.empty && !editor.isActive('codeBlock') && !editor.isActive('image')}>
      <Bubble editor={editor} />
    </BubbleMenu>}
    {!compact && editor && <DragHandle editor={editor} className="ed-handle"><Icon name="grip" size={14} /></DragHandle>}
    <EditorContent editor={editor} className="ed-content" />
    {notePath && <input ref={files} type="file" accept="image/*" hidden aria-label="Add a picture" onChange={event => { const file = event.target.files?.[0]; if (file && editorRef.current) void attach(editorRef.current, file).catch(() => {}); event.target.value = ''; }} />}
  </div>;
}

/// "/" at the start of a line, or after a space: the menu of things to put in.
function slash(onImage: () => void) {
  return Extension.create({
    name: 'slash',
    addProseMirrorPlugins() {
      let root: Root | null = null, box: HTMLDivElement | null = null, handle: SlashMenuHandle | null = null;
      const items = slashItems(onImage);
      const place = (props: SuggestionProps<SlashItem>) => {
        const rect = props.clientRect?.();
        if (!box || !rect) return;
        const below = rect.bottom + 6, height = Math.min(360, innerHeight - below - 12);
        box.style.left = `${Math.min(rect.left, innerWidth - 300)}px`;
        box.style.top = `${height > 160 ? below : rect.top - 6 - Math.min(360, rect.top - 12)}px`;
        box.style.maxHeight = `${Math.max(160, height)}px`;
      };
      return [Suggestion<SlashItem>({
        editor: this.editor, char: '/', startOfLine: false, allowSpaces: false,
        items: ({ query }) => filterSlash(items, query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: props => {
            box = document.createElement('div'); box.className = 'ed-slash-box'; document.body.append(box);
            root = createRoot(box);
            root.render(<SlashMenu ref={h => { handle = h; }} items={props.items} command={item => props.command(item)} />);
            place(props);
          },
          onUpdate: props => { root?.render(<SlashMenu ref={h => { handle = h; }} items={props.items} command={item => props.command(item)} />); place(props); },
          onKeyDown: ({ event }) => { if (event.key === 'Escape') { return true; } return handle?.onKeyDown(event) ?? false; },
          onExit: () => { const r = root, b = box; root = null; box = null; handle = null; queueMicrotask(() => { r?.unmount(); b?.remove(); }); },
        }),
      })];
    },
  });
}

type Tool = { id: string; label: string; icon?: IconName; text?: string; active?: boolean; disabled?: boolean; run: () => void };

/// What the editor is doing at the cursor, read live.
function useFormat(editor: TipTap) {
  return useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'), italic: editor.isActive('italic'), underline: editor.isActive('underline'), strike: editor.isActive('strike'),
      code: editor.isActive('code'), highlight: editor.isActive('highlight'), link: editor.isActive('link'),
      h1: editor.isActive('heading', { level: 1 }), h2: editor.isActive('heading', { level: 2 }), h3: editor.isActive('heading', { level: 3 }),
      bullets: editor.isActive('bulletList'), numbers: editor.isActive('orderedList'), tasks: editor.isActive('taskList'),
      quote: editor.isActive('blockquote'), codeBlock: editor.isActive('codeBlock'), table: editor.isActive('table'),
      canUndo: editor.can().undo(), canRedo: editor.can().redo(),
    }),
  });
}

/// The text tools, shared by the bar above and the bar over a selection.
function useTextTools(editor: TipTap, on: ReturnType<typeof useFormat>, link: () => void): Tool[] {
  const chain = () => editor.chain().focus();
  return [
    { id: 'bold', label: 'Bold (⌘B)', icon: 'bold', active: on?.bold, run: () => chain().toggleBold().run() },
    { id: 'italic', label: 'Italic (⌘I)', icon: 'italic', active: on?.italic, run: () => chain().toggleItalic().run() },
    { id: 'underline', label: 'Underline (⌘U)', icon: 'underline', active: on?.underline, run: () => chain().toggleUnderline().run() },
    { id: 'strike', label: 'Strikethrough (⌘⇧X)', icon: 'strike', active: on?.strike, run: () => chain().toggleStrike().run() },
    { id: 'code', label: 'Inline code (⌘E)', icon: 'code', active: on?.code, run: () => chain().toggleCode().run() },
    { id: 'highlight', label: 'Highlight (⌘⇧H)', icon: 'highlight', active: on?.highlight, run: () => chain().toggleHighlight().run() },
    { id: 'link', label: on?.link ? 'Remove link' : 'Link (⌘K)', icon: 'link', active: on?.link, run: link },
  ];
}

const keep = (event: MouseEvent) => event.preventDefault(); // a press on a bar must not take the selection out of the text

function ToolButton({ tool }: { tool: Tool }) {
  return <button type="button" className="ed-tool" aria-label={tool.label} title={tool.label} aria-pressed={tool.active} disabled={tool.disabled} onMouseDown={keep} onClick={tool.run}>
    {tool.icon ? <Icon name={tool.icon} size={16} /> : <b>{tool.text}</b>}
  </button>;
}

/// The link field: open with the link's address (or nothing) while a link is being written.
function useLink(editor: TipTap, on: ReturnType<typeof useFormat>) {
  const [linking, setLinking] = useState<string | null>(null);
  const link = () => {
    if (on?.link) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    setLinking((editor.getAttributes('link').href as string | undefined) ?? '');
  };
  const setLink = (text: string) => {
    const address = text.trim();
    if (address) editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}` }).run();
    else editor.commands.focus();
    setLinking(null);
  };
  const field = linking !== null && <form className="ed-link" onSubmit={event => { event.preventDefault(); setLink(linking); }}>
    <Icon name="link" size={14} />
    <input autoFocus value={linking} placeholder="Paste or type a link" aria-label="Link address" spellCheck={false} onChange={event => setLinking(event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setLinking(null); editor.commands.focus(); } }} />
    <button type="submit" className="ed-tool" aria-label="Add the link" title="Add the link"><Icon name="check" size={14} /></button>
  </form>;
  return { link, field };
}

/// Business's formatting bar: text styles, headings, blocks, history, in rounds of small buttons.
function Toolbar({ editor, tail, onImage }: { editor: TipTap; tail?: ReactNode; onImage?: () => void }) {
  const on = useFormat(editor);
  const { link, field } = useLink(editor, on);
  const text = useTextTools(editor, on, link);
  const chain = () => editor.chain().focus();
  const groups: Tool[][] = [
    text,
    [
      { id: 'h1', label: 'Heading 1 (⌘⌥1)', text: 'H1', active: on?.h1, run: () => chain().toggleHeading({ level: 1 }).run() },
      { id: 'h2', label: 'Heading 2 (⌘⌥2)', text: 'H2', active: on?.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
      { id: 'h3', label: 'Heading 3 (⌘⌥3)', text: 'H3', active: on?.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
    ],
    [
      { id: 'bullets', label: 'Bulleted list (⌘⇧8)', icon: 'bullets', active: on?.bullets, run: () => chain().toggleBulletList().run() },
      { id: 'numbers', label: 'Numbered list (⌘⇧7)', icon: 'numbers', active: on?.numbers, run: () => chain().toggleOrderedList().run() },
      { id: 'tasks', label: 'To-do list (⌘⇧9)', icon: 'tasks', active: on?.tasks, run: () => chain().toggleTaskList().run() },
      { id: 'quote', label: 'Quote (⌘⇧B)', icon: 'quote', active: on?.quote, run: () => chain().toggleBlockquote().run() },
      { id: 'codeBlock', label: 'Code block (⌘⌥C)', icon: 'codeBlock', active: on?.codeBlock, run: () => chain().toggleCodeBlock().run() },
      { id: 'table', label: on?.table ? 'Table' : 'Table (3 × 3)', icon: 'table', active: on?.table, run: () => { if (!on?.table) chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
      ...(onImage ? [{ id: 'image', label: 'Picture', icon: 'image' as IconName, run: onImage }] : []),
      { id: 'divider', label: 'Divider', icon: 'divider', run: () => chain().setHorizontalRule().run() },
    ],
    [
      { id: 'undo', label: 'Undo (⌘Z)', icon: 'undo', disabled: !on?.canUndo, run: () => chain().undo().run() },
      { id: 'redo', label: 'Redo (⌘⇧Z)', icon: 'redo', disabled: !on?.canRedo, run: () => chain().redo().run() },
    ],
  ];
  const tableTools: Tool[] = on?.table ? [
    { id: 'row-after', label: 'Add a row below', icon: 'rowAdd', run: () => chain().addRowAfter().run() },
    { id: 'col-after', label: 'Add a column after', icon: 'colAdd', run: () => chain().addColumnAfter().run() },
    { id: 'row-del', label: 'Remove this row', icon: 'rowRemove', run: () => chain().deleteRow().run() },
    { id: 'col-del', label: 'Remove this column', icon: 'colRemove', run: () => chain().deleteColumn().run() },
    { id: 'table-del', label: 'Remove the table', icon: 'trash', run: () => chain().deleteTable().run() },
  ] : [];
  return <div className="ed-bar" role="toolbar" aria-label="Formatting" onKeyDown={event => { if (event.key === 'k' && event.metaKey) { event.preventDefault(); link(); } }}>
    {groups.map((tools, i) => <span key={i} className="ed-group">{tools.map(tool => <ToolButton key={tool.id} tool={tool} />)}</span>)}
    {tableTools.length > 0 && <span className="ed-group">{tableTools.map(tool => <ToolButton key={tool.id} tool={tool} />)}</span>}
    {field}
    {tail && <span className="ed-tail">{tail}</span>}
  </div>;
}

/// The bar over a selection: the text styles, close to hand.
function Bubble({ editor }: { editor: TipTap }) {
  const on = useFormat(editor);
  const { link, field } = useLink(editor, on);
  const text = useTextTools(editor, on, link);
  return <>{text.map(tool => <ToolButton key={tool.id} tool={tool} />)}{field}</>;
}
