import { describe, expect, it } from 'vitest';
import { same } from './text';

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
    expect(same('😀', '😀')).toBe(true);
  });
});
