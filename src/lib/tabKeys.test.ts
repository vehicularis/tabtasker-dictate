import { describe, expect, it } from 'vitest';
import { tabKey } from './tabKeys';

// `key` is what a non-US layout prints; only `code` counts, so every event carries a `key` that does not match it.
// A real KeyboardEvent has more fields than tabKey reads; a variable keeps the extra `key` from tripping the literal check.
const event = (code: string, mods = '', key = 'ŧ') => ({ key, code, metaKey: mods.includes('m'), ctrlKey: mods.includes('c'), altKey: mods.includes('a'), shiftKey: mods.includes('s') });

const press = (code: string, mods = '', key?: string) => tabKey(event(code, mods, key));

describe('tabKey', () => {
  it.each([
    ['Tab', 'c', 'next'], ['Tab', 'cs', 'prev'],
    ['BracketRight', 'ms', 'next'], ['BracketLeft', 'ms', 'prev'],
    ['ArrowRight', 'ma', 'next'], ['ArrowLeft', 'ma', 'prev'],
    ['ArrowRight', 'mas', 'right'], ['ArrowLeft', 'mas', 'left'],
    ['BracketLeft', 'm', 'back'], ['BracketRight', 'm', 'forward'], ['Comma', 'm', 'settings'],
    ['KeyT', 'm', 'new'], ['KeyT', 'ms', 'reopen'], ['KeyW', 'm', 'close'], ['KeyW', 'ms', 'window'],
  ])('%s with %s is %s', (code, mods, action) => expect(press(code, mods)).toBe(action));

  it('selects tabs 1 to 9', () => {
    for (let n = 1; n <= 9; n++) expect(press(`Digit${n}`, 'm')).toBe(`select:${n}`);
  });

  it.each([
    ['Digit0', 'm'], ['KeyT', 'mc'], ['KeyT', ''], ['Tab', 'mc'], ['Tab', 'ca'], ['Tab', ''], ['Digit1', 'ms'], ['Digit1', 'ma'], ['BracketLeft', 'ma'], ['Comma', 'ms'],
  ])('%s with %s is nothing', (code, mods) => expect(press(code, mods)).toBeNull());

  it('ignores the printed key', () => {
    expect(press('KeyT', 'm', 'q')).toBe('new');
    expect(press('KeyT', 'm', 'ŧ')).toBe('new');
  });
});
