import { describe, it, expect } from 'vitest';
import { renderCodebaseContext } from './renderer.js';
import type { ImportEdge, RepoTree } from '../types/index.js';

const tree: RepoTree = {
  sha: 'abc',
  entries: [
    { path: 'src/auth.ts', type: 'blob', size: 1024 },
    { path: 'src/utils.ts', type: 'blob', size: 512 },
  ],
  truncated: false,
};

const imports: ImportEdge[] = [
  { from: 'src/auth.ts', to: 'src/utils.ts', symbols: ['hash'], external: false },
  { from: 'src/auth.ts', to: 'bcrypt', external: true },
];

describe('renderCodebaseContext', () => {
  it('renders imports and tree within budget', () => {
    const result = renderCodebaseContext({
      tree,
      importsOut: imports,
      diagnostics: [],
      budgetTokens: 8000,
    });

    expect(result.rendered).toContain('## Import Dependencies');
    expect(result.rendered).toContain('src/auth.ts → src/utils.ts');
    expect(result.rendered).toContain('bcrypt (external)');
    expect(result.rendered).toContain('## Repository Structure');
    expect(result.truncated).toBe(false);
  });

  it('truncates when budget is tight', () => {
    const result = renderCodebaseContext({
      tree,
      importsOut: imports,
      diagnostics: [],
      budgetTokens: 30, // very small budget
    });

    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(30);
  });

  it('prioritizes imports over tree', () => {
    const result = renderCodebaseContext({
      tree,
      importsOut: imports,
      diagnostics: [],
      budgetTokens: 60, // enough for imports but not tree
    });

    expect(result.rendered).toContain('Import Dependencies');
    // Tree might be missing due to budget
  });

  it('renders diagnostics', () => {
    const result = renderCodebaseContext({
      importsOut: [],
      diagnostics: [{ level: 'warn', message: 'Parser fallback used' }],
      budgetTokens: 8000,
    });

    expect(result.rendered).toContain('[WARN]');
    expect(result.rendered).toContain('Parser fallback used');
  });

  it('handles empty input', () => {
    const result = renderCodebaseContext({
      importsOut: [],
      diagnostics: [],
      budgetTokens: 8000,
    });

    expect(result.rendered).toBe('');
    expect(result.estimatedTokens).toBe(0);
  });
});
