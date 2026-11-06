import { describe, expect, it } from 'vitest';
import { countMessage, fold, markedParts, same, searchWords } from './text';

describe('fold', () => {
  it('lower-cases English, so a plain I is still an i', () => {
    expect(fold('Hello WORLD')).toBe('hello world');
    expect(fold('I')).toBe(fold('i'));
    expect(fold('INDIA')).toBe('india');
  });
  it('reads the Turkish İ and ı as i, so a Turkish word is found whichever way it is cased', () => {
    expect(fold('İstanbul')).toBe(fold('istanbul'));
    expect(fold('İSTANBUL')).toBe(fold('istanbul'));
    expect(fold('ILIK')).toBe(fold('ılık'));
    expect(fold('IŞIK')).toBe(fold('ışık'));
  });
  it('keeps accents, Turkish ones included', () => {
    expect(fold('Élan')).toBe('élan');
    expect(fold('élan')).not.toBe(fold('elan'));
    expect(fold('ÇĞÖŞÜ')).toBe('çğöşü');
    expect(fold('şeker')).not.toBe(fold('seker'));
  });
  it('leaves emoji and other scripts alone', () => {
    expect(fold('a😀B')).toBe('a😀b');
    expect(fold('日本 ΣΑΣ')).toBe('日本 σας');
  });
  it('keeps the length of every character, so its offsets are the text’s (Find relies on it)', () => {
    let all = '';
    for (let code = 0; code <= 0x10ffff; code += 1) if (code < 0xd800 || code > 0xdfff) all += String.fromCodePoint(code);
    expect(fold(all).length).toBe(all.length);
  });
});

describe('searchWords', () => {
  it('folds and splits on any whitespace, dropping empties', () => {
    expect(searchWords('  Hello \t WORLD\n')).toEqual(['hello', 'world']);
    expect(searchWords('   ')).toEqual([]);
    expect(searchWords('')).toEqual([]);
  });
  it('folds accented and Turkish capitals', () => expect(searchWords('ÉCOLE İZMİR IŞIK')).toEqual(['école', 'izmir', 'işik']));
});

describe('markedParts', () => {
  it('is the whole text, unmarked, with no words', () => expect(markedParts('Hello', [])).toEqual(['Hello']));
  it('marks every word in any case, keeping the text as written', () => {
    expect(markedParts('Lunch at noon, LUNCH', searchWords('lunch'))).toEqual(['', 'Lunch', ' at noon, ', 'LUNCH', '']);
  });
  it('marks a Turkish word whichever way it is cased', () => {
    expect(markedParts('İstanbul ve ILIK su', searchWords('istanbul ılık'))).toEqual(['', 'İstanbul', ' ve ', 'ILIK', ' su']);
  });
  it('does not mark an unaccented word in an accented one', () => expect(markedParts('Élan', searchWords('elan'))).toEqual(['Élan']));
  it('takes regex characters and emoji literally', () => {
    expect(markedParts('ok 👍 (done) d', searchWords('(done) 👍'))).toEqual(['ok ', '👍', ' ', '(done)', ' d']);
  });
});

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
