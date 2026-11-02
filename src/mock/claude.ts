import type { Mock } from '.';

// In a browser: the Anthropic key, Claude Code and the answer card's actions. A key containing "bad" is
// refused, as Anthropic would; any other key shaped like one connects. `?claude=on` starts connected,
// `?claudecode=none` is a Mac without Claude Code, and `?insert=fail` an Insert whose app has quit.
const later = (ms: number) => new Promise(done => setTimeout(done, ms));
const CLAUDE_CODE = '/Users/you/.local/bin/claude';
// The programs on this pretend Mac.
const PROGRAMS = [CLAUDE_CODE, '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

export function register(mock: Mock) {
  const query = new URLSearchParams(location.search);
  let saved = query.get('claude') === 'on';
  const installed = query.get('claudecode') !== 'none';
  // As at launch: a saved key turns Claude on, and Claude Code is found where its installer puts it.
  mock.update({ claude: { enabled: saved, claudeCode: installed ? CLAUDE_CODE : null } });

  mock.handle('claude_save_key', async ({ key }) => {
    const pasted = typeof key === 'string' ? key.trim() : '';
    if (!pasted.startsWith('sk-ant-') || pasted.length < 30 || /\s/.test(pasted)) throw 'That doesn’t look like an Anthropic API key. Keys start with sk-ant-.';
    await later(900);
    if (pasted.includes('bad')) throw 'Anthropic didn’t accept the key. Check it and paste it again.';
    saved = true;
    return mock.update({ claude: { enabled: true } });
  });
  mock.handle('claude_test', async () => {
    await later(700);
    if (!saved) throw 'Connect Claude in Settings first.';
    return 420 + Math.round(Math.random() * 500);
  });
  mock.handle('claude_remove_key', () => { saved = false; return mock.update({ claude: { enabled: false } }); });
  mock.handle('claude_open_console', () => { open('https://console.anthropic.com/settings/keys', '_blank', 'noopener'); });
  mock.handle('claude_insert', async () => {
    await later(300);
    if (query.get('insert') === 'fail') throw 'Couldn’t get back to the app you asked in. Copy the answer instead.';
  });
  mock.handle('claude_dismiss', () => {});
  // As in the app: a search keeps what it finds, else the saved path only while a program is there.
  mock.handle('claude_code_find', async () => {
    await later(500);
    const current = mock.settings().claude.claudeCode;
    const kept = installed ? CLAUDE_CODE : current && PROGRAMS.includes(current) ? current : null;
    mock.update({ claude: { claudeCode: kept } });
    return kept;
  });
  mock.handle('claude_code_set', ({ path }) => {
    const next = typeof path === 'string' ? path : null;
    if (next && !PROGRAMS.includes(next)) throw 'There’s no program at that path.';
    return mock.update({ claude: { claudeCode: next } });
  });
  mock.handle('send_to_claude_code', async () => { await later(400); return true; });
}
