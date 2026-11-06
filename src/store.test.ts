import { describe, expect, it } from 'vitest';
import { aiIcon, aiName, folderPath, sendsByDefault, tilde } from './store';

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
