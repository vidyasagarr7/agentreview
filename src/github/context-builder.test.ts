import { describe, it, expect } from 'vitest';
import { buildReviewContext } from './context-builder.js';
import type { PRData } from '../types/index.js';

const mockPR: PRData = {
  title: 'Test PR',
  body: 'Test description',
  author: 'testuser',
  baseBranch: 'main',
  headBranch: 'feature/test',
  labels: [],
  diff: '',
  files: [],
  additions: 10,
  deletions: 5,
  number: 42,
  repoOwner: 'owner',
  repoName: 'repo',
  isDraft: false,
  state: 'open',
};

const MODEL_CONTEXT = 128000;

describe('buildReviewContext', () => {
  it('returns full diff when within token budget', () => {
    const smallDiff = 'diff --git a/foo.ts b/foo.ts\n+ const x = 1;\n';
    const files = [{ filename: 'foo.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 }];

    const ctx = buildReviewContext(mockPR, smallDiff, files, MODEL_CONTEXT);

    expect(ctx.truncated).toBe(false);
    expect(ctx.diff).toBe(smallDiff);
    expect(ctx.estimatedTokens).toBeGreaterThan(0);
  });

  it('truncates when diff exceeds token budget', () => {
    // Create a diff that exceeds budget (4000 token reserve + a small budget)
    const smallBudget = 5000; // very small context window to force truncation
    const bigDiff = 'diff --git a/big.ts b/big.ts\n' + 'x'.repeat(80000);
    const files = [
      { filename: 'big.ts', status: 'modified' as const, additions: 100, deletions: 0, changes: 100 },
      { filename: 'small.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
    ];

    const ctx = buildReviewContext(mockPR, bigDiff, files, smallBudget);

    expect(ctx.truncated).toBe(true);
    expect(ctx.truncationNote).toBeDefined();
    expect(ctx.truncationNote).toContain('TRUNCATED');
  });

  it('prioritizes security-relevant files when truncating', () => {
    const smallBudget = 5500; // force truncation
    // auth.ts will be small and security-relevant; big-file.ts is large
    const authPatch = 'diff --git a/auth.ts b/auth.ts\n+ const authCheck = true;\n';
    const bigPatch = 'diff --git a/big-file.ts b/big-file.ts\n' + '+ const x = 1;\n'.repeat(2000);
    const diff = authPatch + bigPatch;
    const files = [
      { filename: 'auth.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
      { filename: 'big-file.ts', status: 'modified' as const, additions: 2000, deletions: 0, changes: 2000 },
    ];

    const ctx = buildReviewContext(mockPR, diff, files, smallBudget);

    // auth.ts should be kept due to security relevance
    expect(ctx.diff).toContain('auth.ts');
  });

  it('includes file list in output', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n+ test\n';
    const files = [{ filename: 'foo.ts', status: 'added' as const, additions: 1, deletions: 0, changes: 1 }];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT);

    expect(ctx.fileList).toContain('foo.ts');
    expect(ctx.fileList).toContain('added');
  });
});
