import { describe, expect, it } from 'vitest';
import { countMessage, same } from './text';

describe('same', () => {
  it('is true for the same word in any case', () => {
    expect(same('Inbox', 'inbox')).toBe(true);
    expect(same('INBOX', 'iNbOx')).toBe(true);
    expect(same('', '')).toBe(true);
  });
  it('is false for different words', () => {
    expect(same('Inbox', 'Outbox')).toBe(false);
    expect(same('Inbox', '')).toBe(false);
  });
  it('does not trim', () => {
    expect(same('Inbox', 'Inbox ')).toBe(false);
  });
  it('folds accents and Turkish letters by toLowerCase, not by collation', () => {
    expect(same('Élan', 'élan')).toBe(true);
    expect(same('Élan', 'Elan')).toBe(false);
    expect(same('İ', 'i̇')).toBe(true); // İ lower-cases to i + combining dot above
    expect(same('I', 'ı')).toBe(false);
    expect(same('a😀B', 'A😀b')).toBe(true);
    expect(same('a😀B', 'a😁B')).toBe(false);
  });
});

describe('countMessage', () => {
  const noun = (n: number) => `${n} note${n === 1 ? '' : 's'}`;
  const archived = (what: string) => `Archived ${what}`;
  it('says it plainly when all were done', () => {
    expect(countMessage(3, 3, archived, noun)).toBe('Archived 3 notes.');
  });
  it('says it for one item, in the singular', () => {
    expect(countMessage(1, 1, archived, noun)).toBe('Archived 1 note.');
  });
  it('says how many of them when only some were done', () => {
    expect(countMessage(2, 3, archived, noun)).toBe('Archived 2 of 3 notes. The rest weren’t changed.');
    expect(countMessage(1, 2, archived, noun)).toBe('Archived 1 of 2 notes. The rest weren’t changed.');
  });
  it('says none of them when none were done', () => {
    expect(countMessage(0, 3, archived, noun)).toBe('Archived 0 of 3 notes. The rest weren’t changed.');
    expect(countMessage(0, 1, archived, noun)).toBe('Archived 0 of 1 note. The rest weren’t changed.');
  });
  it('says nothing for a plain change that all went through, and Changed for the part that did', () => {
    expect(countMessage(2, 2, undefined, noun)).toBeNull();
    expect(countMessage(1, 2, undefined, noun)).toBe('Changed 1 of 2 notes. The rest weren’t changed.');
  });
});
