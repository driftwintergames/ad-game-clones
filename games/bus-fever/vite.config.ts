import { defineConfig } from 'vite';

// Web build → site/games/bus-fever (deployed). `build:native` overrides
// outDir to dist/ for Capacitor sync.
export default defineConfig({
  base: './',
  build: { outDir: '../../site/games/bus-fever', emptyOutDir: true },
});
