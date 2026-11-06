import { describe, expect, it } from 'vitest';
import { noteTitle, routeOf, split } from './routes';

describe('split', () => {
  it('has no argument without a slash', () => expect(split('notes')).toEqual(['notes', null]));
  it('has no argument after a trailing slash', () => expect(split('notes/')).toEqual(['notes', null]));
  it('keeps the whole path after the first slash', () => {
    expect(split('notes//Users/you/Documents/Hello.md')).toEqual(['notes', '/Users/you/Documents/Hello.md']);
  });
});

describe('noteTitle', () => {
  it('drops the stamp with a time', () => expect(noteTitle('/n/2026-11-06 09.30 Standup.md')).toBe('Standup'));
  it('drops the stamp with a date only', () => expect(noteTitle('/n/2026-11-06 Plan.md')).toBe('Plan'));
  it('is empty when only the stamp is left', () => expect(noteTitle('/n/2026-11-06.md')).toBe(''));
  it('keeps a name with no stamp', () => expect(noteTitle('/n/Ideas.md')).toBe('Ideas'));
  it('works on a bare file name', () => expect(noteTitle('Ideas.md')).toBe('Ideas'));
});

describe('routeOf', () => {
  it('is notes when there is no hash', () => expect(routeOf('')).toBe('notes'));
  it('is notes for a bare #', () => expect(routeOf('#')).toBe('notes'));
  it('decodes spaces and slashes', () => expect(routeOf('#notes%2F%2FUsers%2Fyou%2FMy%20Note.md')).toBe('notes//Users/you/My Note.md'));
  it('keeps a malformed escape as it is', () => expect(routeOf('#notes/100%')).toBe('notes/100%'));
});
