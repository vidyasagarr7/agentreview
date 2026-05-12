import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['cjs'],
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
