import { useState, type MouseEvent, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor as TipTap } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Highlight } from '@tiptap/extension-highlight';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { Icon, type IconName } from '../ui/Icon';
import './editor.css';

// The Text editor, as TabTasker Business writes with it (RichEditor.tsx, on TipTap): headings, lists and
// to-do lists, quotes, code, links and highlights, typed with Markdown shortcuts or from the bar above,
// and kept as Markdown, so a note is still a plain file any other app can read. `compact` is a sticky:
// the same editor with no bar and smaller type.
export function Editor({ markdown, onChange, placeholder, compact = false, autoFocus = false, label, bar }: {
  markdown: string; onChange: (markdown: string) => void; placeholder?: string; compact?: boolean; autoFocus?: boolean; label: string;
  /// Something to show at the end of the bar (a note's save state).
  bar?: ReactNode;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      TaskList, TaskItem.configure({ nested: true }),
      Highlight,
      Placeholder.configure({ placeholder: placeholder ?? 'Type, or hold fn and talk' }),
      Markdown,
    ],
    content: markdown, contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editorProps: { attributes: { class: `ed-body${compact ? ' compact' : ''}`, role: 'textbox', 'aria-multiline': 'true', 'aria-label': label } },
    onUpdate: ({ editor, transaction }) => { if (transaction.docChanged) onChange(editor.getMarkdown()); },
  });
  return <div className={`ed${compact ? ' compact' : ''}`}>
    {!compact && editor && <Toolbar editor={editor} tail={bar} />}
    <EditorContent editor={editor} className="ed-content" />
  </div>;
}

type Tool = { id: string; label: string; icon?: IconName; text?: string; active?: boolean; disabled?: boolean; run: () => void };

/// Business's formatting bar: text styles, then blocks, then history, each a round of small buttons.
function Toolbar({ editor, tail }: { editor: TipTap; tail?: ReactNode }) {
  const on = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'), italic: editor.isActive('italic'), underline: editor.isActive('underline'), strike: editor.isActive('strike'),
      code: editor.isActive('code'), highlight: editor.isActive('highlight'), link: editor.isActive('link'),
      h1: editor.isActive('heading', { level: 1 }), h2: editor.isActive('heading', { level: 2 }), h3: editor.isActive('heading', { level: 3 }),
      bullets: editor.isActive('bulletList'), numbers: editor.isActive('orderedList'), tasks: editor.isActive('taskList'),
      quote: editor.isActive('blockquote'), codeBlock: editor.isActive('codeBlock'),
      canUndo: editor.can().undo(), canRedo: editor.can().redo(),
    }),
  });
  // The link field, open with the link's address (or nothing) while a link is being written.
  const [linking, setLinking] = useState<string | null>(null);
  const chain = () => editor.chain().focus();
  const link = () => {
    if (on?.link) { chain().extendMarkRange('link').unsetLink().run(); return; }
    setLinking((editor.getAttributes('link').href as string | undefined) ?? '');
  };
  const setLink = (text: string) => {
    const address = text.trim();
    if (address) chain().extendMarkRange('link').setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}` }).run();
    else editor.commands.focus();
    setLinking(null);
  };
  const groups: Tool[][] = [
    [
      { id: 'bold', label: 'Bold (⌘B)', icon: 'bold', active: on?.bold, run: () => chain().toggleBold().run() },
      { id: 'italic', label: 'Italic (⌘I)', icon: 'italic', active: on?.italic, run: () => chain().toggleItalic().run() },
      { id: 'underline', label: 'Underline (⌘U)', icon: 'underline', active: on?.underline, run: () => chain().toggleUnderline().run() },
      { id: 'strike', label: 'Strikethrough (⌘⇧X)', icon: 'strike', active: on?.strike, run: () => chain().toggleStrike().run() },
      { id: 'code', label: 'Inline code (⌘E)', icon: 'code', active: on?.code, run: () => chain().toggleCode().run() },
      { id: 'highlight', label: 'Highlight (⌘⇧H)', icon: 'highlight', active: on?.highlight, run: () => chain().toggleHighlight().run() },
      { id: 'link', label: on?.link ? 'Remove link' : 'Link (⌘K)', icon: 'link', active: on?.link, run: link },
    ],
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
      { id: 'divider', label: 'Divider', icon: 'divider', run: () => chain().setHorizontalRule().run() },
    ],
    [
      { id: 'undo', label: 'Undo (⌘Z)', icon: 'undo', disabled: !on?.canUndo, run: () => chain().undo().run() },
      { id: 'redo', label: 'Redo (⌘⇧Z)', icon: 'redo', disabled: !on?.canRedo, run: () => chain().redo().run() },
    ],
  ];
  // A press on the bar must not take the selection out of the text: the command works on what is selected.
  const keep = (event: MouseEvent) => event.preventDefault();
  return <div className="ed-bar" role="toolbar" aria-label="Formatting"
    onKeyDown={event => { if (event.key === 'k' && event.metaKey) { event.preventDefault(); link(); } }}>
    {groups.map((tools, i) => <span key={i} className="ed-group">
      {tools.map(tool => <button key={tool.id} type="button" className="ed-tool" aria-label={tool.label} title={tool.label} aria-pressed={tool.active}
        disabled={tool.disabled} onMouseDown={keep} onClick={tool.run}>
        {tool.icon ? <Icon name={tool.icon} size={16} /> : <b>{tool.text}</b>}
      </button>)}
    </span>)}
    {linking !== null && <form className="ed-link" onSubmit={event => { event.preventDefault(); setLink(linking); }}>
      <Icon name="link" size={14} />
      <input autoFocus value={linking} placeholder="Paste or type a link" aria-label="Link address" spellCheck={false} onChange={event => setLinking(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setLinking(null); editor.commands.focus(); } }} />
      <button type="submit" className="ed-tool" aria-label="Add the link" title="Add the link"><Icon name="check" size={14} /></button>
    </form>}
    {tail && <span className="ed-tail">{tail}</span>}
  </div>;
}
