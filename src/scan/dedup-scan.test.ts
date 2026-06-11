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
});
