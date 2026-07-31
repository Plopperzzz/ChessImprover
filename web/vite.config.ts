import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The FastAPI app serves the built bundle from `web/dist` (see backend/app/paths.py),
// so the build output stays inside this directory and nothing is copied into the
// repo root. `npm run dev` proxies the API and both websockets to the backend on
// 8000 so the React app can be developed against a real engine server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
      '/assets': { target: 'http://127.0.0.1:8000', changeOrigin: false },
      '/legacy': { target: 'http://127.0.0.1:8000', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Not the default 'assets': the server already mounts /assets on the repo's
    // piece sets, board images and sounds, and that mount is matched before the
    // SPA one -- bundles emitted there would 404 before they ever reached it.
    assetsDir: 'static',
  },
});
