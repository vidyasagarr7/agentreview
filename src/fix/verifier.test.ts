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

  it('extracts an embedded array when surrounded by prose (extractJson fallback)', async () => {
    const llm = {
      async complete() {
        return 'Here: [{"findingId":"sec-001","passed":true,"issues":[]}] end';
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results).toHaveLength(1);
    expect(results[0].findingId).toBe('sec-001');
    expect(results[0].passed).toBe(true);
    expect(results[0].issues).toEqual([]);
  });

  it('parses the wrapped {results:[...]} format', async () => {
    const llm = {
      async complete() {
        return JSON.stringify({
          results: [{ findingId: 'sec-001', passed: false, issues: ['regression'] }],
        });
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results).toHaveLength(1);
    expect(results[0].findingId).toBe('sec-001');
    expect(results[0].passed).toBe(false);
    expect(results[0].issues).toContain('regression');
  });

  it('parses embedded JSON object (extractJson object fallback)', async () => {
    const llm = {
      async complete() {
        return 'Some preamble {"results": [{"findingId":"sec-001","passed":true,"issues":[]}]} trailing text';
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results).toHaveLength(1);
    expect(results[0].findingId).toBe('sec-001');
    expect(results[0].passed).toBe(true);
  });

  it('handles completely unparseable LLM output', async () => {
    const llm = {
      async complete() {
        return 'This is not JSON at all, no braces, no brackets';
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    // When extractJson throws, it should be caught and mark all as failed
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
  });

  it('falls through to throw when JSON has braces but no valid object', async () => {
    const llm = {
      async complete() {
        // Has { but the content between braces is not valid JSON
        // and no [ ] either — forces the objStart path to try and fail
        return 'text with { broken json but } no array';
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
  });

  it('filters out malformed records missing findingId or passed', async () => {
    const llm = {
      async complete() {
        return JSON.stringify([
          { findingId: 'sec-001', passed: true, issues: [] },
          { findingId: 123, passed: true, issues: [] },  // findingId not a string
          { passed: true, issues: [] },  // missing findingId
          { findingId: 'sec-003', issues: [] },  // missing passed
          null,  // null entry
        ]);
      },
    };

    const results = await verifyFixes([makeFix('sec-001'), makeFix('sec-002')], context, llm);

    // Only sec-001 has a valid entry; sec-002 should be marked missing
    expect(results).toHaveLength(2);
    expect(results[0].findingId).toBe('sec-001');
    expect(results[0].passed).toBe(true);
    expect(results[1].findingId).toBe('sec-002');
    expect(results[1].passed).toBe(false);
  });

  it('filters non-string values from issues array', async () => {
    const llm = {
      async complete() {
        return JSON.stringify([
          { findingId: 'sec-001', passed: false, issues: ['real issue', 42, null, 'another issue'] },
        ]);
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results[0].issues).toEqual(['real issue', 'another issue']);
  });

  it('handles non-array issues field', async () => {
    const llm = {
      async complete() {
        return JSON.stringify([
          { findingId: 'sec-001', passed: false, issues: 'not an array' },
        ]);
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    expect(results[0].issues).toEqual([]);
  });

  it('returns empty results when LLM returns an object without results array', async () => {
    const llm = {
      async complete() {
        return JSON.stringify({ status: 'ok', message: 'no results key here' });
      },
    };

    const results = await verifyFixes([makeFix('sec-001')], context, llm);

    // Object without .results array → falls to empty records → fix marked missing
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].issues[0]).toContain('missing');
  });

  it('includes pending fixes as applicable', async () => {
    const llm = {
      async complete() {
        return JSON.stringify([{ findingId: 'sec-001', passed: true, issues: [] }]);
      },
    };

    const results = await verifyFixes([makeFix('sec-001', 'pending')], context, llm);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('marks a fix as missing when the LLM omits its findingId entry', async () => {
    const llm = {
      async complete() {
        return JSON.stringify([{ findingId: 'sec-001', passed: true, issues: [] }]);
      },
    };

    const results = await verifyFixes([makeFix('sec-001'), makeFix('sec-002')], context, llm);

    expect(results).toHaveLength(2);
    expect(results[1].findingId).toBe('sec-002');
    expect(results[1].passed).toBe(false);
    expect(results[1].issues[0]).toContain('missing');
  });
});
