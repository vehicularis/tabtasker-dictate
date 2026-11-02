import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Four pages, loaded from disk by Tauri (in development from this server): the overlay, Settings, a sticky and a note's editor.
export default defineConfig({
  plugins: [react()], clearScreen: false, server: { port: 1420, strictPort: true },
  build: { rolldownOptions: { input: { index: 'index.html', settings: 'settings.html', sticky: 'sticky.html', note: 'note.html' } } },
});
