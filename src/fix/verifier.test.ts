import { describe, it, expect } from 'vitest';
import { verifyFixes } from './verifier.js';
import type { FixAttempt, AgentFinding, ReviewContext } from '../types/index.js';

const finding: AgentFinding = {
  id: 'sec-001',
  severity: 'HIGH',
  category: 'Auth',
  location: 'src/auth.ts:12',
  summary: 'Auth bypass',
  detail: 'detail',
  suggestion: 'fix it',
  lenses: ['security'],
};

const context: ReviewContext = {
  pr: {
    title: 'Test PR',
    body: '',
    author: 'dev',
    baseBranch: 'main',
    headBranch: 'feat',
    labels: [],
    diff: '',
    files: [],
    additions: 5,
    deletions: 1,
    number: 42,
    repoOwner: 'owner',
    repoName: 'repo',
    isDraft: false,
    state: 'open',
  },
  diff: '',
  fileList: '',
  truncated: false,
  estimatedTokens: 50,
};

function makeFix(id: string, status: FixAttempt['status'] = 'applied'): FixAttempt {
  return {
    findingId: id,
    finding: { ...finding, id },
    patch: '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new',
    explanation: 'Fixed',
    status,
  };
}

describe('verifyFixes', () => {
  it('returns passed=true for good fixes', async () => {
    const llm = {
      async complete() {
        return JSON.stringify([{ findingId: 'sec-001', passed: true, issues: [] }]);
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].issues).toEqual([]);
  });

  it('returns passed=false with issues for bad fixes', async () => {
    const llm = {
      async complete() {
        return JSON.stringify([{
          findingId: 'sec-001',
          passed: false,
          issues: ['Introduces null pointer dereference'],
        }]);
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results[0].passed).toBe(false);
    expect(results[0].issues).toContain('Introduces null pointer dereference');
  });

  it('batches in groups of 5', async () => {
    let callCount = 0;
    const llm = {
      async complete() {
        callCount++;
        const batch = callCount === 1
          ? Array.from({ length: 5 }, (_, i) => ({ findingId: `f-${i}`, passed: true, issues: [] }))
          : [{ findingId: 'f-5', passed: true, issues: [] }];
        return JSON.stringify(batch);
      },
    };

    const fixes = Array.from({ length: 6 }, (_, i) => makeFix(`f-${i}`));
    const results = await verifyFixes(fixes, context, llm);

    expect(callCount).toBe(2);
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('skips non-applicable fixes (failed status)', async () => {
    const llm = { async complete() { return '[]'; } };

    const results = await verifyFixes([makeFix('sec-001', 'failed')], context, llm);

    expect(results).toHaveLength(0);
  });

  it('handles LLM errors gracefully', async () => {
    const llm = { async complete() { throw new Error('API down'); } };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].issues[0]).toContain('failed');
  });
});
