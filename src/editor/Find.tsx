import { useEffect, useRef, useState } from 'react';
import { Extension } from '@tiptap/core';
import { useEditorState, type Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Button } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Tool } from './Toolbar';
import { BOUNDARY, findMatches as findText, wrap, type FindMatch, type FindSegment } from '../lib/find';

// Find and replace, as TabTasker Business's Atlas pages have it (findReplace.ts, FindReplaceBar.tsx): a
// decoration plugin over the document, and the bar under the formatting bar. Literal, not a pattern;
// left to right without overlaps; case-folded unless "Aa" is on. A match may cross formatting ("quick
// **brown**") but never a block, a cell or a picture. Nothing is stored: a note saved with the bar
// open is the same file as one saved without it.

interface FindState { query: string; matchCase: boolean; matches: readonly FindMatch[]; active: number }
interface FindMeta { query?: string; matchCase?: boolean; active?: number }

const findKey = new PluginKey<FindState>('findReplace');
const EMPTY: FindState = { query: '', matchCase: false, matches: [], active: 0 };

/** The whole document as one string, with the table from string offsets back to positions. */
function flatten(doc: PMNode) {
  const parts: string[] = [], segments: FindSegment[] = [];
  let offset = 0;
  doc.descendants((node, pos) => {
    if (node.isText && node.text) { segments.push({ offset, pos, len: node.text.length }); parts.push(node.text); offset += node.text.length; return false; }
    parts.push(BOUNDARY); offset += 1;
    return true;
  });
  return { text: parts.join(''), segments };
}
function findMatches(doc: PMNode, query: string, matchCase: boolean): FindMatch[] {
  if (!query || query.includes(BOUNDARY)) return []; // before the walk: an open bar with nothing typed scans nothing
  const { text, segments } = flatten(doc);
  return findText(text, query, matchCase, segments);
}

export const FindReplace = Extension.create({
  name: 'findReplace',
  addProseMirrorPlugins: () => [new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => EMPTY,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(findKey) as FindMeta | undefined;
        if (!meta && !tr.docChanged) return prev; // a keystroke with no bar open scans nothing
        const query = meta?.query ?? prev.query, matchCase = meta?.matchCase ?? prev.matchCase;
        const matches = findMatches(state.doc, query, matchCase);
        const restart = (meta?.query !== undefined && meta.query !== prev.query) || (meta?.matchCase !== undefined && meta.matchCase !== prev.matchCase);
        return { query, matchCase, matches, active: restart ? 0 : wrap(meta?.active ?? prev.active, matches.length) };
      },
    },
    props: { decorations: (state: EditorState) => {
      const find = findKey.getState(state);
      if (!find?.matches.length) return DecorationSet.empty;
      return DecorationSet.create(state.doc, find.matches.map((match, i) => Decoration.inline(match.from, match.to, {
        class: i === find.active ? 'ed-find-match active' : 'ed-find-match',
        style: `border-radius:2px;background-color:color-mix(in srgb, var(--accent) ${i === find.active ? 55 : 22}%, transparent)`,
      })));
    } },
  })],
});

const findOf = (editor: Editor) => findKey.getState(editor.state) ?? EMPTY;
function dispatchFind(editor: Editor, meta: FindMeta) {
  editor.view.dispatch(editor.state.tr.setMeta(findKey, meta));
  editor.view.dom.querySelector('.ed-find-match.active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
}
const step = (editor: Editor, delta: number) => { const find = findOf(editor); if (find.matches.length) dispatchFind(editor, { active: find.active + delta }); };
/** One match replaced, wearing the marks its first character wore, so a word inside a link stays linked. */
function replaceRange(editor: Editor, tr: Transaction, match: FindMatch, text: string) {
  if (!text) { tr.delete(match.from, match.to); return; }
  tr.replaceWith(match.from, match.to, editor.state.schema.text(text, editor.state.doc.nodeAt(match.from)?.marks ?? []));
}
function replace(editor: Editor, text: string, all: boolean) {
  const find = findOf(editor);
  const matches = all ? find.matches : find.matches.slice(find.active, find.active + 1);
  if (!matches.length) return;
  const tr = editor.state.tr;
  for (let i = matches.length - 1; i >= 0; i -= 1) replaceRange(editor, tr, matches[i], text); // back to front, one undo step
  editor.view.dispatch(tr);
}

/// The bar: Return walks forward, Shift-Return back; Escape clears before it closes, so no highlight
/// is left on a page with nothing to explain it.
export function FindBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const found = useEditorState({ editor, selector: ({ editor }) => { const find = findOf(editor); return { total: find.matches.length, active: find.active }; } });
  useEffect(() => { dispatchFind(editor, { query, matchCase }); }, [editor, query, matchCase]);
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => () => { if (!editor.isDestroyed) dispatchFind(editor, { query: '' }); }, [editor]);
  const close = () => { onClose(); if (!editor.isDestroyed) { dispatchFind(editor, { query: '' }); editor.commands.focus(); } };
  const total = found?.total ?? 0;
  const count = total ? `${(found?.active ?? 0) + 1} of ${total}` : query ? 'No results' : '';
  return <div className="ed-find" role="search" aria-label="Find and replace" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <span className="ed-find-field">
      <Icon name="search" size={14} />
      <input ref={field} className="ui-field" aria-label="Find" placeholder="Find" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(editor, event.shiftKey ? -1 : 1); } }} />
    </span>
    <Tool action={{ id: 'case', label: 'Match case', icon: <span className="ed-glyph">Aa</span>, active: matchCase, run: () => setMatchCase(on => !on) }} />
    <Tool action={{ id: 'prev', label: 'Previous match (⇧↵)', icon: <Icon name="chevronUp" size={16} />, disabled: !total, run: () => step(editor, -1) }} />
    <Tool action={{ id: 'next', label: 'Next match (↵)', icon: <Icon name="chevronDown" size={16} />, disabled: !total, run: () => step(editor, 1) }} />
    <span className="ed-find-count" aria-live="polite">{count}</span>
    <input className="ui-field" aria-label="Replace with" placeholder="Replace with" value={replacement} spellCheck={false} onChange={event => setReplacement(event.target.value)} />
    <Button small disabled={!total} onMouseDown={event => event.preventDefault()} onClick={() => replace(editor, replacement, false)}>Replace</Button>
    <Button small disabled={!total} onMouseDown={event => event.preventDefault()} onClick={() => replace(editor, replacement, true)}>Replace all</Button>
    <span className="ed-find-close"><Tool action={{ id: 'close', label: 'Close (Esc)', icon: <Icon name="close" size={15} />, run: close }} /></span>
  </div>;
}
