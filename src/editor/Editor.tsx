import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Extension, posToDOMRect, type Editor as TipTap } from '@tiptap/core';
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Highlight } from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { NodeRange } from '@tiptap/extension-node-range';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { common, createLowlight } from 'lowlight';
import { fileSrc, invoke } from '../bridge';
import { Select } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { BlockDrop, TaskListMarkdownShortcut } from './blocks';
import { BlockHandles } from './BlockHandles';
import { Bubble } from './Bubble';
import { FindBar, FindReplace } from './Find';
import { Menu } from './Menu';
import { SlashCommand } from './SlashMenu';
import { MarkdownTableHeader, TableControls } from './TableControls';
import { Toolbar } from './Toolbar';
import './editor.css';

const lowlight = createLowlight(common);

/// Plain text that is written as Markdown: a heading, a list, a fenced block, bold or a link on one of its lines.
const looksLikeMarkdown = (text: string) => /^(?:#{1,6} |[-*+] |\d+\. |> |```)/m.test(text) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/.test(text);

// The Text editor, as TabTasker Business's Atlas pages write with it (RichEditor.tsx, on TipTap): the
// formatting bar that folds into "More" as the pane narrows, the bar over a selection, "/" for blocks,
// a handle beside every block to drag it, add under it, turn it into something else or delete it, and
// the table's own row and column controls. Kept as Markdown, so a note is still a plain file any other
// app can read: nothing is offered that Markdown cannot hold. `compact` is a sticky: the same editor
// with no bar above and no handles, but "/" and the selection bar, in smaller type. `notePath` is the
// file the note is, for pictures: a pasted or dropped one is saved beside it and shown from there.
export function Editor({ markdown, onChange, placeholder, compact = false, autoFocus = false, label, bar, notePath }: {
  markdown: string; onChange: (markdown: string) => void; placeholder?: string; compact?: boolean; autoFocus?: boolean; label: string; bar?: ReactNode; notePath?: string;
}) {
  const folder = notePath ? notePath.slice(0, notePath.lastIndexOf('/')) : null;
  const pathRef = useRef(notePath); pathRef.current = notePath;
  const files = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const linkRef = useRef(() => {});
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
      // No drop cursor: BlockDrop draws the line and lands a block by the vertical half of the row.
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }, codeBlock: false, dropcursor: false }),
      CodeBlockLowlight.extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) }).configure({ lowlight }),
      TaskList, TaskItem.configure({ nested: true }), TaskListMarkdownShortcut,
      Highlight,
      // Column widths are not Markdown, so a table sizes to its content and nobody drags its edges.
      TableKit.configure({ table: { resizable: false } }), MarkdownTableHeader,
      // A relative `src` (`attachments/…`) is the note's own; it is shown from the file beside the note.
      Image.extend({
        renderHTML({ HTMLAttributes }) {
          const src = String(HTMLAttributes.src ?? '');
          const shown = folder && !/^(?:[a-z]+:|\/)/i.test(src) ? fileSrc(`${folder}/${src}`) : src;
          return ['img', { ...HTMLAttributes, src: shown, 'data-src': src }];
        },
      }).configure({ allowBase64: true }),
      Placeholder.configure({ placeholder: placeholder ?? 'Type, or hold your key and talk' }),
      Markdown,
      SlashCommand.configure({ onImage: notePath ? () => files.current?.click() : undefined }),
      BlockDrop,
      // The drag handle's peer: what lets a drag pick up a whole block. Its keymap is dropped, as Atlas
      // drops it: ⌘A would otherwise select the page invisibly.
      NodeRange.extend({ addKeyboardShortcuts: () => ({}) }),
      FindReplace,
      Extension.create({ name: 'linkKey', addKeyboardShortcuts: () => ({ 'Mod-k': () => { linkRef.current(); return true; } }) }),
    ],
    content: markdown, contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: `ed-body${compact ? ' compact' : ''}`, role: 'textbox', 'aria-multiline': 'true', 'aria-label': label },
      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
        if (file && pathRef.current && editorRef.current) { void attach(editorRef.current, file).catch(() => {}); return true; }
        // Markdown pasted as plain text (a note from elsewhere, a chat's answer) comes in as what it says, as Atlas
        // takes it: headings, lists, bold. Not when the clipboard also carries real formatting, which TipTap
        // round-trips better, and not inside a code block, where every marker is literal.
        const html = event.clipboardData?.getData('text/html') ?? '', text = event.clipboardData?.getData('text/plain') ?? '';
        const rich = /<(?:h[1-6]|ul|ol|li|strong|em|b|i|a|table|blockquote)\b/i.test(html);
        if (!editorRef.current || editorRef.current.isActive('codeBlock') || rich || !looksLikeMarkdown(text)) return false;
        editorRef.current.chain().focus().insertContent(text, { contentType: 'markdown' }).run();
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

  // The link: off when the caret is on one, otherwise a field at the selection asks for the address.
  const [linking, setLinking] = useState<{ rect: DOMRect; href: string } | null>(null);
  linkRef.current = () => {
    if (!editor) return;
    if (editor.isActive('link')) { editor.chain().focus().unsetLink().run(); return; }
    const { from, to } = editor.state.selection;
    setLinking({ rect: posToDOMRect(editor.view, from, to), href: '' });
  };
  const setLink = (text: string) => {
    setLinking(null);
    if (!editor) return;
    const address = text.trim();
    if (!address) { editor.commands.focus(); return; }
    const href = /^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`;
    if (editor.state.selection.empty) editor.chain().focus().insertContent({ type: 'text', text: address, marks: [{ type: 'link', attrs: { href } }] }).run();
    else editor.chain().focus().setLink({ href }).run();
  };

  // ⌘F: the find bar, for the editor the press belongs to. With the caret in another editor that one
  // takes it; with the caret nowhere, the first editor on screen that anybody could click.
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    if (compact) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
      const here = root.current;
      const usable = (el: HTMLElement) => el.checkVisibility?.() !== false && getComputedStyle(el).pointerEvents !== 'none';
      if (!here || !usable(here)) return;
      const target = event.target instanceof Element ? event.target.closest('.ed') : null;
      if (target && target !== here) return;
      if (!target && [...document.querySelectorAll<HTMLElement>('.ed:not(.compact)')].find(usable) !== here) return;
      event.preventDefault();
      setFinding(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [compact]);

  // A click under the last line, in the scroller's own space, keeps writing at the end.
  const below = (event: MouseEvent) => {
    if (!editor || event.target !== event.currentTarget || event.clientY <= editor.view.dom.getBoundingClientRect().bottom) return;
    event.preventDefault();
    editor.commands.focus('end');
  };

  return <div ref={root} className={`ed${compact ? ' compact' : ''}`}>
    {!compact && editor && <div className="ed-bar">
      <div className="ed-tools">
        <Toolbar editor={editor} onImage={notePath ? () => files.current?.click() : undefined} onLink={() => linkRef.current()} />
        {bar && <span className="ed-tail">{bar}</span>}
      </div>
      {finding && <FindBar editor={editor} onClose={() => setFinding(false)} />}
    </div>}
    {editor && <Bubble editor={editor} onLink={() => linkRef.current()} />}
    <div ref={wrap} className="ed-content" onMouseDown={below}>
      {!compact && editor && <TableControls editor={editor} wrap={wrap} />}
      {!compact && editor && <BlockHandles editor={editor} wrap={wrap} />}
      <EditorContent editor={editor} className="ed-doc" />
    </div>
    {linking && <Menu plain keep={false} anchor={() => linking.rect} label="Link" onClose={() => { setLinking(null); editor?.commands.focus(); }}>
      <form className="ed-link" onSubmit={event => { event.preventDefault(); setLink(linking.href); }}>
        <Icon name="link" size={14} />
        <input autoFocus value={linking.href} placeholder="Paste or type a link" aria-label="Link address" spellCheck={false} onChange={event => setLinking({ ...linking, href: event.target.value })} />
        <button type="submit" className="ed-tool" aria-label="Add link" title="Add link"><Icon name="check" size={14} /></button>
      </form>
    </Menu>}
    {notePath && <input ref={files} type="file" accept="image/*" hidden aria-label="Add a picture" onChange={event => { const file = event.target.files?.[0]; if (file && editorRef.current) void attach(editorRef.current, file).catch(() => {}); event.target.value = ''; }} />}
  </div>;
}

/// Business's CodeBlockView: the highlighted code with a language picker tucked into its corner, shown
/// on hover. The language is the fence's info string, so it is kept in the file.
function CodeBlockView({ node, updateAttributes, extension }: NodeViewProps) {
  const languages = ((extension.options.lowlight as { listLanguages: () => string[] } | undefined)?.listLanguages() ?? []).slice().sort();
  const current = (node.attrs.language as string) || 'auto';
  return <NodeViewWrapper className="ed-codeblock">
    <span className="ed-codeblock-lang" contentEditable={false} onMouseDown={event => event.stopPropagation()}>
      <Select label="Language" value={current} options={[{ value: 'auto', label: 'auto' }, ...languages.map(language => ({ value: language, label: language }))]}
        onChange={language => updateAttributes({ language: language === 'auto' ? null : language })} />
    </span>
    <pre spellCheck={false}><NodeViewContent<'code'> as="code" /></pre>
  </NodeViewWrapper>;
}
