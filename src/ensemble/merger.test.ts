import { describe, it, expect } from 'vitest';
import { mergeFindings, tokenOverlap, areSimilarFindings } from './merger.js';
import type { ModelFinding } from '../types/index.js';

function mf(overrides: Partial<ModelFinding> & { id: string; modelSource: string }): ModelFinding {
  return {
    severity: 'HIGH',
    category: 'Auth',
    location: 'src/auth.ts:42',
    summary: 'Authorization check can be bypassed',
    detail: 'Details here.',
    suggestion: 'Fix it.',
    lenses: ['security'],
    modelSources: [overrides.modelSource],
    agreementCount: 1,
    ...overrides,
  };
}

describe('tokenOverlap', () => {
  it('returns 1 for identical strings', () => {
    expect(tokenOverlap('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(tokenOverlap('hello world', 'foo bar')).toBe(0);
  });

  it('returns partial overlap', () => {
    const score = tokenOverlap('auth bypass found', 'authorization bypass detected');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('returns 1 for both empty', () => {
    expect(tokenOverlap('', '')).toBe(1);
  });
});

describe('areSimilarFindings', () => {
  it('returns true for similar findings', () => {
    const a = mf({ id: 'a', modelSource: 'gpt', summary: 'auth bypass vulnerability' });
    const b = mf({ id: 'b', modelSource: 'claude', summary: 'auth bypass vulnerability found' });
    expect(areSimilarFindings(a, b)).toBe(true);
  });

  it('returns false for different files', () => {
    const a = mf({ id: 'a', modelSource: 'gpt', location: 'src/auth.ts:1' });
    const b = mf({ id: 'b', modelSource: 'claude', location: 'src/db.ts:1' });
    expect(areSimilarFindings(a, b)).toBe(false);
  });

  it('returns false for very different summaries', () => {
    const a = mf({ id: 'a', modelSource: 'gpt', summary: 'SQL injection in query builder' });
    const b = mf({ id: 'b', modelSource: 'claude', summary: 'Missing error handling in async flow' });
    expect(areSimilarFindings(a, b)).toBe(false);
  });
});

describe('mergeFindings', () => {
  it('merges similar findings from different models', () => {
    const gptFindings = [mf({ id: 'g1', modelSource: 'gpt-4o', summary: 'auth check can be bypassed' })];
    const claudeFindings = [mf({ id: 'c1', modelSource: 'claude', summary: 'auth check can be bypassed easily' })];

    const merged = mergeFindings([gptFindings, claudeFindings], { totalModels: 2 });

    expect(merged.length).toBe(1);
    expect(merged[0].agreementCount).toBe(2);
    expect(merged[0].modelSources).toContain('gpt-4o');
    expect(merged[0].modelSources).toContain('claude');
  });

  it('keeps distinct findings separate', () => {
    const gptFindings = [mf({ id: 'g1', modelSource: 'gpt', summary: 'SQL injection risk' })];
    const claudeFindings = [mf({ id: 'c1', modelSource: 'claude', summary: 'Missing error handler', location: 'src/db.ts:5' })];

    const merged = mergeFindings([gptFindings, claudeFindings], { totalModels: 2 });

    expect(merged.length).toBe(2);
    expect(merged.every((f) => f.agreementCount === 1)).toBe(true);
  });

  it('sorts by agreementCount desc, then severity', () => {
    const findings1 = [
      mf({ id: 'a', modelSource: 'gpt', severity: 'LOW', summary: 'minor style issue', location: 'src/style.ts:1' }),
    ];
    const findings2 = [
      mf({ id: 'b', modelSource: 'claude', severity: 'CRITICAL', summary: 'authorization check can be bypassed easily', location: 'src/auth.ts:1' }),
    ];
    const findings3 = [
      mf({ id: 'c', modelSource: 'gemini', severity: 'CRITICAL', summary: 'authorization check can be bypassed here', location: 'src/auth.ts:1' }),
    ];

    const merged = mergeFindings([findings1, findings2, findings3], { totalModels: 3 });

    // Auth bypass should be first (2 models agree, CRITICAL)
    expect(merged[0].agreementCount).toBe(2);
    expect(merged[0].severity).toBe('CRITICAL');
  });

  it('uses highest severity when merging', () => {
    const f1 = [mf({ id: 'a', modelSource: 'gpt', severity: 'MEDIUM', summary: 'auth bypass vulnerability' })];
    const f2 = [mf({ id: 'b', modelSource: 'claude', severity: 'CRITICAL', summary: 'auth bypass vulnerability found' })];

    const merged = mergeFindings([f1, f2], { totalModels: 2 });

    expect(merged[0].severity).toBe('CRITICAL');
  });

  it('handles empty input', () => {
    expect(mergeFindings([], { totalModels: 2 })).toEqual([]);
    expect(mergeFindings([[]], { totalModels: 1 })).toEqual([]);
  });
});
