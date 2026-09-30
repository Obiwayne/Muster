import { defineConfig } from 'vite';

// Built by the root script `vite build ui` into dist/ui, served by the orchestrator.
// In dev (`vite ui`), /api and /ws are proxied to the orchestrator (or ui/dev/mock-server.mjs)
// and the token comes from VITE_MUSTER_TOKEN because nothing injects the <meta> tag.
const target = process.env.MUSTER_URL ?? 'http://127.0.0.1:47800';

export default defineConfig({
  root: __dirname,
  base: '/',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 5199,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
});
