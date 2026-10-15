import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API server runs on :3001 (npm run dev -w server) and Vite proxies to it.
const API = process.env.ORIEL_API ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // A single copy of these libraries must exist at runtime.
    dedupe: ['yjs', 'react', 'react-dom', 'prosemirror-model', 'prosemirror-state', 'prosemirror-view'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api/events': { target: API, ws: true },
      // Regex so that only the collaboration endpoint (not e.g. /collab-xyz) is proxied.
      '^/collab(?:/|\\?|$)': { target: API, ws: true },
      '/api': { target: API },
    },
  },
  // Module workers (history diff, Typst preview) may split code and import WebAssembly.
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
