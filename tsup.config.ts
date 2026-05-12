import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist/cli',
  clean: true,
  sourcemap: false,
  splitting: false,
  bundle: true,
  minify: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
