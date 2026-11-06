import { describe, expect, it } from 'vitest';
import { ago, configEntry, lastCall } from './agents';

const now = new Date(2026, 5, 15, 12).getTime();
const before = (s: number) => now - s * 1000;

describe('ago', () => {
  it('says just now under a minute', () => {
    expect(ago(before(0), now)).toBe('just now');
    expect(ago(before(59), now)).toBe('just now');
  });
  it('counts minutes', () => {
    expect(ago(before(60), now)).toBe('1 minute ago');
    expect(ago(before(5 * 60), now)).toBe('5 minutes ago');
    expect(ago(before(59 * 60), now)).toBe('59 minutes ago');
  });
  it('counts hours', () => {
    expect(ago(before(3600), now)).toBe('1 hour ago');
    expect(ago(before(3 * 3600), now)).toBe('3 hours ago');
  });
  it('counts days, with yesterday', () => {
    expect(ago(before(86400), now)).toBe('yesterday');
    expect(ago(before(3 * 86400), now)).toBe('3 days ago');
  });
  it('says just now for a moment ahead of now', () => expect(ago(now + 5000, now)).toBe('just now'));
});

describe('lastCall', () => {
  const call = { atMs: before(300), tool: 'read_note', client: 'claude-code', ok: true };
  it('says none has asked for null', () => expect(lastCall(null, now)).toBe('No agent has asked yet.'));
  it('words a success', () => expect(lastCall(call, now)).toBe('Claude Code read a note 5 minutes ago.'));
  it('words a failure', () => {
    expect(lastCall({ ...call, ok: false, tool: 'create_note', client: 'claude-ai' }, now)).toBe('Claude Desktop tried to create a note 5 minutes ago, and couldn’t.');
  });
  it('names an unknown client by its title, else An agent', () => {
    expect(lastCall({ ...call, client: 'zed', clientTitle: 'Zed' }, now)).toBe('Zed read a note 5 minutes ago.');
    expect(lastCall({ ...call, client: 'zed', clientTitle: null }, now)).toBe('An agent read a note 5 minutes ago.');
    expect(lastCall({ ...call, client: 'zed', clientTitle: '' }, now)).toBe('An agent read a note 5 minutes ago.');
  });
  it('words an unknown tool', () => {
    expect(lastCall({ ...call, tool: 'mystery' }, now)).toBe('Claude Code asked for something 5 minutes ago.');
    expect(lastCall({ ...call, tool: 'mystery', ok: false }, now)).toBe('Claude Code tried to ask for something 5 minutes ago, and couldn’t.');
  });
});

describe('configEntry', () => {
  it('writes a program and its arguments as JSON, never a shell line', () => {
    expect(configEntry(['/Applications/Dictate.app/mcp', '--stdio'])).toBe(
      '"tabtasker-dictate": {\n  "command": "/Applications/Dictate.app/mcp",\n  "args": ["--stdio"]\n}');
  });
  it('escapes quotes and spaces stay in one string', () => {
    expect(configEntry(['/My "Apps"/d'])).toBe('"tabtasker-dictate": {\n  "command": "/My \\"Apps\\"/d",\n  "args": []\n}');
  });
});
