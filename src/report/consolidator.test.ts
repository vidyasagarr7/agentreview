import { describe, it, expect } from 'vitest';
import { consolidate } from './consolidator.js';
import type { AgentResult, PRData, ParseError } from '../types/index.js';

const mockPR: PRData = {
  title: 'Test PR',
  body: '',
  author: 'tester',
  baseBranch: 'main',
  headBranch: 'feature',
  labels: [],
  diff: '',
  files: [],
  additions: 10,
  deletions: 5,
  number: 1,
  repoOwner: 'owner',
  repoName: 'repo',
  isDraft: false,
  state: 'open',
};

const criticalFinding = {
  id: 'sec-001',
  severity: 'CRITICAL' as const,
  category: 'Auth',
  location: 'src/auth.ts:1',
  summary: 'Critical issue',
  detail: 'Details',
  suggestion: 'Fix',
  lenses: ['security'],
};

const lowFinding = {
  id: 'qual-001',
  severity: 'LOW' as const,
  category: 'Style',
  location: 'src/util.ts:10',
  summary: 'Minor issue',
  detail: 'Details',
  suggestion: 'Fix',
  lenses: ['quality'],
};

const highFinding = {
  id: 'arch-001',
  severity: 'HIGH' as const,
  category: 'Coupling',
  location: 'src/service.ts:5',
  summary: 'High issue',
  detail: 'Details',
  suggestion: 'Fix',
  lenses: ['architecture'],
};

describe('consolidate', () => {
  it('sorts findings by severity (CRITICAL first)', () => {
    const results: AgentResult[] = [
      { lensId: 'quality', findings: [lowFinding], durationMs: 100 },
      { lensId: 'security', findings: [criticalFinding], durationMs: 100 },
      { lensId: 'architecture', findings: [highFinding], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.findings[0].severity).toBe('CRITICAL');
    expect(report.findings[1].severity).toBe('HIGH');
    expect(report.findings[2].severity).toBe('LOW');
  });

  it('computes correct stats', () => {
    const results: AgentResult[] = [
      { lensId: 'security', findings: [criticalFinding], durationMs: 100 },
      { lensId: 'quality', findings: [lowFinding], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.stats.total).toBe(2);
    expect(report.stats.bySeverity.CRITICAL).toBe(1);
    expect(report.stats.bySeverity.LOW).toBe(1);
  });

  it('sets confidence to LOW when an agent errored', () => {
    const results: AgentResult[] = [
      { lensId: 'security', findings: [], error: 'Timeout', durationMs: 60000 },
      { lensId: 'quality', findings: [lowFinding], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.confidence).toBe('LOW');
    expect(report.stats.erroredLenses).toContain('security');
  });

  it('sets confidence to LOW when a ParseError occurred', () => {
    const parseError: ParseError = { type: 'ParseError', lensId: 'security', raw: 'garbage', message: 'error' };
    const results: AgentResult[] = [
      { lensId: 'security', findings: parseError as unknown as AgentResult['findings'], durationMs: 100 },
      { lensId: 'quality', findings: [], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.confidence).toBe('LOW');
    expect(report.parseErrors).toHaveLength(1);
    expect(report.stats.parseErrorLenses).toContain('security');
  });

  it('sets confidence to NORMAL when all agents succeed', () => {
    const results: AgentResult[] = [
      { lensId: 'security', findings: [], durationMs: 100 },
      { lensId: 'quality', findings: [lowFinding], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.confidence).toBe('NORMAL');
  });

  it('identifies clean lenses', () => {
    const results: AgentResult[] = [
      { lensId: 'security', findings: [], durationMs: 100 },
      { lensId: 'quality', findings: [lowFinding], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.stats.cleanLenses).toContain('security');
    expect(report.stats.cleanLenses).not.toContain('quality');
  });

  it('includes lensesRun in report', () => {
    const results: AgentResult[] = [
      { lensId: 'security', findings: [], durationMs: 100 },
      { lensId: 'architecture', findings: [], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.lensesRun).toEqual(['security', 'architecture']);
  });

  it('filters disproven findings and reports validation stats', () => {
    const results: AgentResult[] = [
      {
        lensId: 'security',
        findings: [
          { ...criticalFinding, confidenceScore: 85, disposition: 'confirmed' },
          { ...lowFinding, confidenceScore: 52, disposition: 'uncertain' },
          { ...highFinding, confidenceScore: 20, disposition: 'disproven' },
        ],
        durationMs: 100,
      },
    ];

    const report = consolidate(results, mockPR);

    expect(report.findings.map((f) => f.id)).toEqual(['sec-001', 'qual-001']);
    expect(report.validationStats).toEqual({
      confirmed: 1,
      uncertain: 1,
      disproven: 1,
      unvalidated: 0,
      filtered: 1,
    });
  });

  it('breaks severity ties by lens rank (security before quality)', () => {
    const secMedium = {
      ...criticalFinding,
      id: 'sec-tie',
      severity: 'MEDIUM' as const,
      location: 'src/zzz.ts:1',
      lenses: ['security'],
    };
    const qualMedium = {
      ...lowFinding,
      id: 'qual-tie',
      severity: 'MEDIUM' as const,
      location: 'src/aaa.ts:1',
      lenses: ['quality'],
    };
    const results: AgentResult[] = [
      { lensId: 'quality', findings: [qualMedium], durationMs: 100 },
      { lensId: 'security', findings: [secMedium], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.findings.map((f) => f.id)).toEqual(['sec-tie', 'qual-tie']);
  });

  it('breaks severity and lens ties by file path alphabetically', () => {
    const findingB = {
      ...criticalFinding,
      id: 'sec-b',
      location: 'src/bbb.ts:1',
      lenses: ['security'],
    };
    const findingA = {
      ...criticalFinding,
      id: 'sec-a',
      location: 'src/aaa.ts:1',
      lenses: ['security'],
    };
    const results: AgentResult[] = [
      { lensId: 'security', findings: [findingB, findingA], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    expect(report.findings.map((f) => f.id)).toEqual(['sec-a', 'sec-b']);
  });

  it('ranks unknown lenses after known lenses (fallback to LENS_ORDER.length)', () => {
    const customMedium = {
      ...criticalFinding,
      id: 'custom-001',
      severity: 'MEDIUM' as const,
      location: 'src/zzz.ts:1',
      lenses: ['custom'],
    };
    const qualMedium = {
      ...lowFinding,
      id: 'qual-med',
      severity: 'MEDIUM' as const,
      location: 'src/aaa.ts:1',
      lenses: ['quality'],
    };
    const results: AgentResult[] = [
      { lensId: 'custom', findings: [customMedium], durationMs: 100 },
      { lensId: 'quality', findings: [qualMedium], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR);

    // quality (index 2) should sort before custom (index 3 = LENS_ORDER.length)
    expect(report.findings.map((f) => f.id)).toEqual(['qual-med', 'custom-001']);
  });

  it('skips deduplication when noDedup is true', () => {
    const results: AgentResult[] = [
      { lensId: 'security', findings: [criticalFinding], durationMs: 100 },
      { lensId: 'security', findings: [criticalFinding], durationMs: 100 },
    ];

    const report = consolidate(results, mockPR, true);

    expect(report.findings).toHaveLength(2);
    expect(report.stats.total).toBe(2);
  });
});
