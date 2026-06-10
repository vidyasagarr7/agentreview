import { describe, expect, it } from 'vitest';
import { applyValidationGate, validateAgentResults } from './validator.js';
import type { AgentFinding, AgentResult, ReviewContext } from '../types/index.js';

function finding(id: string, confidenceScore?: number, overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    id,
    severity: 'MEDIUM',
    category: 'Test',
    location: 'src/test.ts:1',
    summary: id,
    detail: 'detail',
    suggestion: 'suggestion',
    lenses: ['quality'],
    confidenceScore,
    disposition: 'unvalidated',
    ...overrides,
  };
}

const context: ReviewContext = {
  pr: {
    title: 'PR',
    body: '',
    author: 'dev',
    baseBranch: 'main',
    headBranch: 'feature',
    labels: [],
    diff: '',
    files: [
      {
        filename: 'src/test.ts',
        status: 'modified',
        additions: 5,
        deletions: 1,
        changes: 6,
        patch: '@@ -1,2 +1,3 @@\n+const x = 1;',
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
  diff: 'diff --git a/src/test.ts b/src/test.ts\n@@ -1,2 +1,3 @@\n+const x = 1;',
  fileList: 'src/test.ts',
  truncated: false,
  estimatedTokens: 100,
};

describe('applyValidationGate', () => {
  it('always confirms deterministic findings regardless of score', () => {
    const gated = applyValidationGate([
      finding('det-low', 0, { deterministic: true }),
      finding('det-undef', undefined, { deterministic: true }),
    ]);

    expect(gated.map((f) => f.disposition)).toEqual(['confirmed', 'confirmed']);
  });

  it('marks findings by confidence thresholds', () => {
    const gated = applyValidationGate([
      finding('disproven', 39),
      finding('uncertain', 40),
      finding('uncertain-high', 59),
      finding('confirmed', 60),
      finding('confirmed-high', 95),
    ]);

    expect(gated.map((f) => f.disposition)).toEqual([
      'disproven',
      'uncertain',
      'uncertain',
      'confirmed',
      'confirmed',
    ]);
  });

  it('returns unvalidated when the confidence score is undefined', () => {
    const gated = applyValidationGate([finding('no-score', undefined)]);

    expect(gated[0].disposition).toBe('unvalidated');
  });

  it('uses the configured minimum confidence for disproven filtering', () => {
    const gated = applyValidationGate([finding('low', 45)], { minConfidence: 50 });

    expect(gated[0].disposition).toBe('disproven');
  });

  it('still disproves scores below the hard floor of 40 even when minConfidence is lower', () => {
    const gated = applyValidationGate([finding('below-floor', 30)], { minConfidence: 10 });

    expect(gated[0].disposition).toBe('disproven');
  });

  it('defaults minConfidence to 40 when no options are provided', () => {
    const gated = applyValidationGate([finding('at-floor', 40)]);

    expect(gated[0].disposition).toBe('uncertain');
  });

  it('does not mutate the original findings', () => {
    const original = finding('keep', 70);
    const gated = applyValidationGate([original]);

    expect(gated[0]).not.toBe(original);
    expect(original.disposition).toBe('unvalidated');
  });
});

describe('validateAgentResults', () => {
  function llmReturning(scores: Record<string, number>) {
    const calls: Array<{ system: string; user: string }> = [];
    const llm = {
      async complete(system: string, user: string) {
        calls.push({ system, user });
        return JSON.stringify({
          scores: Object.entries(scores).map(([id, confidenceScore]) => ({ id, confidenceScore })),
        });
      },
    };
    return { llm, calls };
  }

  it('returns early without calling the LLM when there are no findings', async () => {
    const calls: string[] = [];
    const llm = {
      async complete() {
        calls.push('called');
        return '';
      },
    };
    const results: AgentResult[] = [
      { lensId: 'quality', findings: [], durationMs: 10 },
    ];

    const out = await validateAgentResults(results, context, llm);

    expect(out).toBe(results);
    expect(calls).toHaveLength(0);
  });

  it('treats parse-error (non-array) findings as having no findings', async () => {
    const calls: string[] = [];
    const llm = {
      async complete() {
        calls.push('called');
        return '';
      },
    };
    const results: AgentResult[] = [
      {
        lensId: 'quality',
        findings: { type: 'ParseError', lensId: 'quality', raw: 'oops', message: 'bad' },
        durationMs: 10,
      },
    ];

    const out = await validateAgentResults(results, context, llm);

    expect(out).toBe(results);
    expect(calls).toHaveLength(0);
  });

  it('skips LLM scoring for deterministic findings and confirms them', async () => {
    const calls: string[] = [];
    const llm = {
      async complete() {
        calls.push('called');
        return '';
      },
    };
    const results: AgentResult[] = [
      {
        lensId: 'security',
        findings: [finding('det-1', undefined, { deterministic: true })],
        durationMs: 5,
      },
    ];

    const out = await validateAgentResults(results, context, llm);

    expect(calls).toHaveLength(0);
    const findings = out[0].findings as AgentFinding[];
    expect(findings[0].disposition).toBe('confirmed');
  });

  it('scores non-deterministic findings via the LLM and applies the gate', async () => {
    const { llm, calls } = llmReturning({ 'llm-1': 87, 'llm-2': 20 });
    const results: AgentResult[] = [
      {
        lensId: 'quality',
        findings: [finding('llm-1'), finding('llm-2')],
        durationMs: 5,
      },
    ];

    const out = await validateAgentResults(results, context, llm);

    expect(calls).toHaveLength(1);
    const findings = out[0].findings as AgentFinding[];
    const byId = new Map(findings.map((f) => [f.id, f]));
    expect(byId.get('llm-1')?.confidenceScore).toBe(87);
    expect(byId.get('llm-1')?.disposition).toBe('confirmed');
    expect(byId.get('llm-2')?.disposition).toBe('disproven');
  });

  it('merges scored findings back by id across multiple results, preserving order', async () => {
    const { llm } = llmReturning({ 'a-1': 90, 'b-1': 50 });
    const results: AgentResult[] = [
      {
        lensId: 'quality',
        findings: [finding('a-1'), finding('det-a', undefined, { deterministic: true })],
        durationMs: 5,
      },
      {
        lensId: 'security',
        findings: [finding('b-1')],
        durationMs: 7,
      },
    ];

    const out = await validateAgentResults(results, context, llm);

    expect(out).toHaveLength(2);
    expect(out[0].lensId).toBe('quality');
    expect(out[1].lensId).toBe('security');

    const first = out[0].findings as AgentFinding[];
    expect(first.map((f) => f.id)).toEqual(['a-1', 'det-a']);
    expect(first[0].disposition).toBe('confirmed');
    expect(first[1].disposition).toBe('confirmed');

    const second = out[1].findings as AgentFinding[];
    expect(second[0].confidenceScore).toBe(50);
    expect(second[0].disposition).toBe('uncertain');
  });

  it('handles a mix of empty and populated findings arrays', async () => {
    const { llm, calls } = llmReturning({ 'real-1': 75 });
    const results: AgentResult[] = [
      { lensId: 'empty', findings: [], durationMs: 1 },
      { lensId: 'quality', findings: [finding('real-1')], durationMs: 3 },
      { lensId: 'empty-2', findings: [], durationMs: 2 },
    ];

    const out = await validateAgentResults(results, context, llm);

    expect(calls).toHaveLength(1);
    expect((out[0].findings as AgentFinding[])).toHaveLength(0);
    expect((out[1].findings as AgentFinding[])[0].disposition).toBe('confirmed');
    expect((out[2].findings as AgentFinding[])).toHaveLength(0);
  });

  it('leaves non-array findings untouched while validating sibling results', async () => {
    const { llm } = llmReturning({ 'real-1': 80 });
    const parseError: AgentResult = {
      lensId: 'broken',
      findings: { type: 'ParseError', lensId: 'broken', raw: 'x', message: 'bad' },
      durationMs: 1,
    };
    const results: AgentResult[] = [
      parseError,
      { lensId: 'quality', findings: [finding('real-1')], durationMs: 3 },
    ];

    const out = await validateAgentResults(results, context, llm);

    expect(out[0]).toBe(parseError);
    expect((out[1].findings as AgentFinding[])[0].disposition).toBe('confirmed');
  });

  it('passes the minConfidence option through to the gate', async () => {
    const { llm } = llmReturning({ 'mid-1': 55 });
    const results: AgentResult[] = [
      { lensId: 'quality', findings: [finding('mid-1')], durationMs: 3 },
    ];

    const out = await validateAgentResults(results, context, llm, { minConfidence: 60 });

    expect((out[0].findings as AgentFinding[])[0].disposition).toBe('disproven');
  });
});
