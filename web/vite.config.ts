import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// In development the API runs on :3000; in production Express serves this build at /app.
const api = 'http://localhost:3000';
const proxied = ['/console', '/mandates', '/operators', '/agents', '/agent', '/cases', '/rulings', '/settlements', '/scorecard', '/recorder', '/catalog-snapshots', '/orders', '/r/', '/.well-known'];

export default defineConfig(({ mode }) => ({
  // AG Studio licence: AG_STUDIO_LICENSE_KEY from the project's .env if present; without it Studio runs in trial mode (watermark).
  define: { 'import.meta.env.VITE_AG_STUDIO_LICENSE_KEY': JSON.stringify(loadEnv(mode, '..', '').AG_STUDIO_LICENSE_KEY ?? '') },
  base: '/app/',
  plugins: [react()],
  server: { port: 5173, proxy: Object.fromEntries(proxied.map((p) => [p, { target: api, changeOrigin: false }])) },
  build: { outDir: 'dist', chunkSizeWarningLimit: 8000 },
}));
