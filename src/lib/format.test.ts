import { describe, expect, it } from 'vitest';
import { count, duration, megabytes, percent, seconds } from './format';

describe('count', () => {
  it('uses the one word for exactly 1', () => expect(count(1, 'word')).toBe('1 word'));
  it('adds an s otherwise, and for 0', () => {
    expect(count(0, 'word')).toBe('0 words');
    expect(count(2, 'word')).toBe('2 words');
  });
  it('takes its own many', () => {
    expect(count(1, 'match', 'matches')).toBe('1 match');
    expect(count(3, 'match', 'matches')).toBe('3 matches');
  });
  it('groups thousands', () => expect(count(12_345, 'word')).toBe('12,345 words'));
});

describe('duration', () => {
  it('rounds to minutes under an hour', () => {
    expect(duration(0)).toEqual({ value: '0', unit: 'min' });
    expect(duration(59)).toEqual({ value: '1', unit: 'min' });
    expect(duration(60)).toEqual({ value: '1', unit: 'min' });
    expect(duration(29)).toEqual({ value: '0', unit: 'min' });
    expect(duration(59 * 60)).toEqual({ value: '59', unit: 'min' });
  });
  it('rolls over to hours at 60 min, including by rounding', () => {
    expect(duration(60 * 60)).toEqual({ value: '1', unit: 'h' });
    expect(duration(59 * 60 + 30)).toEqual({ value: '1', unit: 'h' });
  });
  it('adds the minutes left over', () => {
    expect(duration(89 * 60)).toEqual({ value: '1', unit: 'h 29 min' });
    expect(duration(2 * 3600 + 60)).toEqual({ value: '2', unit: 'h 1 min' });
  });
  it('groups thousands of hours', () => expect(duration(1000 * 3600)).toEqual({ value: '1,000', unit: 'h' }));
});

describe('megabytes', () => {
  it('writes MB under a billion bytes', () => {
    expect(megabytes(0)).toBe('0 MB');
    expect(megabytes(466_000_000)).toBe('466 MB');
    expect(megabytes(999_999_999)).toBe('1000 MB');
  });
  it('writes GB with one decimal from a billion', () => {
    expect(megabytes(1e9)).toBe('1.0 GB');
    expect(megabytes(1_620_000_000)).toBe('1.6 GB');
  });
});

describe('percent', () => {
  it('rounds a fraction to a whole percent', () => {
    expect(percent(0)).toBe('0%');
    expect(percent(0.456)).toBe('46%');
    expect(percent(1)).toBe('100%');
  });
});

describe('seconds', () => {
  it('writes milliseconds as seconds with a decimal', () => {
    expect(seconds(0)).toBe('0.0 s');
    expect(seconds(1250)).toBe('1.3 s');
    expect(seconds(12_000)).toBe('12.0 s');
  });
});
