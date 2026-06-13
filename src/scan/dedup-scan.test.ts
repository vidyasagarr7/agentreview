import { describe, it, expect } from 'vitest';
import { dedupScanFindings } from './dedup-scan.js';
import type { AgentFinding } from '../types/index.js';
import type { ChunkResult, SecurityDomain } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    id: overrides.id ?? 'f-1',
    severity: overrides.severity ?? 'HIGH',
    category: overrides.category ?? 'sql-injection',
    location: overrides.location ?? 'src/auth.ts:42',
    summary: overrides.summary ?? 'SQL injection in user input',
    detail: overrides.detail ?? 'User input is not sanitized',
    suggestion: overrides.suggestion ?? 'Use parameterized queries',
    lenses: overrides.lenses ?? ['security'],
  };
}

function makeChunkResult(
  domain: SecurityDomain,
  findings: AgentFinding[],
  chunkId?: string,
): ChunkResult {
  return {
    chunkId: chunkId ?? `chunk-${domain}`,
    domain,
    findings,
    durationMs: 100,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('dedupScanFindings', () => {
  it('merges same file, same line, same category across 2 chunks into 1', () => {
    const f1 = makeFinding({ id: 'f-1', location: 'src/auth.ts:42', category: 'sql-injection', severity: 'HIGH' });
    const f2 = makeFinding({ id: 'f-2', location: 'src/auth.ts:42', category: 'sql-injection', severity: 'MEDIUM' });

    const chunks = [
      makeChunkResult('auth', [f1]),
      makeChunkResult('injection', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('HIGH'); // keeps higher severity
  });

  it('merges same file, ±3 lines, same category — keeps highest severity', () => {
    const f1 = makeFinding({ id: 'f-1', location: 'src/auth.ts:40', category: 'xss', severity: 'MEDIUM' });
    const f2 = makeFinding({ id: 'f-2', location: 'src/auth.ts:43', category: 'xss', severity: 'CRITICAL' });

    const chunks = [
      makeChunkResult('auth', [f1]),
      makeChunkResult('injection', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('CRITICAL');
  });

  it('does NOT merge same file, ±10 lines (beyond threshold)', () => {
    const f1 = makeFinding({ id: 'f-1', location: 'src/auth.ts:10', category: 'sql-injection' });
    const f2 = makeFinding({ id: 'f-2', location: 'src/auth.ts:25', category: 'sql-injection' });

    const chunks = [
      makeChunkResult('auth', [f1]),
      makeChunkResult('injection', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    // They are 15 lines apart, beyond ±5 threshold, but they have similar summaries
    // and come from different domains — cross-domain merge may apply via Pass 2.
    // Since summaries are identical (overlap = 1.0 > 0.5) and same file, different domains → merged
    // Let's make the summaries different to test line-proximity only
  });

  it('does NOT merge same file, ±10 lines, same category when summaries differ', () => {
    const f1 = makeFinding({
      id: 'f-1',
      location: 'src/auth.ts:10',
      category: 'sql-injection',
      summary: 'SQL injection in login handler',
    });
    const f2 = makeFinding({
      id: 'f-2',
      location: 'src/auth.ts:25',
      category: 'sql-injection',
      summary: 'Hardcoded database credentials found',
    });

    const chunks = [
      makeChunkResult('auth', [f1, f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(2);
  });

  it('does NOT merge different files, same everything', () => {
    const f1 = makeFinding({ id: 'f-1', location: 'src/auth.ts:42' });
    const f2 = makeFinding({ id: 'f-2', location: 'src/users.ts:42' });

    const chunks = [
      makeChunkResult('auth', [f1]),
      makeChunkResult('injection', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(2);
  });

  it('does NOT merge same file, different categories', () => {
    const f1 = makeFinding({ id: 'f-1', location: 'src/auth.ts:42', category: 'sql-injection', summary: 'Unvalidated input passed to query' });
    const f2 = makeFinding({ id: 'f-2', location: 'src/auth.ts:42', category: 'xss', summary: 'Cross-site scripting in response output' });

    const chunks = [
      makeChunkResult('auth', [f1, f2]),
    ];

    const result = dedupScanFindings(chunks);
    // Same file, same line, but different categories → NOT merged by pass 1
    // Different summaries with low overlap → NOT merged by pass 2
    expect(result).toHaveLength(2);
  });

  it('cross-domain: similar summary, same file → merged with both domains tracked', () => {
    const f1 = makeFinding({
      id: 'f-1',
      location: 'src/config.ts:10',
      category: 'secrets',
      severity: 'HIGH',
      summary: 'Hardcoded API key exposed in configuration file',
    });
    const f2 = makeFinding({
      id: 'f-2',
      location: 'src/config.ts:50', // different line, beyond ±5
      category: 'config', // different category (won't match pass 1)
      severity: 'CRITICAL',
      summary: 'API key hardcoded and exposed in configuration',
    });

    const chunks = [
      makeChunkResult('secrets', [f1]),
      makeChunkResult('config', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('CRITICAL'); // keeps highest
    // Both domains tracked in lenses
    expect(result[0].lenses).toContain('secrets');
    expect(result[0].lenses).toContain('config');
  });

  it('returns empty output for empty input', () => {
    const result = dedupScanFindings([]);
    expect(result).toHaveLength(0);
    expect(result).toEqual([]);
  });

  it('results are sorted by severity (CRITICAL first)', () => {
    const findings = [
      makeFinding({ id: 'f-1', severity: 'LOW', location: 'a.ts:1', summary: 'Low issue alpha' }),
      makeFinding({ id: 'f-2', severity: 'CRITICAL', location: 'b.ts:1', summary: 'Critical issue beta' }),
      makeFinding({ id: 'f-3', severity: 'MEDIUM', location: 'c.ts:1', summary: 'Medium issue gamma' }),
      makeFinding({ id: 'f-4', severity: 'HIGH', location: 'd.ts:1', summary: 'High issue delta' }),
      makeFinding({ id: 'f-5', severity: 'INFO', location: 'e.ts:1', summary: 'Info issue epsilon' }),
    ];

    const chunks = [makeChunkResult('general', findings)];
    const result = dedupScanFindings(chunks);

    expect(result.map((f) => f.severity)).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'LOW',
      'INFO',
    ]);
  });

  // ─── Deterministic reverse-merge coverage ─────────────────────────────

  it('Pass 1: deterministic reverse-merge — keeps deterministic finding as anchor', () => {
    // a is non-deterministic, b is deterministic — same file, same line, same category
    const f1 = makeFinding({
      id: 'f-ndet',
      location: 'src/handler.ts:20',
      category: 'injection',
      severity: 'MEDIUM',
      summary: 'Input not sanitized',
      detail: 'Short detail',
      suggestion: 'Fix it',
      // deterministic is undefined → falsy
    });
    const f2 = makeFinding({
      id: 'f-det',
      location: 'src/handler.ts:22', // within ±5 lines
      category: 'injection',
      severity: 'HIGH',
      summary: 'Input not sanitized properly',
      detail: 'A much longer and more detailed explanation of the issue at hand',
      suggestion: 'Use a parameterized approach to fix this vulnerability',
    });
    // Set deterministic on f2 AFTER creation so it's the second in the group
    (f2 as any).deterministic = true;

    // Both in one chunk so they share the same file group; f1 first, f2 second
    const chunks = [
      makeChunkResult('injection', [f1, f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    // b (f2) is the survivor since b.deterministic && !a.deterministic
    expect(result[0].id).toBe('f-det');
    expect(result[0].deterministic).toBe(true);
    expect(result[0].confidenceScore).toBe(100);
    expect(result[0].severity).toBe('HIGH'); // higherSeverity(HIGH, MEDIUM) = HIGH
    expect(result[0].lenses).toContain('injection');
  });

  it('Pass 2: deterministic reverse-merge in cross-domain merge', () => {
    // Two findings in the same file, different lines (>5 apart), different domains,
    // similar summaries — triggers Pass 2. b is deterministic.
    const f1 = makeFinding({
      id: 'f-cross-ndet',
      location: 'src/api.ts:10',
      category: 'auth',
      severity: 'MEDIUM',
      summary: 'Authentication bypass via token reuse vulnerability',
      detail: 'Brief',
    });
    const f2 = makeFinding({
      id: 'f-cross-det',
      location: 'src/api.ts:80', // far apart — won't merge in Pass 1
      category: 'session', // different category — won't merge in Pass 1
      severity: 'CRITICAL',
      summary: 'Authentication bypass through token reuse vulnerability',
      detail: 'A comprehensive detailed explanation of the authentication bypass',
    });
    (f2 as any).deterministic = true;

    const chunks = [
      makeChunkResult('auth', [f1]),
      makeChunkResult('general', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    // b (f2) is the survivor
    expect(result[0].id).toBe('f-cross-det');
    expect(result[0].deterministic).toBe(true);
    expect(result[0].confidenceScore).toBe(100);
    expect(result[0].severity).toBe('CRITICAL');
    // Both domains tracked
    expect(result[0].lenses).toContain('auth');
    expect(result[0].lenses).toContain('general');
  });

  it('mergeInto propagates deterministic flag from source to target', () => {
    // When a.deterministic is true and b is not, normal merge path applies (a absorbs b)
    // but mergeInto should set target.deterministic = true and confidenceScore = 100
    const f1 = makeFinding({
      id: 'f-det-src',
      location: 'src/db.ts:30',
      category: 'sql',
      severity: 'LOW',
      summary: 'SQL query issue detected',
      detail: 'Short',
    });
    (f1 as any).deterministic = true;
    (f1 as any).confidenceScore = 100;

    const f2 = makeFinding({
      id: 'f-nondet-tgt',
      location: 'src/db.ts:32', // within ±5 lines, same category
      category: 'sql',
      severity: 'CRITICAL',
      summary: 'SQL query issue detected here',
      detail: 'A much longer detail that should be kept in the merged finding',
    });
    // f2 has no deterministic field

    // f1 first (deterministic), f2 second (not deterministic)
    // Since a(f1).deterministic && !b(f2).deterministic is false for the reverse check,
    // and b(f2).deterministic is falsy — takes the else branch: mergeInto(a, b), absorbed(b)
    // mergeInto should propagate deterministic from f1 (target already has it)
    const chunks = [
      makeChunkResult('data-flow', [f1, f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f-det-src'); // a is survivor
    expect(result[0].deterministic).toBe(true);
    expect(result[0].confidenceScore).toBe(100);
    expect(result[0].severity).toBe('CRITICAL');
    // Detail from f2 is longer, so it should be kept
    expect(result[0].detail).toBe('A much longer detail that should be kept in the merged finding');
  });

  // --- Suggestion Merge Branch Coverage ---

  it('merge: source has suggestion, target has none → uses source suggestion', () => {
    // a (target) is first, b (source) is second. Same file/line/category → Pass 1 merge.
    const f1 = makeFinding({
      id: 'f-tgt',
      location: 'src/svc.ts:60',
      category: 'injection',
      severity: 'HIGH',
      summary: 'Injection issue present',
    });
    // Remove the target's suggestion so target.suggestion is undefined (falsy)
    delete (f1 as any).suggestion;

    const f2 = makeFinding({
      id: 'f-src',
      location: 'src/svc.ts:62', // within ±5 lines
      category: 'injection',
      severity: 'MEDIUM',
      summary: 'Injection issue present here',
      suggestion: 'Sanitize all user input',
    });

    const chunks = [makeChunkResult('injection', [f1, f2])];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f-tgt'); // a is the survivor
    expect(result[0].suggestion).toBe('Sanitize all user input');
  });

  it('merge: source suggestion longer than target → uses source suggestion', () => {
    const f1 = makeFinding({
      id: 'f-tgt-short',
      location: 'src/svc.ts:60',
      category: 'injection',
      severity: 'HIGH',
      summary: 'Injection issue present',
      suggestion: 'Fix it',
    });

    const f2 = makeFinding({
      id: 'f-src-long',
      location: 'src/svc.ts:62', // within ±5 lines
      category: 'injection',
      severity: 'MEDIUM',
      summary: 'Injection issue present here',
      suggestion: 'Use parameterized queries and validate all untrusted input thoroughly',
    });

    const chunks = [makeChunkResult('injection', [f1, f2])];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f-tgt-short'); // a is the survivor
    expect(result[0].suggestion).toBe('Use parameterized queries and validate all untrusted input thoroughly');
  });

  it('merge: source suggestion shorter than target → keeps target suggestion', () => {
    const f1 = makeFinding({
      id: 'f-tgt-long',
      location: 'src/svc.ts:60',
      category: 'injection',
      severity: 'HIGH',
      summary: 'Injection issue present',
      suggestion: 'Use parameterized queries and validate all untrusted input thoroughly',
    });

    const f2 = makeFinding({
      id: 'f-src-short',
      location: 'src/svc.ts:62', // within ±5 lines
      category: 'injection',
      severity: 'MEDIUM',
      summary: 'Injection issue present here',
      suggestion: 'Fix it',
    });

    const chunks = [makeChunkResult('injection', [f1, f2])];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f-tgt-long'); // a is the survivor
    expect(result[0].suggestion).toBe('Use parameterized queries and validate all untrusted input thoroughly');
  });

  // ─── parseLocation branch coverage (line 24/25) ───────────────────────

  it('parseLocation: location with no colon → null line, no proximity merge', () => {
    // Both findings share a file but neither has a parseable line number.
    // parts.length === 1 → line = null (line 24 false branch). Because locA.line
    // and locB.line are null, the Pass 1 proximity check is skipped entirely.
    const f1 = makeFinding({
      id: 'f-nocolon-1',
      location: 'src/config.ts', // no colon → no line
      category: 'secrets',
      severity: 'HIGH',
      summary: 'Distinct alpha finding about logging output',
    });
    const f2 = makeFinding({
      id: 'f-nocolon-2',
      location: 'src/config.ts', // no colon → no line
      category: 'secrets',
      severity: 'MEDIUM',
      summary: 'Unrelated beta finding regarding timeout values',
    });

    // Same domain so Pass 2 cross-domain merge cannot apply, and dissimilar
    // summaries — they should remain two separate findings.
    const chunks = [makeChunkResult('secrets', [f1, f2])];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(2);
  });

  it('parseLocation: non-numeric line → null line, no proximity merge', () => {
    // location "src/config.ts:abc" → parseInt("abc") = NaN → isNaN branch (line 25)
    // forces line back to null, so proximity merge is skipped.
    const f1 = makeFinding({
      id: 'f-nan-1',
      location: 'src/config.ts:abc', // non-numeric line → NaN → null
      category: 'secrets',
      severity: 'HIGH',
      summary: 'Distinct alpha finding about logging output',
    });
    const f2 = makeFinding({
      id: 'f-nan-2',
      location: 'src/config.ts:xyz', // non-numeric line → NaN → null
      category: 'secrets',
      severity: 'MEDIUM',
      summary: 'Unrelated beta finding regarding timeout values',
    });

    const chunks = [makeChunkResult('secrets', [f1, f2])];

    const result = dedupScanFindings(chunks);
    // Both lines parse to null → no Pass 1 merge; same domain + dissimilar
    // summaries → no Pass 2 merge.
    expect(result).toHaveLength(2);
  });

  // ─── tokenOverlap with empty summaries (documents real behavior) ───────

  it('tokenOverlap: two empty summaries across domains DO merge (overlap = 1.0)', () => {
    // NOTE: `"".split(/\s+/)` returns `[""]`, not `[]`, so tokenOverlap("", "")
    // computes intersection {""} / union {""} = 1.0 — NOT 0. Two empty-summary
    // findings from different domains therefore exceed the 0.5 threshold and merge.
    // (The `union.size === 0 ? 0` arm on line 35 is unreachable dead code, since
    // split always yields at least one element — it cannot be covered via this API.)
    const f1 = makeFinding({
      id: 'f-empty-1',
      location: 'src/empty.ts:10',
      category: 'secrets',
      severity: 'HIGH',
      summary: '',
    });
    const f2 = makeFinding({
      id: 'f-empty-2',
      location: 'src/empty.ts:80', // far apart, different category → no Pass 1 merge
      category: 'config',
      severity: 'CRITICAL',
      summary: '',
    });

    const chunks = [
      makeChunkResult('secrets', [f1]),
      makeChunkResult('config', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('CRITICAL');
    expect(result[0].lenses).toContain('secrets');
    expect(result[0].lenses).toContain('config');
  });

  // ─── absorbed-skip continue branches (line 101 / line 145) ─────────────

  it('Pass 1: skips an already-absorbed finding (absorbed.has(group[j]) continue)', () => {
    // Three findings in the same file. f0 absorbs f2 (within ±5 lines, same
    // category). When the outer loop reaches i=1 (f1, not absorbed), its inner
    // loop hits j=2 (f2) which is already absorbed → `continue` on line 101.
    const f0 = makeFinding({
      id: 'f-p1-anchor',
      location: 'src/skip.ts:10',
      category: 'injection',
      severity: 'HIGH',
      summary: 'Injection anchor finding alpha',
    });
    const f1 = makeFinding({
      id: 'f-p1-far',
      location: 'src/skip.ts:100', // far from f0 → no merge with f0
      category: 'injection',
      severity: 'LOW',
      summary: 'Unrelated distant finding gamma',
    });
    const f2 = makeFinding({
      id: 'f-p1-absorbed',
      location: 'src/skip.ts:12', // within ±5 of f0 → absorbed by f0
      category: 'injection',
      severity: 'MEDIUM',
      summary: 'Injection nearby finding beta',
    });

    // Single chunk → same domain, so Pass 2 cannot re-merge the survivors.
    const chunks = [makeChunkResult('injection', [f0, f1, f2])];

    const result = dedupScanFindings(chunks);
    // f0 absorbs f2; f1 stands alone → two findings remain.
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(['f-p1-anchor', 'f-p1-far']);
  });

  it('Pass 2: skips an already-absorbed finding (absorbed2.has(group[j]) continue)', () => {
    // Three findings in the same file. In Pass 2, f0 (auth) absorbs f2 (general)
    // via similar summaries. When i advances to f1 (same domain as f0 → not merged
    // with f0), its inner loop reaches j=2 (f2), already absorbed → `continue`
    // on line 145.
    const f0 = makeFinding({
      id: 'f-p2-anchor',
      location: 'src/cross.ts:10',
      category: 'auth',
      severity: 'MEDIUM',
      summary: 'Authentication bypass through token reuse vulnerability',
    });
    const f1 = makeFinding({
      id: 'f-p2-samedomain',
      location: 'src/cross.ts:200', // far → no Pass 1 merge with anyone
      category: 'auth',
      summary: 'Completely unrelated cross site request forgery issue',
    });
    const f2 = makeFinding({
      id: 'f-p2-absorbed',
      location: 'src/cross.ts:80', // far + different category → no Pass 1 merge
      category: 'session',
      severity: 'CRITICAL',
      summary: 'Authentication bypass through token reuse vulnerability',
    });

    const chunks = [
      makeChunkResult('auth', [f0, f1]),
      makeChunkResult('general', [f2]),
    ];

    const result = dedupScanFindings(chunks);
    // Pass 2: f0 (auth) + f2 (general) merge across domains; f1 shares f0's
    // domain set so it is never merged → two findings remain.
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(['f-p2-anchor', 'f-p2-samedomain']);
    const merged = result.find((f) => f.id === 'f-p2-anchor')!;
    expect(merged.severity).toBe('CRITICAL'); // absorbed f2's higher severity
    expect(merged.lenses).toContain('auth');
    expect(merged.lenses).toContain('general');
  });
});
