import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Main application build.
 *
 * We deliberately do NOT use vite-plugin-pwa here. The service worker is
 * hand-written (custom push / notificationclick logic) and this app is
 * online-first, so Workbox precaching buys us nothing — while workbox-build
 * drags in deprecated transitive dependencies. The manifest is a static file in
 * public/, and the service worker is compiled by vite.sw.config.ts.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/v1': 'http://localhost:3000',
      '/a': 'http://localhost:3000',
    },
  },
});
