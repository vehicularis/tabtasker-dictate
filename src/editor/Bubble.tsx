import { useRef, useState } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { isNodeRangeSelection } from '@tiptap/extension-node-range';
import { Icon } from '../ui/Icon';
import { keep, Menu, MenuItem, MenuKeys, MenuLine } from './Menu';
import { applyToBlocks, applyToSelection, BLOCK_TRANSFORMS, TRANSFORMS } from './textTransforms';
import { Tool } from './Toolbar';

/// Business's BubbleToolbar: over a text selection, Bold, Italic, Highlight, Link and the text
/// transforms. Text selections only: a whole row or column is a table grip's click with its own menu
/// open, a whole block is a drag handle's pick-up, and code takes no formatting.
export function Bubble({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const fmt = useEditorState({
    editor,
    selector: ({ editor }) => ({ bold: editor.isActive('bold'), italic: editor.isActive('italic'), highlight: editor.isActive('highlight'), link: editor.isActive('link') }),
  });
  const chain = () => editor.chain().focus();
  return <BubbleMenu editor={editor} className="ed-bubble" shouldShow={({ editor }) => {
    const { selection } = editor.state;
    return editor.isEditable && !selection.empty && !(selection instanceof CellSelection) && !(selection instanceof NodeSelection) && !isNodeRangeSelection(selection) && !editor.isActive('codeBlock');
  }}>
    <Tool action={{ id: 'bold', label: 'Bold (⌘B)', icon: <Icon name="bold" size={16} />, active: fmt?.bold, run: () => chain().toggleBold().run() }} />
    <Tool action={{ id: 'italic', label: 'Italic (⌘I)', icon: <Icon name="italic" size={16} />, active: fmt?.italic, run: () => chain().toggleItalic().run() }} />
    <Tool action={{ id: 'highlight', label: 'Highlight (⌘⇧H)', icon: <Icon name="highlight" size={16} />, active: fmt?.highlight, run: () => chain().toggleHighlight().run() }} />
    <Tool action={{ id: 'link', label: fmt?.link ? 'Remove link (⌘K)' : 'Link (⌘K)', icon: <Icon name="link" size={16} />, active: fmt?.link, run: onLink }} />
    <TransformMenu editor={editor} />
  </BubbleMenu>;
}

/// Business's TransformMenu: case and spacing rewrite the text in place; the two below the line move
/// whole blocks, which is why they are apart.
function TransformMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState<{ keyboard: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const run = (apply: typeof applyToSelection, fn: (s: string) => string) => { apply(editor, fn); setOpen(null); };
  return <>
    <button ref={trigger} type="button" className="ed-tool" aria-label="Transform text" title="Transform text" aria-haspopup="menu" aria-expanded={!!open}
      onMouseDown={keep} onClick={event => setOpen(now => now ? null : { keyboard: event.detail === 0 })}>
      <span className="ed-glyph">Aa</span>
    </button>
    {open && trigger.current && <Menu anchor={trigger.current} label="Transform text" focus={open.keyboard} onClose={() => setOpen(null)}>
      {TRANSFORMS.map(({ label, run: fn }) => <MenuItem key={label} onSelect={() => run(applyToSelection, fn)}>{label}</MenuItem>)}
      <MenuLine />
      {BLOCK_TRANSFORMS.map(({ label, run: fn }) => <MenuItem key={label} onSelect={() => run(applyToBlocks, fn)}>{label}</MenuItem>)}
      <MenuKeys />
    </Menu>}
  </>;
}
