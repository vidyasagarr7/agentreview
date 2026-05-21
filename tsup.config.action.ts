import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['action/src/index.ts'],
  outDir: 'action/dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/.*/],
  // Don't minify — easier to debug in Actions logs
  minify: false,
});
