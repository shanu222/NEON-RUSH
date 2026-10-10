import { defineConfig } from 'vitest/config';

// Relative base so the build works from any static host path (domain root,
// sub-folder, or iframe-embedded deployment) without rebuilding.
export default defineConfig({
  base: './',
  build: {
    target: 'es2019',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
