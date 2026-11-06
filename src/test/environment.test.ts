import { describe, expect, it } from 'vitest';

describe('the test environment', () => {
  it('runs in New York, in US English', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
    expect(new Intl.NumberFormat().resolvedOptions().locale).toBe('en-US');
    expect(new Date(2026, 0, 1).toLocaleDateString()).toBe('1/1/2026');
  });
});
