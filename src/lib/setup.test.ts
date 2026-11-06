import { describe, expect, it } from 'vitest';
import { missing, needsSetup, setupDone, voiceReady } from './setup';
import type { Status } from '../api/types';

const ready: Status = {
  enabled: true, microphone: 'allowed', accessibility: true, modelReady: true, modelPreparing: false, modelMessage: '', notes: '', openAtLogin: false,
  globeKey: '', inputs: [], input: null, inputInUse: '', systemShortcuts: [],
};

describe('needsSetup', () => {
  it('is false when everything is given', () => expect(needsSetup(ready)).toBe(false));
  it('is true for each thing only the person can do', () => {
    expect(needsSetup({ ...ready, microphone: 'notDetermined' })).toBe(true);
    expect(needsSetup({ ...ready, microphone: 'denied' })).toBe(true);
    expect(needsSetup({ ...ready, accessibility: false })).toBe(true);
    expect(needsSetup({ ...ready, enabled: false })).toBe(true);
    expect(needsSetup({ ...ready, modelReady: false })).toBe(true);
  });
  it('is false while the model is loading or downloading: that passes by itself', () => {
    expect(needsSetup({ ...ready, modelReady: false, modelPreparing: true })).toBe(false);
  });
});

describe('setupDone', () => {
  it('is false before the status arrives', () => expect(setupDone(null)).toBe(false));
  it('is true when everything is in place', () => expect(setupDone(ready)).toBe(true));
  it('is false when any one is missing', () => {
    expect(setupDone({ ...ready, enabled: false })).toBe(false);
    expect(setupDone({ ...ready, microphone: 'denied' })).toBe(false);
    expect(setupDone({ ...ready, accessibility: false })).toBe(false);
    expect(setupDone({ ...ready, modelReady: false })).toBe(false);
  });
  it('is false while the model is still preparing, though that is not setup to do', () => {
    // Today's behaviour; see the report.
    expect(setupDone({ ...ready, modelReady: false, modelPreparing: true })).toBe(false);
    expect(needsSetup({ ...ready, modelReady: false, modelPreparing: true })).toBe(false);
  });
});

describe('voiceReady', () => {
  it('needs the key on and the model ready', () => {
    expect(voiceReady(ready)).toBe(true);
    expect(voiceReady({ ...ready, enabled: false })).toBe(false);
    expect(voiceReady({ ...ready, modelReady: false })).toBe(false);
  });
});

describe('missing', () => {
  it('is empty when everything is in place', () => expect(missing(ready)).toEqual([]));
  it('names each open step with the step that fixes it', () => {
    expect(missing({ ...ready, microphone: 'denied' })).toEqual([['microphone', 'allow the microphone', true]]);
    expect(missing({ ...ready, microphone: 'notDetermined' }).map(([id]) => id)).toEqual(['microphone']);
    expect(missing({ ...ready, accessibility: false })).toEqual([['accessibility', 'turn on Accessibility', true]]);
    expect(missing({ ...ready, modelReady: false })).toEqual([['model', 'download the speech model', true]]);
  });
  it('sends a Mac with the key off to the model step', () => {
    expect(missing({ ...ready, enabled: false }).map(([id]) => id)).toEqual(['model']);
  });
  it('lists them in the order of the steps', () => {
    expect(missing({ ...ready, microphone: 'denied', accessibility: false, modelReady: false }).map(([id]) => id)).toEqual(['microphone', 'accessibility', 'model']);
  });
});
