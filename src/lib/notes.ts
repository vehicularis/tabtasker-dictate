// The notes settings page's rules for names, tags and the preview.
/// The store's rules for a file name, said before it refuses one.
export const nameProblem = (name: string) => /[/:]/.test(name) ? 'A file name can’t contain a slash or a colon.'
  : name.trimStart().startsWith('.') ? 'A file name can’t start with a dot, because that would hide the note.' : null;
/// A tag as the front matter writes it: no leading #, words joined by hyphens.
export const tagOf = (text: string) => text.trim().replace(/^#+/, '').split(/\s+/).filter(Boolean).join('-');
/// The preview's lines, its front matter (`meta`) and headings set apart from the body.
export function previewLines(text: string): { text: string; kind: 'meta' | 'heading' | 'body' }[] {
  let inFront = text.startsWith('---\n');
  return text.replace(/\n$/, '').split('\n').map((line, i) => {
    const kind = inFront ? 'meta' : line.startsWith('#') ? 'heading' : 'body';
    if (inFront && i > 0 && line === '---') inFront = false;
    return { text: line, kind };
  });
}
