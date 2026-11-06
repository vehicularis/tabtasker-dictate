import { describe, expect, it } from 'vitest';
import { updateDetail } from './updates';
import type { UpdateState } from '../api/types';

const idle: UpdateState = { current: '0.1.0', busy: false, version: null, ready: false, latest: false, problem: null };

describe('updateDetail', () => {
  it('says nothing before a check has an answer', () => expect(updateDetail(idle)).toBeUndefined());
  it('gives the problem first, whatever else is true', () => {
    expect(updateDetail({ ...idle, problem: 'No network', ready: true, version: '0.2.0', busy: true, latest: true })).toBe('No network');
  });
  it('says a version is ready', () => expect(updateDetail({ ...idle, ready: true, version: '0.2.0' })).toBe('Version 0.2.0 is downloaded and ready.'));
  it('prefers ready over busy', () => expect(updateDetail({ ...idle, ready: true, busy: true, version: '0.2.0' })).toBe('Version 0.2.0 is downloaded and ready.'));
  it('says a download is under way', () => expect(updateDetail({ ...idle, busy: true, version: '0.2.0' })).toBe('Downloading version 0.2.0…'));
  it('says it is checking when busy with no version', () => expect(updateDetail({ ...idle, busy: true })).toBe('Checking for a new version…'));
  it('says up to date', () => expect(updateDetail({ ...idle, latest: true })).toBe('You’re up to date.'));
  it('prefers busy over latest', () => expect(updateDetail({ ...idle, busy: true, latest: true })).toBe('Checking for a new version…'));
});
