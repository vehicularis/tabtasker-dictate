import type { Editor } from '@tiptap/core';
import { Fragment, type Mark, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

// The selection's text transforms, as TabTasker Business runs them from its selection bar: the string
// rules of lib/toolbox/text and the editor half of textTransforms.ts. See those files for why each rule is
// shaped the way it is; what is here is the code.

// ---- the string rules (lib/toolbox/text) ----

const isAcronym = (word: string) => word.length > 1 && word === word.toUpperCase();
export function changeCase(input: string, mode: 'upper' | 'lower' | 'title' | 'sentence'): string {
  if (mode === 'upper') return input.toUpperCase();
  if (mode === 'lower') return input.toLowerCase();
  // Title case keeps an acronym ("the PDF export" stays "The PDF Export").
  if (mode === 'title') return input.replace(/\p{L}+/gu, word => isAcronym(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return input.toLowerCase().replace(/(^\s*\p{L})|([.!?]\s+)(\p{L})/gu, (_match, first, punct, letter) => first ? first.toUpperCase() : punct + letter.toUpperCase());
}
const lines = (input: string) => input.replace(/\r\n|\r/g, '\n');
/// Runs of spaces to one, three or more line breaks to one blank line.
export const tidySpacing = (input: string) => lines(input.replace(/[ \t]+/g, ' ')).replace(/\n{3,}/g, '\n\n');
export function sortLines(input: string): string {
  const text = lines(input), trailing = text.endsWith('\n');
  const sorted = (trailing ? text.slice(0, -1) : text).split('\n').sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join('\n');
  return trailing ? `${sorted}\n` : sorted;
}
export const dedupeLines = (input: string) => [...new Set(lines(input).split('\n'))].join('\n');
const SLUG_TRANSLITERATIONS: Record<string, string> = { 'ı': 'i', 'ß': 'ss' };
export function slugify(input: string): string {
  let base = input.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const [char, replacement] of Object.entries(SLUG_TRANSLITERATIONS)) base = base.replaceAll(char, replacement);
  return base.replace(/['’]/g, '').replace(/[^a-z0-9\s-]+/g, '').trim().replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---- over the editor (textTransforms.ts) ----

/// Rewrites the selected TEXT in place, node by node, each keeping its own marks, so a transform never
/// flattens the paragraphs or drops the bold. The selection is read as one string (blocks as lines) so
/// sentence case sees the whole sentence; a transform that changes the length is run per node instead.
export function applyToSelection(editor: Editor, fn: (s: string) => string): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  const slices: { from: number; to: number; text: string; marks: readonly Mark[] }[] = [];
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return;
    const start = Math.max(pos, from), end = Math.min(pos + node.nodeSize, to);
    if (end > start) slices.push({ from: start, to: end, text: node.text.slice(start - pos, end - pos), marks: node.marks });
  });
  if (!slices.length) return false;
  let joined = '', prevTo = -1;
  const offsets: number[] = [];
  for (const slice of slices) {
    if (prevTo >= 0 && slice.from > prevTo) joined += '\n';
    offsets.push(joined.length);
    joined += slice.text;
    prevTo = slice.to;
  }
  const transformed = fn(joined);
  const parts = transformed.length === joined.length
    ? slices.map((slice, i) => transformed.slice(offsets[i], offsets[i] + slice.text.length))
    : slices.map(slice => fn(slice.text));
  const tr = editor.state.tr;
  for (let i = slices.length - 1; i >= 0; i -= 1) {
    const slice = slices[i], text = parts[i];
    if (text === '') tr.delete(slice.from, slice.to);
    else tr.replaceWith(slice.from, slice.to, editor.state.schema.text(text, slice.marks));
  }
  if (!tr.docChanged) return false;
  tr.setSelection(TextSelection.create(tr.doc, from, tr.mapping.map(to)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/// Reorders the BLOCKS the selection spans (sorting, dropping duplicates): each block moves whole, with
/// its marks. `fn` must hand back a permutation of the lines; anything else changes nothing.
export function applyToBlocks(editor: Editor, fn: (s: string) => string): boolean {
  const { $from, $to } = editor.state.selection;
  const range = $from.blockRange($to);
  if (!range) return false;
  const blocks: PMNode[] = [];
  for (let i = range.startIndex; i < range.endIndex; i += 1) blocks.push(range.parent.child(i));
  if (blocks.length < 2) return false;
  const texts = blocks.map(block => block.textContent);
  const byLine = new Map<string, PMNode[]>();
  texts.forEach((line, i) => byLine.set(line, [...(byLine.get(line) ?? []), blocks[i]]));
  const next: PMNode[] = [];
  for (const line of fn(texts.join('\n')).split(/\r?\n/)) {
    const queue = byLine.get(line);
    if (!queue?.length) return false;
    next.push(queue.shift()!);
  }
  if (next.length === blocks.length && next.every((node, i) => node === blocks[i])) return false;
  const content = Fragment.fromArray(next);
  const tr = editor.state.tr.replaceWith(range.start, range.end, content);
  tr.setSelection(TextSelection.between(tr.doc.resolve(range.start), tr.doc.resolve(range.start + content.size)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

export const TRANSFORMS: readonly { label: string; run: (s: string) => string }[] = [
  { label: 'UPPERCASE', run: s => changeCase(s, 'upper') },
  { label: 'lowercase', run: s => changeCase(s, 'lower') },
  { label: 'Title Case', run: s => changeCase(s, 'title') },
  { label: 'Sentence case', run: s => changeCase(s, 'sentence') },
  { label: 'Tidy spacing', run: tidySpacing },
  { label: 'Slugify', run: slugify },
];
export const BLOCK_TRANSFORMS: readonly { label: string; run: (s: string) => string }[] = [
  { label: 'Sort lines A → Z', run: sortLines },
  { label: 'Remove duplicate lines', run: dedupeLines },
];
