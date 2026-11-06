import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY, dateOf, dayTitle, listGroup, listWhen, localDay, stamp } from './dates';

// The local day number of a calendar date, written without the code under test.
const num = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY;
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

afterEach(() => vi.useRealTimers());

describe('localDay', () => {
  it('counts days since 1970-01-01 in the Mac\'s zone', () => {
    expect(localDay(at(2026, 1, 1))).toBe(num(2026, 1, 1));
    expect(localDay(0)).toBe(-1); // 19:00 on 31 Dec 1969 in New York
  });
  it('keeps 00:30 and 23:30 on their own local day', () => {
    expect(localDay(at(2026, 6, 15, 0, 30))).toBe(num(2026, 6, 15));
    expect(localDay(at(2026, 6, 15, 23, 30))).toBe(num(2026, 6, 15));
    expect(localDay(at(2026, 6, 16, 0, 30))).toBe(num(2026, 6, 16));
  });
  it('is not the UTC day: 23:30 in New York is already tomorrow in UTC', () => {
    expect(new Date(at(2026, 6, 15, 23, 30)).getUTCDate()).toBe(16);
    expect(localDay(at(2026, 6, 15, 23, 30))).toBe(num(2026, 6, 15));
  });
  it('steps one day across the March DST switch (23 hour day)', () => {
    expect(localDay(at(2026, 3, 8, 0, 30))).toBe(num(2026, 3, 8));
    expect(localDay(at(2026, 3, 8, 23, 30))).toBe(num(2026, 3, 8));
    expect(localDay(at(2026, 3, 9, 0, 30))).toBe(num(2026, 3, 9));
  });
  it('steps one day across the November DST switch (25 hour day)', () => {
    expect(localDay(at(2026, 11, 1, 0, 30))).toBe(num(2026, 11, 1));
    expect(localDay(at(2026, 11, 1, 23, 30))).toBe(num(2026, 11, 1));
    expect(localDay(at(2026, 11, 2, 0, 30))).toBe(num(2026, 11, 2));
  });
  it('steps from 31 Dec to 1 Jan', () => {
    expect(localDay(at(2026, 12, 31, 23, 30))).toBe(num(2026, 12, 31));
    expect(localDay(at(2027, 1, 1, 0, 30))).toBe(num(2027, 1, 1));
    expect(num(2027, 1, 1) - num(2026, 12, 31)).toBe(1);
  });
});

describe('dateOf', () => {
  it('writes a day number as its date in the given options', () => {
    expect(dateOf(num(2026, 3, 8), { year: 'numeric' })).toBe('2026');
    expect(dateOf(num(2026, 3, 8), { weekday: 'long' })).toBe('Sunday');
    expect(dateOf(num(2026, 3, 8), { month: 'short', day: 'numeric' })).toBe('Mar 8');
    expect(dateOf(num(2026, 11, 1), { month: 'long', day: 'numeric', year: 'numeric' })).toBe('November 1, 2026');
  });
  it('reads the number as UTC, so the Mac\'s zone cannot move the date', () => {
    expect(dateOf(num(2026, 12, 31), { day: 'numeric', month: 'numeric', year: 'numeric' })).toBe('12/31/2026');
    expect(dateOf(num(2027, 1, 1), { day: 'numeric', month: 'numeric', year: 'numeric' })).toBe('1/1/2027');
  });
});

describe('dayTitle', () => {
  const today = num(2026, 6, 15);
  it('says Today and Yesterday', () => {
    expect(dayTitle(today, today)).toBe('Today');
    expect(dayTitle(today - 1, today)).toBe('Yesterday');
  });
  it('gives the weekday and date, without the year in this year', () => {
    expect(dayTitle(today - 2, today)).toBe('Saturday, June 13');
    expect(dayTitle(num(2026, 1, 1), today)).toBe('Thursday, January 1');
  });
  it('adds the year when it is not this one', () => {
    expect(dayTitle(num(2025, 12, 31), num(2026, 1, 1) + 5)).toBe('Wednesday, December 31, 2025');
  });
  it('says Yesterday across the new year and the DST days', () => {
    expect(dayTitle(num(2026, 12, 31), num(2027, 1, 1))).toBe('Yesterday');
    expect(dayTitle(num(2026, 3, 8), num(2026, 3, 9))).toBe('Yesterday');
    expect(dayTitle(num(2026, 11, 1), num(2026, 11, 2))).toBe('Yesterday');
  });
  it('treats a future day as a date (only today and yesterday are named)', () => {
    // Today's behaviour; see the report.
    expect(dayTitle(today + 1, today)).toBe('Tuesday, June 16');
  });
});

describe('listGroup', () => {
  const today = num(2026, 6, 15);
  it('groups today, and anything later, as Today', () => {
    expect(listGroup(today, today)).toBe('Today');
    // Today's behaviour; see the report.
    expect(listGroup(today + 3, today)).toBe('Today');
  });
  it('groups yesterday', () => expect(listGroup(today - 1, today)).toBe('Yesterday'));
  it('groups 2 to 7 days back as the previous 7 days', () => {
    expect(listGroup(today - 2, today)).toBe('Previous 7 days');
    expect(listGroup(today - 7, today)).toBe('Previous 7 days');
  });
  it('groups 8 to 30 days back as the previous 30 days', () => {
    expect(listGroup(today - 8, today)).toBe('Previous 30 days');
    expect(listGroup(today - 30, today)).toBe('Previous 30 days');
  });
  it('then groups by month, with the year when it is not this one', () => {
    expect(listGroup(today - 31, today)).toBe('May');
    expect(listGroup(num(2026, 1, 2), today)).toBe('January');
    expect(listGroup(num(2025, 12, 31), today)).toBe('December 2025');
  });
  it('groups across the new year and the DST days', () => {
    expect(listGroup(num(2026, 12, 31), num(2027, 1, 1))).toBe('Yesterday');
    expect(listGroup(num(2026, 3, 8), num(2026, 3, 9))).toBe('Yesterday');
    expect(listGroup(num(2026, 11, 1), num(2026, 11, 2))).toBe('Yesterday');
    expect(listGroup(num(2026, 12, 25), num(2027, 1, 1))).toBe('Previous 7 days');
  });
});

describe('listWhen', () => {
  const today = num(2026, 6, 15);
  it('gives the time for today, at 00:30 and 23:30', () => {
    expect(listWhen(at(2026, 6, 15, 0, 30), today)).toBe('12:30 AM');
    expect(listWhen(at(2026, 6, 15, 23, 30), today)).toBe('11:30 PM');
    expect(listWhen(at(2026, 6, 15, 9, 5), today)).toBe('9:05 AM');
  });
  it('gives the time for a later day too', () => {
    // Today's behaviour; see the report.
    expect(listWhen(at(2026, 6, 17, 14, 0), today)).toBe('2:00 PM');
  });
  it('says Yesterday', () => {
    expect(listWhen(at(2026, 6, 14, 23, 30), today)).toBe('Yesterday');
    expect(listWhen(at(2026, 6, 14, 0, 30), today)).toBe('Yesterday');
  });
  it('gives the weekday for the last 2 to 7 days', () => {
    expect(listWhen(at(2026, 6, 13, 12), today)).toBe('Saturday');
    expect(listWhen(at(2026, 6, 8, 12), today)).toBe('Monday');
  });
  it('gives a short date beyond that, with the year when it is not this one', () => {
    expect(listWhen(at(2026, 6, 7, 12), today)).toBe('Jun 7');
    expect(listWhen(at(2026, 1, 2, 12), today)).toBe('Jan 2');
    expect(listWhen(at(2025, 12, 31, 12), today)).toBe('Dec 31, 2025');
  });
  it('lands on the right day across the DST switches and the new year', () => {
    expect(listWhen(at(2026, 3, 8, 0, 30), num(2026, 3, 9))).toBe('Yesterday');
    expect(listWhen(at(2026, 3, 9, 0, 30), num(2026, 3, 9))).toBe('12:30 AM');
    expect(listWhen(at(2026, 11, 1, 23, 30), num(2026, 11, 2))).toBe('Yesterday');
    expect(listWhen(at(2026, 11, 2, 0, 30), num(2026, 11, 2))).toBe('12:30 AM');
    expect(listWhen(at(2026, 12, 31, 23, 30), num(2027, 1, 1))).toBe('Yesterday');
    expect(listWhen(at(2027, 1, 1, 0, 30), num(2027, 1, 1))).toBe('12:30 AM');
  });
});

describe('stamp', () => {
  it('writes the local time as YYYY-MM-DD HH.mm, padded', () => {
    expect(stamp(new Date(2026, 0, 5, 3, 7))).toBe('2026-01-05 03.07');
    expect(stamp(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31 23.59');
  });
  it('uses the local day at 00:30 and 23:30', () => {
    expect(stamp(new Date(2026, 5, 15, 0, 30))).toBe('2026-06-15 00.30');
    expect(stamp(new Date(2026, 5, 15, 23, 30))).toBe('2026-06-15 23.30');
  });
  it('follows the clock across the DST switches', () => {
    expect(stamp(new Date(2026, 2, 8, 3, 30))).toBe('2026-03-08 03.30');
    expect(stamp(new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01 01.30'); // the first 1:30, EDT
    expect(stamp(new Date('2026-11-01T06:30:00Z'))).toBe('2026-11-01 01.30'); // the second, EST
  });
  it('crosses the new year', () => {
    expect(stamp(new Date(2027, 0, 1, 0, 30))).toBe('2027-01-01 00.30');
  });
  it('defaults to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 4, 8, 9));
    expect(stamp()).toBe('2026-07-04 08.09');
  });
});

describe('with a faked clock', () => {
  it('localDay of now follows setSystemTime', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 23, 30));
    expect(localDay(Date.now())).toBe(num(2026, 6, 15));
    vi.setSystemTime(new Date(2026, 5, 16, 0, 30));
    expect(localDay(Date.now())).toBe(num(2026, 6, 16));
  });
});
