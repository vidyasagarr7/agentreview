import { describe, it, expect } from 'vitest';
import { resolveImport, isRelativeImport } from './resolver.js';
import type { RepoTree } from '../types/index.js';

const tree: RepoTree = {
  sha: 'abc123',
  entries: [
    { path: 'src/auth.ts', type: 'blob', size: 1000 },
    { path: 'src/utils.ts', type: 'blob', size: 500 },
    { path: 'src/helpers/index.ts', type: 'blob', size: 200 },
    { path: 'src/lib/db.js', type: 'blob', size: 300 },
    { path: 'src/components/Button.tsx', type: 'blob', size: 400 },
  ],
  truncated: false,
};

describe('isRelativeImport', () => {
  it('returns true for ./ imports', () => {
    expect(isRelativeImport('./auth')).toBe(true);
  });
  it('returns true for ../ imports', () => {
    expect(isRelativeImport('../utils')).toBe(true);
  });
  it('returns false for bare imports', () => {
    expect(isRelativeImport('react')).toBe(false);
    expect(isRelativeImport('@octokit/rest')).toBe(false);
  });
});

describe('resolveImport', () => {
  it('resolves relative import with .ts extension', () => {
    const result = resolveImport('src/index.ts', './auth', tree);
    expect(result).toBe('src/auth.ts');
  });

  it('resolves relative import to sibling', () => {
    const result = resolveImport('src/auth.ts', './utils', tree);
    expect(result).toBe('src/utils.ts');
  });

  it('resolves directory import to index.ts', () => {
    const result = resolveImport('src/auth.ts', './helpers', tree);
    expect(result).toBe('src/helpers/index.ts');
  });

  it('resolves ../ parent import', () => {
    const result = resolveImport('src/helpers/index.ts', '../auth', tree);
    expect(result).toBe('src/auth.ts');
  });

  it('returns null for bare/external imports', () => {
    expect(resolveImport('src/auth.ts', 'react', tree)).toBeNull();
    expect(resolveImport('src/auth.ts', '@octokit/rest', tree)).toBeNull();
  });

  it('returns null for unresolvable relative import', () => {
    expect(resolveImport('src/auth.ts', './nonexistent', tree)).toBeNull();
  });
});
