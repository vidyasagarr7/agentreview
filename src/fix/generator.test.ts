import { describe, it, expect } from 'vitest';
import { generateFixes, isFixable, extractPatch } from './generator.js';
import type { AgentFinding, ReviewContext } from '../types/index.js';

const baseFinding: AgentFinding = {
  id: 'sec-001',
  severity: 'HIGH',
  category: 'Auth',
  location: 'src/auth.ts:12',
  summary: 'Authorization bypass',
  detail: 'The endpoint returns data before checking permissions.',
  suggestion: 'Move permission check before return.',
  lenses: ['security'],
  confidenceScore: 85,
  disposition: 'confirmed',
};

const context: ReviewContext = {
  pr: {
    title: 'Add auth',
    body: '',
    author: 'dev',
    baseBranch: 'main',
    headBranch: 'feature',
    labels: [],
    diff: '',
    files: [
      {
        filename: 'src/auth.ts',
        status: 'modified',
        additions: 5,
        deletions: 1,
        changes: 6,
        patch: '@@ -10,6 +10,10 @@\n+return user;\n+checkPermission(user);',
      },
    ],
    additions: 5,
    deletions: 1,
    number: 1,
    repoOwner: 'owner',
    repoName: 'repo',
    isDraft: false,
    state: 'open',
  },
  diff: 'diff content',
  fileList: 'src/auth.ts',
  truncated: false,
  estimatedTokens: 100,
};

describe('isFixable', () => {
  it('returns true for confirmed CRITICAL/HIGH/MEDIUM findings', () => {
    expect(isFixable({ ...baseFinding, severity: 'CRITICAL', disposition: 'confirmed' })).toBe(true);
    expect(isFixable({ ...baseFinding, severity: 'HIGH', disposition: 'confirmed' })).toBe(true);
    expect(isFixable({ ...baseFinding, severity: 'MEDIUM', disposition: 'uncertain' })).toBe(true);
  });

  it('returns false for LOW/INFO findings', () => {
    expect(isFixable({ ...baseFinding, severity: 'LOW' })).toBe(false);
    expect(isFixable({ ...baseFinding, severity: 'INFO' })).toBe(false);
  });

  it('returns false for disproven findings', () => {
    expect(isFixable({ ...baseFinding, disposition: 'disproven' })).toBe(false);
  });

  it('returns true for unvalidated findings (no disposition)', () => {
    const { disposition, ...noDisp } = baseFinding;
    expect(isFixable(noDisp as AgentFinding)).toBe(true);
  });
});

describe('extractPatch', () => {
  it('extracts from code-fenced diff', () => {
    const raw = 'Here is the fix:\n```diff\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n```\nExplanation: fixed it';
    expect(extractPatch(raw)).toContain('--- a/file.ts');
  });

  it('extracts bare unified diff', () => {
    const raw = 'Some text\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';
    expect(extractPatch(raw)).toContain('--- a/file.ts');
  });

  it('returns trimmed raw for unrecognized format', () => {
    expect(extractPatch('  just text  ')).toBe('just text');
  });
});

describe('generateFixes', () => {
  it('generates fixes for fixable findings', async () => {
    const llm = {
      async complete(_s: string, _u: string) {
        return '```diff\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,2 +10,2 @@\n-return user;\n+checkPermission(user);\n+return user;\n```\nExplanation: Moved permission check before return.';
      },
    };

    const fixes = await generateFixes([baseFinding], context, llm);

    expect(fixes).toHaveLength(1);
    expect(fixes[0].findingId).toBe('sec-001');
    expect(fixes[0].status).toBe('pending');
    expect(fixes[0].patch).toContain('--- a/src/auth.ts');
    expect(fixes[0].explanation).toContain('permission check');
  });

  it('skips non-fixable findings', async () => {
    const lowFinding: AgentFinding = { ...baseFinding, id: 'low-001', severity: 'LOW' };
    const disprovenFinding: AgentFinding = { ...baseFinding, id: 'dis-001', disposition: 'disproven' };

    const llm = { async complete() { return '```diff\npatch\n```\nExplanation: fix'; } };

    const fixes = await generateFixes([lowFinding, disprovenFinding], context, llm);
    expect(fixes).toHaveLength(0);
  });

  it('marks failed fixes when LLM throws', async () => {
    const llm = {
      async complete() { throw new Error('API error'); },
    };

    const fixes = await generateFixes([baseFinding], context, llm);

    expect(fixes).toHaveLength(1);
    expect(fixes[0].status).toBe('failed');
  });

  it('includes finding details in the prompt', async () => {
    const calls: string[] = [];
    const llm = {
      async complete(_s: string, u: string) {
        calls.push(u);
        return '```diff\npatch\n```\nExplanation: fix';
      },
    };

    await generateFixes([baseFinding], context, llm);

    expect(calls[0]).toContain('sec-001');
    expect(calls[0]).toContain('Authorization bypass');
    expect(calls[0]).toContain('src/auth.ts:12');
  });
});
