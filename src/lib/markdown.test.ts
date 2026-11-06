import { describe, expect, it } from 'vitest';
import { looksLikeMarkdown } from './markdown';

describe('looksLikeMarkdown', () => {
  it('sees a heading of one to six hashes and a space', () => {
    expect(looksLikeMarkdown('# Title')).toBe(true);
    expect(looksLikeMarkdown('###### Small')).toBe(true);
    expect(looksLikeMarkdown('####### Too many')).toBe(false);
    expect(looksLikeMarkdown('#hashtag')).toBe(false);
  });
  it('sees a bullet, numbered or task list, a quote and a fence', () => {
    for (const text of ['- item', '* item', '+ item', '1. item', '12. item', '> quote', '```js\ncode', '- [ ] todo']) expect(looksLikeMarkdown(text)).toBe(true);
  });
  it('sees a marker on any line, not only the first', () => {
    expect(looksLikeMarkdown('Intro\n\n- one\n- two')).toBe(true);
  });
  it('sees bold and a link inside a line', () => {
    expect(looksLikeMarkdown('some **bold** text')).toBe(true);
    expect(looksLikeMarkdown('see [the docs](https://example.com)')).toBe(true);
  });
  it('does not see a table', () => {
    expect(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(false); // Today's behaviour; see the report.
  });
  it('counts a lone pair of stars around a space as bold', () => {
    expect(looksLikeMarkdown('** **')).toBe(true); // Today's behaviour; see the report.
  });
  it('does not see plain prose', () => {
    for (const text of ['', 'Hello world.', '1.5 million', '-5 degrees', 'a * b * c', '[a] (b)', '  - indented', 'bold **across\nlines**']) expect(looksLikeMarkdown(text)).toBe(false);
  });
});
