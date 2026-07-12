import { defineConfig } from 'vite';

/**
 * Compiles src/sw.ts to dist/sw.js. Runs after the main build with
 * emptyOutDir disabled so it does not wipe the app bundle.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/sw.ts',
      formats: ['es'],
      fileName: () => 'sw.js',
    },
    rollupOptions: {
      output: { entryFileNames: 'sw.js' },
    },
  },
});
