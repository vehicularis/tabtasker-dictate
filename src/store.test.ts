import { describe, expect, it } from 'vitest';
import { MODIFIERS, aiIcon, aiName, chordProblem, folderPath, needsSetup, sendsByDefault, setupDone, tilde, type Chord, type Status } from './store';

const { control, option, shift, command } = MODIFIERS;
const chord = (keyCode: number, modifiers: number, label = 'K'): Chord => ({ keyCode, modifiers, label });

describe('chordProblem', () => {
  it('takes a key with ⌘, ⌥ or ⌃', () => {
    expect(chordProblem(chord(40, command))).toBeNull();
    expect(chordProblem(chord(40, option | shift))).toBeNull();
    expect(chordProblem(chord(40, control))).toBeNull();
  });
  it('takes a function key alone', () => {
    expect(chordProblem(chord(122, 0, 'F1'))).toBeNull();
    expect(chordProblem(chord(90, shift, 'F20'))).toBeNull();
  });
  it.each([122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90])('takes function key code %i alone', code => {
    expect(chordProblem(chord(code, 0, 'F'))).toBeNull();
  });
  it('does not take a key code next to a function key', () => {
    expect(chordProblem(chord(121, 0))).toBe('Add ⌘, ⌥ or ⌃ to it');
  });
  it('asks for ⌘, ⌥ or ⌃ on a plain key or one with only ⇧', () => {
    expect(chordProblem(chord(40, 0))).toBe('Add ⌘, ⌥ or ⌃ to it');
    expect(chordProblem(chord(40, shift))).toBe('Add ⌘, ⌥ or ⌃ to it');
  });
  it('refuses a key code that is not an integer in 0 to 127', () => {
    expect(chordProblem(chord(-1, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(128, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(1.5, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(NaN, command))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(0, command))).toBeNull();
    expect(chordProblem(chord(127, command))).toBeNull();
  });
  it('refuses modifiers that are not integers or hold other bits', () => {
    expect(chordProblem(chord(40, 1))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(40, command | 1))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(40, 0.5))).toBe('That key can’t be a shortcut');
  });
  it('refuses a label that is empty, blank or not a string', () => {
    expect(chordProblem(chord(40, command, ''))).toBe('That key can’t be a shortcut');
    expect(chordProblem(chord(40, command, '  '))).toBe('That key can’t be a shortcut');
    expect(chordProblem({ keyCode: 40, modifiers: command, label: 5 as unknown as string })).toBe('That key can’t be a shortcut');
  });
  it('refuses a chord another shortcut uses, by name', () => {
    const others = [{ name: 'Take a note', chord: chord(45, command | shift) }];
    expect(chordProblem(chord(45, command | shift), others)).toBe('Already used for “Take a note”');
  });
  it('says the other shortcut\'s own reason when it has one', () => {
    const others = [{ name: 'Spotlight', chord: chord(49, command), reason: 'The Mac keeps ⌘Space' }];
    expect(chordProblem(chord(49, command), others)).toBe('The Mac keeps ⌘Space');
  });
  it('does not mind the same key with other modifiers, or others with no chord', () => {
    const others = [{ name: 'A', chord: chord(45, command) }, { name: 'B', chord: null }];
    expect(chordProblem(chord(45, command | option), others)).toBeNull();
    expect(chordProblem(chord(46, command), others)).toBeNull();
  });
  it('checks the rules before the conflicts', () => {
    const others = [{ name: 'A', chord: chord(40, 0) }];
    expect(chordProblem(chord(40, 0), others)).toBe('Add ⌘, ⌥ or ⌃ to it');
  });
});

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
  enabled: true, microphone: 'allowed', accessibility: true, modelReady: true, modelPreparing: false, modelMessage: '', notes: '',
  globeKey: '', inputs: [], input: null, inputInUse: '',
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
