import { describe, expect, it } from 'vitest';
import { isUnnamed } from './library';

describe('isUnnamed', () => {
  it('is false for a title someone wrote', () => {
    expect(isUnnamed('Groceries')).toBe(false);
    expect(isUnnamed('Meeting notes')).toBe(false);
    expect(isUnnamed('2026-06-15 Note about lunch')).toBe(false);
  });
  it('is true for nothing, or only spaces', () => {
    expect(isUnnamed('')).toBe(true);
    expect(isUnnamed('   ')).toBe(true);
    expect(isUnnamed('\n\t')).toBe(true);
  });
  it('is true for a date and Note or Meeting', () => {
    expect(isUnnamed('2026-06-15 Note')).toBe(true);
    expect(isUnnamed('2026-06-15 Meeting')).toBe(true);
  });
  it('is true with a time, in one or two digit hours', () => {
    expect(isUnnamed('2026-06-15 9.05 Note')).toBe(true);
    expect(isUnnamed('2026-06-15 14.30 Meeting')).toBe(true);
  });
  it('is true with a number after it', () => {
    expect(isUnnamed('2026-06-15 Note 2')).toBe(true);
    expect(isUnnamed('2026-06-15 14.30 Meeting 12')).toBe(true);
  });
  it('ignores spaces around it', () => {
    expect(isUnnamed('  2026-06-15 Note  ')).toBe(true);
  });
  it('is false for forms it does not recognise', () => {
    expect(isUnnamed('2026-06-15')).toBe(false);
    expect(isUnnamed('2026-06-15 note')).toBe(false); // the match is case sensitive
    expect(isUnnamed('2026-06-15 Notes')).toBe(false);
    expect(isUnnamed('2026-06-15 14:30 Note')).toBe(false);
    expect(isUnnamed('2026-6-15 Note')).toBe(false);
    expect(isUnnamed('2026-06-15 Note 2 copy')).toBe(false);
    expect(isUnnamed('New note')).toBe(false);
  });
});
