import { describe, expect, it } from 'vitest';
import { nameProblem, previewLines, tagOf } from './notes';

describe('nameProblem', () => {
  it('is null for a fine name', () => {
    expect(nameProblem('{date} {title}')).toBeNull();
    expect(nameProblem('')).toBeNull();
    expect(nameProblem('a.b')).toBeNull();
  });
  it('refuses a slash or a colon', () => {
    expect(nameProblem('a/b')).toBe('A file name can’t contain a slash or a colon.');
    expect(nameProblem('{time}:{date}')).toBe('A file name can’t contain a slash or a colon.');
  });
  it('refuses a leading dot, even after spaces', () => {
    expect(nameProblem('.hidden')).toBe('A file name can’t start with a dot, because that would hide the note.');
    expect(nameProblem('  .hidden')).toBe('A file name can’t start with a dot, because that would hide the note.');
  });
  it('says the slash first when both apply', () => expect(nameProblem('.a/b')).toBe('A file name can’t contain a slash or a colon.'));
});

describe('tagOf', () => {
  it('drops leading # signs and joins words with hyphens', () => {
    expect(tagOf('#meeting')).toBe('meeting');
    expect(tagOf('##big idea')).toBe('big-idea');
    expect(tagOf('  a   b  c ')).toBe('a-b-c');
  });
  it('keeps a # inside', () => expect(tagOf('c#')).toBe('c#'));
  it('is empty for nothing, spaces or only hashes', () => {
    expect(tagOf('')).toBe('');
    expect(tagOf('   ')).toBe('');
    expect(tagOf('###')).toBe('');
  });
  it('keeps accents and emoji', () => expect(tagOf('Çay 🍵')).toBe('Çay-🍵'));
});

describe('previewLines', () => {
  it('marks the front matter, fences included, then the heading and body', () => {
    const text = '---\ntags: [a]\n---\n# Title\nbody\n';
    expect(previewLines(text)).toEqual([
      { text: '---', kind: 'meta' }, { text: 'tags: [a]', kind: 'meta' }, { text: '---', kind: 'meta' },
      { text: '# Title', kind: 'heading' }, { text: 'body', kind: 'body' },
    ]);
  });
  it('has no front matter unless the text starts with a fence', () => {
    expect(previewLines('hi\n---\nx')).toEqual([{ text: 'hi', kind: 'body' }, { text: '---', kind: 'body' }, { text: 'x', kind: 'body' }]);
  });
  it('treats an unclosed front matter as all front matter', () => {
    expect(previewLines('---\n# not a heading').map(l => l.kind)).toEqual(['meta', 'meta']);
  });
  it('drops one trailing newline only', () => {
    expect(previewLines('a\n')).toHaveLength(1);
    expect(previewLines('a\n\n')).toEqual([{ text: 'a', kind: 'body' }, { text: '', kind: 'body' }]);
  });
  it('gives one empty body line for empty text', () => expect(previewLines('')).toEqual([{ text: '', kind: 'body' }]));
});
