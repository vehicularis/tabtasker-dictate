import type { Edge, Status } from '../store';

// `?preview=…` shows one state without the app around it, for checking the design in a browser.
export const PREVIEW = new URLSearchParams(location.search).get('preview');
export const PREVIEW_EDGE = new URLSearchParams(location.search).get('edge') as Edge | null;
export const SAMPLE: Status = { enabled: true, microphone: 'allowed', accessibility: true, modelReady: true, modelPreparing: false, modelMessage: '', notes: '/Users/you/Documents/TabTasker | Dictate', globeKey: '', openAtLogin: true,
  inputs: [{ id: 'built-in', name: 'MacBook Pro Microphone' }, { id: 'airpods', name: 'AirPods Pro' }], input: null, inputInUse: 'MacBook Pro Microphone' };
// Setup previews, one per step: setup, setup-fn, setup-test, setup-hold, setup-globe, setup-download, setup-model, setup-done.
export const SETUP: Record<string, Partial<Status>> = {
  setup: { microphone: 'notDetermined', accessibility: false, enabled: false, modelReady: false },
  'setup-fn': { accessibility: false, enabled: false, modelReady: false },
  'setup-test': { enabled: false, modelReady: false },
  'setup-hold': { enabled: false, modelReady: false },
  'setup-globe': { enabled: false, modelReady: false, globeKey: 'emoji' },
  'setup-download': { enabled: false, modelReady: false },
  'setup-model': { modelReady: false, modelPreparing: true, modelMessage: 'Downloading Whisper large-v3 Turbo… 42%' },
  'setup-done': {},
};
