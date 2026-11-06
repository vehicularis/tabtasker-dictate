import { describe, expect, it } from 'vitest';
import { message } from './errors';

describe('message', () => {
  it('gives a string error as it is, whatever the fallback', () => {
    expect(message('No microphone', 'Could not start')).toBe('No microphone');
    expect(message('', 'Could not start')).toBe('');
  });
  it('gives the fallback for an Error (only the native side\'s strings are words for people)', () => {
    expect(message(new Error('boom'), 'Could not start')).toBe('Could not start');
  });
  it('gives the fallback for undefined, null and an object', () => {
    expect(message(undefined, 'Could not start')).toBe('Could not start');
    expect(message(null, 'Could not start')).toBe('Could not start');
    expect(message({ message: 'boom' }, 'Could not start')).toBe('Could not start');
  });
  it('gives an empty fallback as it is', () => {
    expect(message(undefined, '')).toBe('');
    expect(message({}, '')).toBe('');
    expect(message(new Error('boom'), '')).toBe('');
  });
});
