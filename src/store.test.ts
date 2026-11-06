import { describe, expect, it } from 'vitest';
import { aiIcon, aiName, folderPath, needsSetup, sendsByDefault, setupDone, tilde } from './store';
import type { Status } from './api/types';

describe('folderPath', () => {
  const home = '/Users/otter';
  it('is null for nothing typed, or spaces', () => {
    expect(folderPath('', home)).toBeNull();
    expect(folderPath('   ', undefined)).toBeNull();
  });
  it('keeps a full path, trimmed', () => {
    expect(folderPath('  /Volumes/Notes ', home)).toBe('/Volumes/Notes');
    expect(folderPath('/Volumes/Notes', undefined)).toBe('/Volumes/Notes');
  });
  it('writes ~ and ~/ as the home folder', () => {
    expect(folderPath('~', home)).toBe('/Users/otter');
    expect(folderPath('~/Documents/Notes', home)).toBe('/Users/otter/Documents/Notes');
  });
  it('is undefined for ~ without a home, a relative path, or ~user', () => {
    expect(folderPath('~/Notes', undefined)).toBeUndefined();
    expect(folderPath('Notes', home)).toBeUndefined();
    expect(folderPath('~otter/Notes', home)).toBeUndefined();
  });
});

describe('tilde', () => {
  const home = '/Users/otter';
  it('writes the home folder and what is inside it with ~', () => {
    expect(tilde('/Users/otter', home)).toBe('~');
    expect(tilde('/Users/otter/Notes', home)).toBe('~/Notes');
  });
  it('leaves other paths, even ones that only start with the same letters', () => {
    expect(tilde('/Users/otter2/Notes', home)).toBe('/Users/otter2/Notes');
    expect(tilde('/Volumes/Notes', home)).toBe('/Volumes/Notes');
  });
  it('leaves a path when the home is unknown or empty', () => {
    expect(tilde('/Users/otter/Notes', undefined)).toBe('/Users/otter/Notes');
    expect(tilde('/Users/otter/Notes', '')).toBe('/Users/otter/Notes');
  });
});

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

describe('aiName and aiIcon', () => {
  const via = (v: 'api' | 'claudeCode' | 'local' | 'openAi', openAiModel = '', localModel = '') => ({ via: v, openAiModel, localModel });
  it('names Claude for the API and Claude Code, whatever the model fields hold', () => {
    expect(aiName(via('api', 'gpt', 'llama'))).toBe('Claude');
    expect(aiName(via('claudeCode'))).toBe('Claude');
  });
  it('names the OpenAI model, else AI', () => {
    expect(aiName(via('openAi', 'gpt-5'))).toBe('gpt-5');
    expect(aiName(via('openAi', '', 'llama'))).toBe('AI');
  });
  it('names the local model, else AI', () => {
    expect(aiName(via('local', 'gpt', 'llama3'))).toBe('llama3');
    expect(aiName(via('local'))).toBe('AI');
  });
  it('picks the Claude glyph for Claude, the agents glyph otherwise', () => {
    expect(aiIcon({ via: 'api' })).toBe('claude');
    expect(aiIcon({ via: 'claudeCode' })).toBe('claude');
    expect(aiIcon({ via: 'local' })).toBe('agents');
    expect(aiIcon({ via: 'openAi' })).toBe('agents');
  });
});

describe('sendsByDefault', () => {
  it('is true for a chat app, in any case', () => {
    expect(sendsByDefault('com.tinyspeck.slackmacgap')).toBe(true);
    expect(sendsByDefault('COM.APPLE.MOBILESMS')).toBe(true);
    expect(sendsByDefault('ru.keepcoder.telegram')).toBe(true);
  });
  it('is false for anything else', () => {
    expect(sendsByDefault('com.apple.Notes')).toBe(false);
    expect(sendsByDefault('')).toBe(false);
    expect(sendsByDefault('com.tinyspeck')).toBe(false);
  });
});
