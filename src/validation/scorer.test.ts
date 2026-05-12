import { describe, expect, it } from 'vitest';
import { scoreFindings } from './scorer.js';
import type { AgentFinding, ReviewContext } from '../types/index.js';

const finding: AgentFinding = {
  id: 'sec-001',
  severity: 'HIGH',
  category: 'Auth',
  location: 'src/auth.ts:12',
  summary: 'Authorization check can be bypassed',
  detail: 'The new endpoint returns user data before checking permissions.',
  suggestion: 'Move the permission check before returning data.',
  lenses: ['security'],
};

const context: ReviewContext = {
  pr: {
    title: 'Add auth route',
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
  diff: 'diff --git a/src/auth.ts b/src/auth.ts\n@@ -10,6 +10,10 @@\n+return user;\n+checkPermission(user);',
  fileList: 'src/auth.ts',
  truncated: false,
  estimatedTokens: 100,
};

describe('scoreFindings', () => {
  it('scores findings from one cheap batched LLM validation call', async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const llm = {
      async complete(system: string, user: string) {
        calls.push({ system, user });
        return JSON.stringify({ scores: [{ id: 'sec-001', confidenceScore: 87 }] });
      },
    };

    const scored = await scoreFindings([finding], context, llm);

    expect(scored[0].confidenceScore).toBe(87);
    expect(scored[0].disposition).toBe('unvalidated');
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain('src/auth.ts');
    expect(calls[0].system).toContain('Do not find new issues');
  });

  it('batches findings in groups of ten', async () => {
    const findings = Array.from({ length: 11 }, (_, i) => ({
      ...finding,
      id: `finding-${i}`,
    }));
    let calls = 0;
    const llm = {
      async complete() {
        const start = calls * 10;
        calls++;
        return JSON.stringify({
          scores: Array.from({ length: calls === 1 ? 10 : 1 }, (_, i) => ({
            id: `finding-${start + i}`,
            confidenceScore: 70,
          })),
        });
      },
    };

    const scored = await scoreFindings(findings, context, llm);

    expect(calls).toBe(2);
    expect(scored.every((f) => f.confidenceScore === 70)).toBe(true);
  });
});
