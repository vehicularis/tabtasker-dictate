import type { CommandKey, DictateKey } from '../store';

/// How each dictate key reads in a sentence and on a key cap.
export const KEY_NAMES: Record<DictateKey, string> = { fn: 'fn', rightCommand: 'right ⌘', rightOption: 'right ⌥', rightControl: 'right ⌃', rightShift: 'right ⇧' };
/// The key held with the dictate key to ask AI, as its glyph.
export const COMMAND_GLYPHS: Record<Exclude<CommandKey, 'off'>, string> = { control: '⌃', option: '⌥', command: '⌘', shift: '⇧' };
/// What the globe key does instead of nothing (Status.globeKey), as setup says it.
export const GLOBE = { inputSource: 'changes the input source', emoji: 'opens emoji', dictation: 'starts Dictation' } as const;
