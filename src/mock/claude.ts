import type { Mock } from '.';

// In a browser: the Anthropic key, Claude Code and the answer card's actions. A key containing "bad" is
// refused, as Anthropic would; any other key shaped like one connects. `?claude=on` starts connected with
// a key and `?claude=code` through Claude Code; `?claudecode=none` is a Mac without Claude Code and
// `?claudecode=out` one where it isn't signed in; `?insert=fail` an Insert whose app has quit.
const later = (ms: number) => new Promise(done => setTimeout(done, ms));
const CLAUDE_CODE = '/Users/you/.local/bin/claude';
// The programs on this pretend Mac.
const PROGRAMS = [CLAUDE_CODE, '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

export function register(mock: Mock) {
  const query = new URLSearchParams(location.search);
  let saved = query.get('claude') === 'on';
  const installed = query.get('claudecode') !== 'none';
  const signedIn = query.get('claudecode') !== 'out';
  const viaCode = query.get('claude') === 'code' && installed;
  // As at launch: a saved key or Claude Code at its path turns Claude on, and Claude Code is found where
  // its installer puts it.
  mock.update({ claude: { enabled: saved || viaCode, via: viaCode ? 'claudeCode' : 'api', claudeCode: installed ? CLAUDE_CODE : null } });

  mock.handle('claude_save_key', async ({ key }) => {
    const pasted = typeof key === 'string' ? key.trim() : '';
    if (!pasted.startsWith('sk-ant-') || pasted.length < 30 || /\s/.test(pasted)) throw 'That doesn’t look like an Anthropic API key. Keys start with sk-ant-.';
    await later(900);
    if (pasted.includes('bad')) throw 'Anthropic didn’t accept the key. Check it and paste it again.';
    saved = true;
    return mock.update({ claude: { enabled: true, via: 'api' } });
  });
  mock.handle('claude_connect_code', async () => {
    await later(1200);
    const program = mock.settings().claude.claudeCode;
    if (!program || !PROGRAMS.includes(program)) throw 'Claude Code isn’t installed on this Mac. Install it and sign in, then try again.';
    if (!signedIn) throw 'Claude Code isn’t signed in. Run claude in Terminal and sign in, then try again.';
    return mock.update({ claude: { enabled: true, via: 'claudeCode' } });
  });
  mock.handle('claude_disconnect', () => mock.update({ claude: { enabled: saved, via: 'api' } }));
  mock.handle('claude_connect_local', async ({ endpoint, model }) => { await later(500); if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) throw 'Use the address Ollama listens on, like http://localhost:11434.'; if (!model) throw 'Name the model as Ollama knows it, like llama3.2.'; return mock.update({ claude: { enabled: true, via: 'local', localEndpoint: endpoint, localModel: model } }); });
  mock.handle('claude_connect_open_ai', async ({ endpoint, key, model }) => { await later(500); if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) throw 'Use the service’s address, like https://api.openai.com.'; if (typeof key !== 'string' || !key.trim()) throw 'Paste the service’s API key.'; return mock.update({ claude: { enabled: true, via: 'openAi', openAiEndpoint: String(endpoint).replace(/\/+$/, ''), openAiModel: String(model) } }); });
  mock.handle('claude_test', async () => {
    const claude = mock.settings().claude;
    await later(claude.via === 'claudeCode' ? 1800 : 700);
    if (!claude.enabled) throw 'Connect AI in Agents first.';
    return (claude.via === 'claudeCode' ? 1600 : 420) + Math.round(Math.random() * 500);
  });
  mock.handle('claude_remove_key', () => { saved = false; const claude = mock.settings().claude; return mock.update({ claude: { enabled: claude.via === 'claudeCode' && claude.enabled } }); });
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
  // A typed question: answered as a spoken command is, on the same card.
  mock.handle('claude_ask', async ({ question }) => {
    if (!mock.settings().claude.enabled) throw 'Connect AI in Agents first.';
    const request = `ask-${Date.now()}`;
    mock.emit('dictate-command', { request, phase: 'thinking', instruction: question, typed: true });
    setTimeout(() => mock.emit('dictate-command', { request, phase: 'answer', instruction: question, typed: true, text: 'From your notes: the design review is Thursday at 10, and Maria has the big room booked. The floor plan still has to go to her before lunch.' }), 1800);
    return request;
  });
}
