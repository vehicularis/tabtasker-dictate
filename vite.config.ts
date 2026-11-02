import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Three pages, loaded from disk by Tauri (in development from this server): the overlay, the app's window and a sticky.
export default defineConfig({
  plugins: [react()], clearScreen: false, server: { port: 1420, strictPort: true },
  build: { rolldownOptions: { input: { index: 'index.html', app: 'app.html', sticky: 'sticky.html' } } },
});
