import type { Mock } from '.';
import type { AgentsStatus } from '../settings/pages/Agents';

// In a browser: the MCP server and adding it to Claude. `?agents=missing` is a Mac with neither Claude
// app, `?agents=added` one with both, `?agents=elsewhere` one set up for another copy of the app, and
// `?agents=dmg` the app run from its disk image.
export function register(mock: Mock) {
  const scene = new URLSearchParams(location.search).get('agents');
  const exe = scene === 'dmg' ? '/Volumes/TabTasker Dictate/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate' : '/Applications/TabTasker Dictate.app/Contents/MacOS/tabtasker-dictate';
  const found = scene !== 'missing';
  const added = scene === 'added' ? 'yes' : scene === 'elsewhere' ? 'elsewhere' : 'no';
  const status: AgentsStatus = {
    command: [exe, '--mcp'],
    claudeCode: { found, added },
    claudeDesktop: { found, added },
    lastCall: scene === 'missing' ? null : { atMs: Date.now() - 4 * 60_000, tool: 'search_notes', client: 'claude-code', ok: true },
    problem: scene === 'dmg' ? 'Move TabTasker Dictate to Applications first, so agents can always find it.' : null,
  };
  const copy = () => JSON.parse(JSON.stringify(status)) as AgentsStatus;
  mock.handle('agents_status', copy);
  mock.handle('agents_add', ({ target }) => new Promise((done, fail) => setTimeout(() => {
    if (target !== 'claudeCode' && target !== 'claudeDesktop') return fail('Unknown agent');
    if (status.problem) return fail(status.problem);
    status[target].added = 'yes';
    done(copy());
  }, 700)));
}
