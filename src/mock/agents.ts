import type { Mock } from '.';
import type { AgentsStatus } from '../api/types';

// In a browser: the MCP server and adding it to Claude. `?agents=missing` is a Mac with neither Claude
// app, `?agents=added` one with both, `?agents=elsewhere` one set up for another copy of the app (last
// asked by Cursor), `?agents=dmg` the app run from its disk image, and `?agents=fails` one where adding
// goes wrong.
export function register(mock: Mock) {
  const scene = new URLSearchParams(location.search).get('agents');
  const exe = scene === 'dmg' ? '/Volumes/TabTasker Dictate/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate' : '/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate';
  const found = scene !== 'missing';
  const added = scene === 'added' ? 'yes' : scene === 'elsewhere' ? 'elsewhere' : 'no';
  const status: AgentsStatus = {
    command: [exe, '--mcp'],
    claudeCode: { found, added },
    claudeDesktop: { found, added },
    lastCall: scene === 'missing' ? null
      : scene === 'elsewhere' ? { atMs: Date.now() - 4 * 60_000, tool: 'search_notes', client: 'cursor-vscode', clientTitle: 'Cursor', ok: true }
      : { atMs: Date.now() - 4 * 60_000, tool: 'search_notes', client: 'claude-code', clientTitle: null, ok: true },
    problem: scene === 'dmg' ? 'Move TabTasker | Dictate to Applications first, so agents can always find it.' : null,
  };
  const failures = {
    claudeCode: 'Claude Code couldn’t add it: MCP server tabtasker-dictate already exists',
    claudeDesktop: 'Claude Desktop’s settings file isn’t valid JSON, so it is left as it is. Fix or remove it in Claude Desktop, then try again.',
  };
  const copy = () => JSON.parse(JSON.stringify(status)) as AgentsStatus;
  mock.handle('agents_status', copy);
  mock.handle('agents_add', ({ target }) => new Promise((done, fail) => setTimeout(() => {
    if (status.problem) return fail(status.problem);
    if (scene === 'fails') return fail(failures[target]);
    status[target].added = 'yes';
    done(copy());
  }, 700)));
}
