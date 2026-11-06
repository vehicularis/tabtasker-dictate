import { describe, expect, it } from 'vitest';
import { BLOCK_TRANSFORMS, changeCase, dedupeLines, slugify, sortLines, tidySpacing, TRANSFORMS } from './textTransforms';

describe('changeCase', () => {
  it('upper and lower case the whole text', () => {
    expect(changeCase('Hello World', 'upper')).toBe('HELLO WORLD');
    expect(changeCase('Hello World', 'lower')).toBe('hello world');
    expect(changeCase('', 'upper')).toBe('');
  });
  it('title case keeps an acronym and a lone I', () => {
    expect(changeCase('the NASA launch', 'title')).toBe('The NASA Launch');
    expect(changeCase('the PDF export', 'title')).toBe('The PDF Export');
    expect(changeCase('i am here', 'title')).toBe('I Am Here');
    expect(changeCase('I AM HERE', 'title')).toBe('I AM HERE'); // an all-caps word counts as an acronym
    expect(changeCase('wORD', 'title')).toBe('Word');
  });
  it('title case handles accents and a Turkish dotless i', () => {
    expect(changeCase('élan vital', 'title')).toBe('Élan Vital');
    expect(changeCase('ılık su', 'title')).toBe('Ilık Su');
  });
  it('sentence case capitalises the start and after . ! ?', () => {
    expect(changeCase('HELLO there. how are you? fine! ok', 'sentence')).toBe('Hello there. How are you? Fine! Ok');
    expect(changeCase('  leading space', 'sentence')).toBe('  Leading space');
    expect(changeCase('one.\ntwo', 'sentence')).toBe('One.\nTwo');
    expect(changeCase('', 'sentence')).toBe('');
  });
  it('sentence case lowercases an acronym', () => {
    // Today's behaviour; see the report.
    expect(changeCase('we use NASA data. i like it', 'sentence')).toBe('We use nasa data. I like it');
    expect(changeCase('élan. épée', 'sentence')).toBe('Élan. Épée');
  });
  it('does not throw on emoji, and leaves a sentence after an emoji lowercase', () => {
    // Today's behaviour; see the report.
    expect(changeCase('😀 HELLO', 'sentence')).toBe('😀 hello');
    expect(changeCase('😀 hello', 'title')).toBe('😀 Hello');
    expect(changeCase('😀', 'upper')).toBe('😀');
  });
  it('folds Turkish letters the way JavaScript does', () => {
    // Today's behaviour; see the report.
    expect(changeCase('ılık', 'upper')).toBe('ILIK');
    expect(changeCase('İstanbul', 'lower')).toBe('i̇stanbul'); // i plus a combining dot: one code unit longer
    expect(changeCase('straße', 'upper')).toBe('STRASSE');
  });
});

describe('tidySpacing', () => {
  it('collapses runs of spaces and tabs to one space', () => {
    expect(tidySpacing('a   b\t\tc')).toBe('a b c');
  });
  it('turns three or more line breaks into one blank line, and CRLF into LF', () => {
    expect(tidySpacing('a\n\n\n\nb')).toBe('a\n\nb');
    expect(tidySpacing('a\n\nb')).toBe('a\n\nb');
    expect(tidySpacing('a\r\nb\rc')).toBe('a\nb\nc');
  });
  it('leaves the empty string and edge spaces to the single-space rule', () => {
    expect(tidySpacing('')).toBe('');
    expect(tidySpacing('  a  ')).toBe(' a ');
  });
});

describe('sortLines', () => {
  it('sorts by code unit', () => {
    expect(sortLines('b\na\nc')).toBe('a\nb\nc');
    expect(sortLines('b\nB\na')).toBe('B\na\nb');
    expect(sortLines('é\nz')).toBe('z\né'); // Today's behaviour; see the report.
  });
  it('keeps one trailing newline at the end', () => {
    expect(sortLines('b\na\n')).toBe('a\nb\n');
  });
  it('sorts blank lines first', () => {
    expect(sortLines('b\n\na')).toBe('\na\nb');
    expect(sortLines('b\na\n\n')).toBe('\na\nb\n');
  });
  it('reads CRLF as line breaks, and handles empty input', () => {
    expect(sortLines('b\r\na')).toBe('a\nb');
    expect(sortLines('')).toBe('');
    expect(sortLines('\n')).toBe('\n');
  });
});

describe('dedupeLines', () => {
  it('keeps the first of each line, in order', () => {
    expect(dedupeLines('a\nb\na\nc\nb')).toBe('a\nb\nc');
  });
  it('keeps a single trailing newline, since the empty last piece is one line', () => {
    expect(dedupeLines('a\na\n')).toBe('a\n');
    expect(dedupeLines('a\nb\n')).toBe('a\nb\n');
  });
  it('collapses repeated blank lines to one', () => {
    expect(dedupeLines('a\n\n\nb\n\n')).toBe('a\n\nb');
    expect(dedupeLines('')).toBe('');
  });
});

describe('slugify', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  a -- b  ')).toBe('a-b');
    expect(slugify("Don't stop")).toBe('dont-stop');
    expect(slugify('It’s here')).toBe('its-here');
  });
  it('strips accents', () => {
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('Şişli ğ')).toBe('sisli-g');
  });
  it('transliterates the Turkish dotless ı and the dotted İ, and ß', () => {
    expect(slugify('ılık')).toBe('ilik');
    expect(slugify('İstanbul')).toBe('istanbul');
    expect(slugify('Straße')).toBe('strasse');
  });
  it('drops emoji and letters outside a-z', () => {
    expect(slugify('😀 Party time')).toBe('party-time');
    expect(slugify('日本')).toBe(''); // Today's behaviour; see the report.
  });
  it('gives an empty slug for only punctuation, and for nothing', () => {
    expect(slugify('!!! ... ???')).toBe('');
    expect(slugify('')).toBe('');
  });
});

describe('the menu lists', () => {
  it('runs each labelled rule', () => {
    const by = Object.fromEntries([...TRANSFORMS, ...BLOCK_TRANSFORMS].map(t => [t.label, t.run]));
    expect(by['UPPERCASE']('ab')).toBe('AB');
    expect(by['lowercase']('AB')).toBe('ab');
    expect(by['Title Case']('ab cd')).toBe('Ab Cd');
    expect(by['Sentence case']('AB CD')).toBe('Ab cd');
    expect(by['Tidy spacing']('a  b')).toBe('a b');
    expect(by['Slugify']('A B')).toBe('a-b');
    expect(by['Sort lines A → Z']('b\na')).toBe('a\nb');
    expect(by['Remove duplicate lines']('a\na')).toBe('a');
  });
});
