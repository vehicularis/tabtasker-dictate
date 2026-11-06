import { describe, expect, it } from 'vitest';
import lib from '../../src-tauri/src/lib.rs?raw';
import { COMMANDS } from './commands';
import { EVENTS } from './events';

// The Rust sources as text, which is all the contract needs from them (vite/client types the glob and ?raw).
const sources = import.meta.glob('../../src-tauri/src/**/*.rs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('the bridge contract', () => {
  it('lists every command the app registers', () => {
    const registered = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? '';
    const names = registered.split(',').map(path => path.trim().split('::').pop()!).filter(Boolean).sort();
    expect(names).toHaveLength(74);
    expect(COMMANDS.filter(name => !name.includes('plugin:')).sort()).toEqual(names);
  });

  it('lists every event the app emits', () => {
    // A "dictate-…" literal counts only as the event name of an emit or emit_to call (events.rs's own emit helper too).
    const emitted = new Set<string>();
    for (const source of Object.values(sources)) for (const line of source.split('\n')) {
      const found = /\bemit(?:_to)?\(.*?"(dictate-[a-z-]+)"/.exec(line);
      if (found) emitted.add(found[1]);
    }
    expect(emitted.size).toBe(20);
    expect([...EVENTS].sort()).toEqual([...emitted].sort());
  });
});
