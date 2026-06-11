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

  it('caps import edges at MAX_IMPORTS and emits a diagnostic', () => {
    const manyImports: ImportEdge[] = Array.from({ length: 201 }, (_, i) => ({
      from: `src/a${i}.ts`,
      to: `src/b${i}.ts`,
      external: false,
    }));

    const result = renderCodebaseContext({
      importsOut: manyImports,
      diagnostics: [],
      budgetTokens: 100000,
    });

    expect(result.rendered).toContain('Import edges capped at 200 (201 total)');
    // Only the first 200 edges are rendered
    expect(result.rendered).toContain('src/a0.ts → src/b0.ts');
    expect(result.rendered).toContain('src/a199.ts → src/b199.ts');
    expect(result.rendered).not.toContain('src/a200.ts → src/b200.ts');
  });

  it('emits a diagnostic when the tree was truncated at the GitHub level', () => {
    const truncatedTree: RepoTree = {
      sha: 'abc',
      entries: [{ path: 'src/auth.ts', type: 'blob', size: 1024 }],
      truncated: true,
    };

    const result = renderCodebaseContext({
      tree: truncatedTree,
      importsOut: [],
      diagnostics: [],
      budgetTokens: 8000,
    });

    expect(result.rendered).toContain(
      'Repository tree was truncated at GitHub level; some files may not be shown.',
    );
  });

  it('caps tree blob entries at MAX_TREE_ENTRIES and emits a diagnostic', () => {
    const manyEntries: RepoTree = {
      sha: 'abc',
      entries: Array.from({ length: 501 }, (_, i) => ({
        path: `src/file${i}.ts`,
        type: 'blob' as const,
        size: 1024,
      })),
      truncated: false,
    };

    const result = renderCodebaseContext({
      tree: manyEntries,
      importsOut: [],
      diagnostics: [],
      budgetTokens: 100000,
    });

    expect(result.rendered).toContain('Repository tree capped at 500 entries (501 total)');
  });

  it('renders a "... more files" line when there are more than 100 blob entries', () => {
    const manyEntries: RepoTree = {
      sha: 'abc',
      entries: Array.from({ length: 150 }, (_, i) => ({
        path: `src/file${i}.ts`,
        type: 'blob' as const,
        size: 1024,
      })),
      truncated: false,
    };

    const result = renderCodebaseContext({
      tree: manyEntries,
      importsOut: [],
      diagnostics: [],
      budgetTokens: 100000,
    });

    expect(result.rendered).toContain('... (50 more files)');
  });

  it('sets truncated when even the section header alone exceeds the budget', () => {
    // budget == header tokens, so no line can fit and partial.length stays 1
    const result = renderCodebaseContext({
      importsOut: imports,
      diagnostics: [],
      budgetTokens: 6, // "## Import Dependencies" estimates to 6 tokens
    });

    expect(result.truncated).toBe(true);
    expect(result.rendered).toBe('');
  });
});
