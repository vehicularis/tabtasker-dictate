import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// tsconfig loads no Node types, and this is all of Node the config uses.
declare const process: { env: Record<string, string | undefined> };

// The tests run in New York, in US English, wherever they are started: Node reads both when a process starts,
// so they are set here, before the forked workers are.
process.env.TZ = 'America/New_York';
process.env.LC_ALL = 'en_US.UTF-8';

// Three pages, loaded from disk by Tauri (in development from this server): the overlay, the app's window and a sticky.
export default defineConfig({
  plugins: [react()], clearScreen: false, server: { port: 1420, strictPort: true },
  build: { rolldownOptions: { input: { index: 'index.html', app: 'app.html', sticky: 'sticky.html' } } },
  test: { include: ['src/**/*.test.ts'], environment: 'node', pool: 'forks' },
});
