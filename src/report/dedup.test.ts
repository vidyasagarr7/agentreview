import { describe, it, expect } from 'vitest';
import { deduplicateFindings, collectParseErrors } from './dedup.js';
import type { AgentResult, ParseError } from '../types/index.js';

function makeResult(lensId: string, findings: AgentResult['findings']): AgentResult {
  return { lensId, findings, durationMs: 100 };
}

const findingA = {
  id: 'sec-001',
  severity: 'HIGH' as const,
  category: 'Test',
  location: 'src/auth.ts:42',
  summary: 'Hardcoded secret in config',
  detail: 'Detail from security lens',
  suggestion: 'Fix it',
  lenses: ['security'],
};

const findingACopy = {
  ...findingA,
  id: 'qual-001',
  detail: 'Longer detail from quality lens that is more descriptive',
  lenses: ['quality'],
};

const findingB = {
  id: 'sec-002',
  severity: 'MEDIUM' as const,
  category: 'Different',
  location: 'src/other.ts:5',
  summary: 'A completely different finding',
  detail: 'Different detail',
  suggestion: 'Different fix',
  lenses: ['security'],
};

describe('deduplicateFindings', () => {
  it('keeps distinct findings from different lenses', () => {
    const results = [
      makeResult('security', [findingA, findingB]),
      makeResult('quality', []),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped).toHaveLength(2);
  });

  it('merges exact duplicate findings from different lenses', () => {
    const results = [
      makeResult('security', [findingA]),
      makeResult('quality', [findingACopy]),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped).toHaveLength(1);
  });

  it('merged finding has both lens tags', () => {
    const results = [
      makeResult('security', [findingA]),
      makeResult('quality', [findingACopy]),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped[0].lenses).toContain('security');
    expect(deduped[0].lenses).toContain('quality');
  });

  it('merged finding keeps the longer detail', () => {
    const results = [
      makeResult('security', [findingA]),
      makeResult('quality', [findingACopy]),
    ];
    const deduped = deduplicateFindings(results);
    // findingACopy has longer detail
    expect(deduped[0].detail).toBe(findingACopy.detail);
  });

  it('handles empty results', () => {
    const results = [makeResult('security', [])];
    expect(deduplicateFindings(results)).toHaveLength(0);
  });

  it('skips ParseError results (not findings)', () => {
    const parseError: ParseError = { type: 'ParseError', lensId: 'security', raw: 'garbage', message: 'error' };
    const results = [makeResult('security', parseError as unknown as AgentResult['findings'])];
    // Should not crash, returns empty
    expect(() => deduplicateFindings(results)).not.toThrow();
  });
});

describe('collectParseErrors', () => {
  it('collects parse errors from results', () => {
    const parseError: ParseError = { type: 'ParseError', lensId: 'security', raw: 'garbage', message: 'err' };
    const results = [
      makeResult('security', parseError as unknown as AgentResult['findings']),
      makeResult('quality', []),
    ];
    const errors = collectParseErrors(results);
    expect(errors).toHaveLength(1);
    expect(errors[0].lensId).toBe('security');
  });

  it('returns empty when no parse errors', () => {
    const results = [makeResult('security', [findingA])];
    expect(collectParseErrors(results)).toHaveLength(0);
  });
});
