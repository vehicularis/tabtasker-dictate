import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Three pages, loaded from disk by Tauri (in development from this server): the overlay, Settings and a sticky.
export default defineConfig({
  plugins: [react()], clearScreen: false, server: { port: 1420, strictPort: true },
  build: { rolldownOptions: { input: { index: 'index.html', settings: 'settings.html', sticky: 'sticky.html' } } },
});
