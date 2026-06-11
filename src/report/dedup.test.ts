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

  it('returns empty array when ParseError result has no findings array', () => {
    const parseError: ParseError = { type: 'ParseError', lensId: 'security', raw: 'garbage', message: 'error' };
    const results = [makeResult('security', parseError as unknown as AgentResult['findings'])];
    const deduped = deduplicateFindings(results);
    expect(deduped).toHaveLength(0);
  });

  // ── Pass 2: Adjacent-severity merge tests ─────────────────────────────────

  it('Pass 2: merges findings with adjacent severity and >80% summary overlap', () => {
    const highFinding = {
      id: 'p2-001',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Short detail',
      suggestion: 'Sanitize inputs',
      lenses: ['security'],
    };
    const mediumFinding = {
      id: 'p2-002',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'SQL injection vulnerability in user input handler found',
      detail: 'A much longer and more descriptive detail about the issue',
      suggestion: 'Sanitize inputs properly',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [highFinding]),
      makeResult('quality', [mediumFinding]),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped).toHaveLength(1);
    // Should keep higher severity (HIGH)
    expect(deduped[0].severity).toBe('HIGH');
  });

  it('Pass 2: merged finding keeps longer detail text', () => {
    const highFinding = {
      id: 'p2-003',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Short',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const mediumFinding = {
      id: 'p2-004',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'SQL injection vulnerability in user input handler found',
      detail: 'A much longer and more descriptive detail about the SQL injection issue',
      suggestion: 'Sanitize',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [highFinding]),
      makeResult('quality', [mediumFinding]),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].detail).toBe(mediumFinding.detail);
  });

  it('Pass 2: merged finding has union of lens tags', () => {
    const highFinding = {
      id: 'p2-005',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Detail',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const mediumFinding = {
      id: 'p2-006',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'SQL injection vulnerability in user input handler found',
      detail: 'Detail 2',
      suggestion: 'Fix 2',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [highFinding]),
      makeResult('quality', [mediumFinding]),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped[0].lenses).toContain('security');
    expect(deduped[0].lenses).toContain('quality');
  });

  it('Pass 2: does NOT merge findings with >80% overlap but non-adjacent severity', () => {
    const criticalFinding = {
      id: 'p2-007',
      severity: 'CRITICAL' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Detail',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const lowFinding = {
      id: 'p2-008',
      severity: 'LOW' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'SQL injection vulnerability in user input handler found',
      detail: 'Detail 2',
      suggestion: 'Fix 2',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [criticalFinding]),
      makeResult('quality', [lowFinding]),
    ];
    const deduped = deduplicateFindings(results);
    // CRITICAL and LOW are 3 ranks apart — should NOT merge
    expect(deduped).toHaveLength(2);
  });

  it('Pass 2: does NOT merge findings with adjacent severity but <80% overlap', () => {
    const highFinding = {
      id: 'p2-009',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Detail',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const mediumFinding = {
      id: 'p2-010',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'Completely unrelated memory leak in connection pool',
      detail: 'Detail 2',
      suggestion: 'Fix 2',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [highFinding]),
      makeResult('quality', [mediumFinding]),
    ];
    const deduped = deduplicateFindings(results);
    // Adjacent severity but different summaries — should NOT merge
    expect(deduped).toHaveLength(2);
  });

  it('Pass 1: keeps existing longer detail when incoming duplicate has shorter detail', () => {
    const longDetailFinding = {
      id: 'p1-001',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:42',
      summary: 'Hardcoded secret in config',
      detail: 'A long and descriptive detail string from the first lens',
      suggestion: 'Fix it',
      lenses: ['security'],
    };
    const shortDetailFinding = {
      ...longDetailFinding,
      id: 'p1-002',
      detail: 'Short',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [longDetailFinding]),
      makeResult('quality', [shortDetailFinding]),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped).toHaveLength(1);
    // Incoming detail is shorter — keep the first, longer detail
    expect(deduped[0].detail).toBe(longDetailFinding.detail);
  });

  it('tokenOverlap: merges findings whose summaries normalize to empty (both-empty token sets)', () => {
    const highFinding = {
      id: 'to-001',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: '!!!',
      detail: 'Detail one',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const mediumFinding = {
      id: 'to-002',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: '---',
      detail: 'Detail two',
      suggestion: 'Fix 2',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [highFinding]),
      makeResult('quality', [mediumFinding]),
    ];
    const deduped = deduplicateFindings(results);
    // Both summaries normalize to empty → tokenOverlap returns 1 → merge
    expect(deduped).toHaveLength(1);
    expect(deduped[0].severity).toBe('HIGH');
  });

  it('Pass 2: skips a finding in the outer loop once it has been absorbed', () => {
    const highFinding = {
      id: 'skip-001',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Detail',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const mediumFinding = {
      id: 'skip-002',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'SQL injection vulnerability in user input handler found',
      detail: 'Detail 2',
      suggestion: 'Fix 2',
      lenses: ['quality'],
    };
    const infoFinding = {
      id: 'skip-003',
      severity: 'INFO' as const,
      category: 'Style',
      location: 'src/auth.ts:99',
      summary: 'Unrelated naming convention nitpick on a local variable',
      detail: 'Detail 3',
      suggestion: 'Rename',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [highFinding, mediumFinding, infoFinding]),
    ];
    const deduped = deduplicateFindings(results);
    // high + medium merge; when outer loop reaches the medium (already merged),
    // it continues. info is unrelated. Result: merged high + info = 2 findings.
    expect(deduped).toHaveLength(2);
    expect(deduped.some((f) => f.severity === 'HIGH')).toBe(true);
    expect(deduped.some((f) => f.severity === 'INFO')).toBe(true);
  });

  it('Pass 2: skips an already-absorbed finding revisited in the inner loop', () => {
    const highFinding = {
      id: 'jskip-001',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Detail',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const infoFinding = {
      id: 'jskip-002',
      severity: 'INFO' as const,
      category: 'Style',
      location: 'src/auth.ts:50',
      summary: 'Unrelated naming convention nitpick on a local variable',
      detail: 'Detail 2',
      suggestion: 'Rename',
      lenses: ['quality'],
    };
    const mediumFinding = {
      id: 'jskip-003',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'SQL injection vulnerability in user input handler found',
      detail: 'Detail 3',
      suggestion: 'Fix 3',
      lenses: ['perf'],
    };
    // Order matters: high (i=0) absorbs medium (j=2); info (i=1) then revisits
    // medium (j=2), which is already merged → inner-loop continue.
    const results = [
      makeResult('security', [highFinding, infoFinding, mediumFinding]),
    ];
    const deduped = deduplicateFindings(results);
    // high (merged with medium) + info = 2 findings
    expect(deduped).toHaveLength(2);
    expect(deduped.some((f) => f.severity === 'HIGH')).toBe(true);
    expect(deduped.some((f) => f.severity === 'INFO')).toBe(true);
  });

  it('Pass 2: keeps a\'s longer detail when absorbed b has shorter detail', () => {
    const highFinding = {
      id: 'p2-013',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'A much longer and more descriptive detail about the issue here',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const mediumFinding = {
      id: 'p2-014',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/auth.ts:15',
      summary: 'SQL injection vulnerability in user input handler found',
      detail: 'Short',
      suggestion: 'Fix 2',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [highFinding]),
      makeResult('quality', [mediumFinding]),
    ];
    const deduped = deduplicateFindings(results);
    expect(deduped).toHaveLength(1);
    // b (medium) has shorter detail — keep a's longer detail
    expect(deduped[0].detail).toBe(highFinding.detail);
  });

  it('Pass 2: does NOT merge findings on different files even with matching severity and summary', () => {
    const findingFileA = {
      id: 'p2-011',
      severity: 'HIGH' as const,
      category: 'Security',
      location: 'src/auth.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Detail',
      suggestion: 'Fix',
      lenses: ['security'],
    };
    const findingFileB = {
      id: 'p2-012',
      severity: 'MEDIUM' as const,
      category: 'Security',
      location: 'src/other.ts:10',
      summary: 'SQL injection vulnerability in user input handler',
      detail: 'Detail 2',
      suggestion: 'Fix 2',
      lenses: ['quality'],
    };
    const results = [
      makeResult('security', [findingFileA]),
      makeResult('quality', [findingFileB]),
    ];
    const deduped = deduplicateFindings(results);
    // Different files — should NOT merge
    expect(deduped).toHaveLength(2);
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

  it('collects only parse errors from a mix of valid findings and errors', () => {
    const parseError1: ParseError = { type: 'ParseError', lensId: 'security', raw: 'bad json', message: 'parse failed' };
    const parseError2: ParseError = { type: 'ParseError', lensId: 'perf', raw: 'also bad', message: 'parse failed again' };
    const results = [
      makeResult('security', parseError1 as unknown as AgentResult['findings']),
      makeResult('quality', [findingA, findingB]),
      makeResult('perf', parseError2 as unknown as AgentResult['findings']),
    ];
    const errors = collectParseErrors(results);
    expect(errors).toHaveLength(2);
    expect(errors[0].lensId).toBe('security');
    expect(errors[1].lensId).toBe('perf');
  });

  it('returns empty when results have empty findings arrays', () => {
    const results = [
      makeResult('security', []),
      makeResult('quality', []),
    ];
    expect(collectParseErrors(results)).toHaveLength(0);
  });
});
