import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Three pages, loaded from disk by Tauri (in development from this server): the overlay, the app's window and a sticky.
export default defineConfig({
  plugins: [react()], clearScreen: false, server: { port: 1420, strictPort: true },
  build: { rolldownOptions: { input: { index: 'index.html', app: 'app.html', sticky: 'sticky.html' } } },
  // New York and US English wherever the tests are started: Node reads both when a worker starts, and `env` is what the forked workers start with.
  test: { include: ['src/**/*.test.ts'], environment: 'node', pool: 'forks', env: { TZ: 'America/New_York', LC_ALL: 'en_US.UTF-8' } },
});
