import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The page is the app's overlay, loaded from disk by Tauri; in development from this server.
export default defineConfig({ plugins: [react()], clearScreen: false, server: { port: 1420, strictPort: true } });
