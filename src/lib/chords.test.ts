import { describe, expect, it } from 'vitest';
import { MACOS_SHORTCUTS, MODIFIERS, chordOf, chordProblem, reserved } from './chords';
import type { Chord, Status } from '../api/types';

const { control, option, shift, command } = MODIFIERS;
const chord = (keyCode: number, modifiers: number, label = 'K'): Chord => ({ keyCode, modifiers, label });
const press = (code: string, held: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...held });

describe('chordProblem', () => {
  it('takes a key with ⌘, ⌥ or ⌃', () => {
    expect(chordProblem(chord(40, command))).toBeNull();
    expect(chordProblem(chord(40, option | shift))).toBeNull();
    expect(chordProblem(chord(40, control))).toBeNull();
  });
  it('takes a function key alone', () => {
    expect(chordProblem(chord(122, 0, 'F1'))).toBeNull();
    expect(chordProblem(chord(90, shift, 'F20'))).toBeNull();
  });
  it.each([122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90])('takes function key code %i alone', code => {
    expect(chordProblem(chord(code, 0, 'F'))).toBeNull();
  });
  it('does not take a key code next to a function key', () => {
    expect(chordProblem(chord(121, 0))).toBe('Add ⌘, ⌥ or ⌃ to it');
  });
  it('asks for ⌘, ⌥ or ⌃ on a plain key or one with only ⇧', () => {
    expect(chordProblem(chord(40, 0))).toBe('Add ⌘, ⌥ or ⌃ to it');
    expect(chordProblem(chord(40, shift))).toBe('Add ⌘, ⌥ or ⌃ to it');
  });
  it('refuses a key code that is not an integer in 0 to 127', () => {
    expect(chordProblem(chord(-1, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(128, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(1.5, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(NaN, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(0, command))).toBeNull();
    expect(chordProblem(chord(127, command))).toBeNull();
  });
  it('refuses modifiers that are not integers or hold other bits', () => {
    expect(chordProblem(chord(40, 1))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(40, command | 1))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(40, 0.5))).toBe('That key can’t be a shortcut');
  });
  it('refuses a label that is empty, blank or not a string', () => {
    expect(chordProblem(chord(40, command, ''))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(40, command, '  '))).toBe('That key can’t be a shortcut');
    expect(chordProblem({ keyCode: 40, modifiers: command, label: 5 as unknown as string })).toBe('That key can’t be a shortcut');
  });
  it('refuses a chord another shortcut uses, by name', () => {
    const others = [{ name: 'Take a note', chord: chord(45, command | shift) }];
    expect(chordProblem(chord(45, command | shift), others)).toBe('Already used for “Take a note”');
  });
  it('says the other shortcut\'s own reason when it has one', () => {
    const others = [{ name: 'Spotlight', chord: chord(49, command), reason: 'The Mac keeps ⌘Space' }];
    expect(chordProblem(chord(49, command), others)).toBe('The Mac keeps ⌘Space');
  });
  it('does not mind the same key with other modifiers, or others with no chord', () => {
    const others = [{ name: 'A', chord: chord(45, command) }, { name: 'B', chord: null }];
    expect(chordProblem(chord(45, command | option), others)).toBeNull();
    expect(chordProblem(chord(46, command), others)).toBeNull();
  });
  it('checks the rules before the conflicts', () => {
    const others = [{ name: 'A', chord: chord(40, 0) }];
    expect(chordProblem(chord(40, 0), others)).toBe('Add ⌘, ⌥ or ⌃ to it');
  });
});

describe('chordOf', () => {
  it('makes a letter with each modifier into its key code, mask and label', () => {
    expect(chordOf(press('KeyK', { metaKey: true }))).toEqual({ keyCode: 40, modifiers: command, label: '⌘K' });
    expect(chordOf(press('KeyK', { altKey: true }))).toEqual({ keyCode: 40, modifiers: option, label: '⌥K' });
    expect(chordOf(press('KeyK', { ctrlKey: true }))).toEqual({ keyCode: 40, modifiers: control, label: '⌃K' });
    expect(chordOf(press('KeyK', { metaKey: true, shiftKey: true }))).toEqual({ keyCode: 40, modifiers: command | shift, label: '⇧⌘K' });
  });
  it('writes the glyphs as ⌃⌥⇧⌘ whatever order they were held', () => {
    const all = chordOf(press('KeyA', { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }));
    expect(all).toEqual({ keyCode: 0, modifiers: control | option | shift | command, label: '⌃⌥⇧⌘A' });
    expect(chordOf(press('KeyA', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }))).toEqual(all);
  });
  it('is null for shift alone with a letter, which only types a capital', () => {
    expect(chordOf(press('KeyK', { shiftKey: true }))).toBeNull();
    expect(chordOf(press('KeyK'))).toBeNull();
  });
  it('takes a function key on its own', () => {
    expect(chordOf(press('F5'))).toEqual({ keyCode: 96, modifiers: 0, label: 'F5' });
  });
  it('is null for a code it does not know', () => {
    expect(chordOf(press('IntlBackslash', { metaKey: true }))).toBeNull();
    expect(chordOf(press('', { metaKey: true }))).toBeNull();
  });
  it('goes by code, not by key, so another layout acts the same', () => {
    const event = { ...press('KeyQ', { metaKey: true }), key: 'a' };
    expect(chordOf(event)).toEqual({ keyCode: 12, modifiers: command, label: '⌘Q' });
  });
});

describe('reserved', () => {
  const names = (taken: { name: string }[]) => taken.map(item => item.name);
  it('without a status is the static macOS list, then the apps’ own', () => {
    const list = reserved(null);
    expect(list.slice(0, MACOS_SHORTCUTS.length).map(item => [item.chord.keyCode, item.chord.modifiers, item.name])).toEqual(MACOS_SHORTCUTS);
    expect(names(list)).toContain('Spotlight');
    expect(names(list)).toContain('Copy');
    expect(list.length).toBe(MACOS_SHORTCUTS.length + 26);
  });
  it('with a status uses the shortcuts the Mac reports, named when known and with a reason when not', () => {
    const status = { systemShortcuts: [[49, command], [40, control | option | shift]] } as unknown as Status;
    const list = reserved(status);
    expect(list.slice(0, 2)).toEqual([
      { name: 'Spotlight', chord: { keyCode: 49, modifiers: command, label: 'Spotlight' } },
      { name: 'macOS', chord: { keyCode: 40, modifiers: control | option | shift, label: 'macOS' }, reason: 'macOS already uses this shortcut' },
    ]);
    expect(names(list)).not.toContain('Force Quit');
    expect(names(list)).toContain('Paste');
    expect(list.length).toBe(2 + 26);
  });
  it('refuses a reported shortcut through chordProblem', () => {
    expect(chordProblem(chord(49, command), reserved(null))).toBe('Already used for “Spotlight”');
  });
});
