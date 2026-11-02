import type { Mock } from '.';

// In a browser: the Anthropic key, Claude Code and the answer card's actions. A key containing "bad" is
// refused, as Anthropic would; any other key shaped like one connects. `?claude=on` starts connected.
const later = (ms: number) => new Promise(done => setTimeout(done, ms));
const CLAUDE_CODE = '/Users/you/.local/bin/claude';

export function register(mock: Mock) {
  let saved = new URLSearchParams(location.search).get('claude') === 'on';
  // As at launch: a saved key turns Claude on, and Claude Code is found where its installer puts it.
  mock.update({ claude: { enabled: saved, claudeCode: CLAUDE_CODE } });

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
  mock.handle('claude_insert', () => {});
  mock.handle('claude_dismiss', () => {});
  mock.handle('claude_code_find', async () => {
    await later(500);
    mock.update({ claude: { claudeCode: CLAUDE_CODE } });
    return CLAUDE_CODE;
  });
  mock.handle('send_to_claude_code', async () => { await later(400); return true; });
}
