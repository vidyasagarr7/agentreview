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

  it('filters out files matching ignore patterns', () => {
    const diff = 'diff --git a/src/app.ts b/src/app.ts\n+ real code\n' +
      'diff --git a/src/app.test.ts b/src/app.test.ts\n+ test code\n' +
      'diff --git a/migrations/001.sql b/migrations/001.sql\n+ CREATE TABLE\n';
    const files = [
      { filename: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/app.test.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
      { filename: 'migrations/001.sql', status: 'added' as const, additions: 1, deletions: 0, changes: 1 },
    ];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT, {
      ignore: ['**/*.test.ts', 'migrations/**'],
    });

    expect(ctx.fileList).toContain('src/app.ts');
    expect(ctx.fileList).not.toContain('app.test.ts');
    expect(ctx.fileList).not.toContain('migrations');
    expect(ctx.diff).not.toContain('app.test.ts');
    expect(ctx.diff).not.toContain('migrations');
  });

  it('returns full context when ignore is empty', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n+ test\n';
    const files = [{ filename: 'foo.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 }];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT, { ignore: [] });
    expect(ctx.fileList).toContain('foo.ts');
  });

  it('filters out files matching ignore patterns', () => {
    const diff = 'diff --git a/src/app.ts b/src/app.ts\n+ real code\n' +
      'diff --git a/src/app.test.ts b/src/app.test.ts\n+ test code\n' +
      'diff --git a/migrations/001.sql b/migrations/001.sql\n+ CREATE TABLE\n';
    const files = [
      { filename: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/app.test.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
      { filename: 'migrations/001.sql', status: 'added' as const, additions: 1, deletions: 0, changes: 1 },
    ];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT, {
      ignore: ['**/*.test.ts', 'migrations/**'],
    });

    expect(ctx.fileList).toContain('src/app.ts');
    expect(ctx.fileList).not.toContain('app.test.ts');
    expect(ctx.fileList).not.toContain('migrations');
    expect(ctx.diff).not.toContain('app.test.ts');
    expect(ctx.diff).not.toContain('migrations');
  });

  it('returns full context when ignore is empty', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n+ test\n';
    const files = [{ filename: 'foo.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 }];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT, { ignore: [] });
    expect(ctx.fileList).toContain('foo.ts');
  });

  it('shows renamed status in file list', () => {
    const diff = 'diff --git a/old.ts b/new.ts\n+ content\n';
    const files = [{ filename: 'new.ts', status: 'renamed' as const, additions: 0, deletions: 0, changes: 0 }];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT);
    expect(ctx.fileList).toContain('renamed');
  });

  it('skips binary files with no patch', () => {
    const diff = 'diff --git a/code.ts b/code.ts\n+ real code\n';
    const files = [
      { filename: 'code.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
      { filename: 'image.png', status: 'added' as const, additions: 0, deletions: 0, changes: 0 },
    ];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT);
    expect(ctx.skippedFiles).toContain('image.png');
  });

  it('includes per-file summaries for dropped files during truncation', () => {
    const smallBudget = 5000;
    const bigPatch = 'diff --git a/huge.ts b/huge.ts\n' + '+ line\n'.repeat(5000);
    const smallPatch = 'diff --git a/tiny.ts b/tiny.ts\n+ ok\n';
    const diff = smallPatch + bigPatch;
    const files = [
      { filename: 'tiny.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 },
      { filename: 'huge.ts', status: 'modified' as const, additions: 5000, deletions: 0, changes: 5000 },
    ];

    const ctx = buildReviewContext(mockPR, diff, files, smallBudget);
    expect(ctx.truncated).toBe(true);
    expect(ctx.diff).toContain('diff omitted');
    expect(ctx.diff).toContain('huge.ts');
  });

  it('handles truncation with more than 5 dropped files', () => {
    const smallBudget = 5000;
    // Create 7 large files that won't fit
    const files = Array.from({ length: 7 }, (_, i) => ({
      filename: `big${i}.ts`,
      status: 'modified' as const,
      additions: 3000,
      deletions: 0,
      changes: 3000,
    }));
    const diff = files.map(f =>
      `diff --git a/${f.filename} b/${f.filename}\n` + '+ x\n'.repeat(3000)
    ).join('');

    const ctx = buildReviewContext(mockPR, diff, files, smallBudget);
    expect(ctx.truncated).toBe(true);
    expect(ctx.truncationNote).toContain('and');
    expect(ctx.truncationNote).toContain('more');
  });

  it('handles files with no extractable diff during truncation', () => {
    const smallBudget = 5200;
    // File exists in file list but diff section doesn't match (simulating missing diff)
    const diff = 'diff --git a/exists.ts b/exists.ts\n+ code\n';
    const files = [
      { filename: 'exists.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1, patch: '+ code' },
      { filename: 'ghost.ts', status: 'modified' as const, additions: 50, deletions: 0, changes: 50, patch: '+ ghost code' },
    ];

    const ctx = buildReviewContext(mockPR, diff, files, smallBudget);
    // ghost.ts has a patch field but no diff section extractable — should get summary
    expect(ctx.diff).toContain('exists.ts');
  });

  it('returns no truncation note when no files are dropped', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n+ x\n';
    const files = [{ filename: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 }];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT);
    expect(ctx.truncationNote).toBeUndefined();
  });

  it('handles options without ignore field', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n+ test\n';
    const files = [{ filename: 'foo.ts', status: 'modified' as const, additions: 1, deletions: 0, changes: 1 }];

    const ctx = buildReviewContext(mockPR, diff, files, MODEL_CONTEXT, {});
    expect(ctx.truncated).toBe(false);
  });
});
