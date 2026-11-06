import { beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '../api/commands';
import { MACOS_SHORTCUTS, MODIFIERS } from '../lib/chords';

// What the mock reads when it loads: the page's address, and the keys and blur it listens for.
vi.stubGlobal('location', new URL('http://localhost:1462/app.html'));
vi.stubGlobal('addEventListener', () => {});
vi.stubGlobal('removeEventListener', () => {});

type Mod = typeof import('./index');
let mod: Mod;
beforeAll(async () => { mod = await import('./index'); });

describe('the browser mock', () => {
  it('reports the macOS shortcuts the settings page lists', async () => {
    const status = await mod.invoke('status');
    expect(status.systemShortcuts).toEqual(MACOS_SHORTCUTS.map(([key, mods]) => [key, mods]));
    expect(status.systemShortcuts).toHaveLength(21);
    expect(status.systemShortcuts).toContainEqual([49, MODIFIERS.command]); // ⌘Space, Spotlight
  });

  it('answers every command', () => {
    for (const name of COMMANDS) expect(mod.mock.handled(name), name).toBeTypeOf('function');
  });

  it('answers a command whose args are all optional when they are left out, as Tauri does', async () => {
    await expect(mod.invoke('show_notes')).resolves.toBeUndefined();
    await expect(mod.invoke('sticky_new')).resolves.toHaveProperty('id');
  });

  it('keeps a setting a patch sets, and refuses one out of range', async () => {
    const set = await mod.invoke('update_settings', { patch: { appearance: { margin: 40 } } });
    expect(set.appearance.margin).toBe(40);
    const refused = await mod.invoke('update_settings', { patch: { appearance: { margin: 999 } } });
    expect(refused.appearance.margin).toBe(40);
  });

  it('tells listeners when a sticky changes', async () => {
    let heard = 0;
    await mod.listen('dictate-stickies', () => { heard++; });
    await mod.invoke('sticky_update', { id: 'demo', text: 'x' });
    await mod.invoke('sticky_size', { id: 'demo', width: 250, height: 210 });
    await mod.invoke('sticky_pin', { id: 'demo', pinned: false });
    await mod.invoke('sticky_fold', { id: 'demo', folded: true });
    expect(heard).toBe(4);
    const made = await mod.invoke('sticky_new');
    await mod.invoke('sticky_to_note', { id: made.id, stamp: '2026-01-01 09.00' });
    expect(heard).toBe(6); // sticky_new, then the one that turned into a note
  });

  it('rejects a meeting that cannot start, as the Mac does', async () => {
    await expect(mod.invoke('meeting', { action: 'start' })).resolves.toBe(true);
    await expect(mod.invoke('meeting', { action: 'start' })).resolves.toBe(true); // already recording: nothing to refuse
    await mod.invoke('meeting', { action: 'stop' });
    await expect(mod.invoke('meeting', { action: 'start' })).rejects.toBe('The last meeting is still saving. Try again in a moment.');
  });
});
