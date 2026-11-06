import { describe, expect, it } from 'vitest';
import { tabKey } from './tabKeys';

// `key` is what a non-US layout prints (here a Turkish one); only `code` counts, so it is left out of the event.
const press = (code: string, mods = '') => tabKey({ code, metaKey: mods.includes('m'), ctrlKey: mods.includes('c'), altKey: mods.includes('a'), shiftKey: mods.includes('s') });

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
    ['Digit0', 'm'], ['KeyT', 'mc'], ['KeyT', ''], ['Tab', 'mc'], ['Tab', ''], ['Digit1', 'ms'], ['Digit1', 'ma'], ['BracketLeft', 'ma'], ['Comma', 'ms'],
  ])('%s with %s is nothing', (code, mods) => expect(press(code, mods)).toBeNull());

  it('ignores the printed key', () => {
    expect(tabKey({ code: 'KeyT', key: 'ŧ', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as Parameters<typeof tabKey>[0])).toBe('new');
  });
});
