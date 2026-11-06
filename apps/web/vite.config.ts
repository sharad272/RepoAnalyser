import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs let the same build run from a web server or inside an editor webview.
  base: './',
  plugins: [react()],
  server: { host: true, port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  preview: { host: true, port: 4173 },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
