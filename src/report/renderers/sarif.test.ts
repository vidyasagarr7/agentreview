import { describe, it, expect } from 'vitest';
import { renderSarif, mapSeverity, parseLocation } from './sarif.js';
import type { ConsolidatedReport } from '../../types/index.js';

const baseReport: ConsolidatedReport = {
  pr: {
    title: 'Add auth endpoint',
    number: 42,
    author: 'dev',
    repoOwner: 'acme',
    repoName: 'api',
    filesChanged: 3,
    additions: 50,
    deletions: 10,
  },
  reviewedAt: '2026-05-12T01:00:00Z',
  lensesRun: ['security', 'architecture', 'quality'],
  findings: [],
  parseErrors: [],
  stats: {
    total: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    byLens: {},
    cleanLenses: ['security', 'architecture', 'quality'],
    erroredLenses: [],
    parseErrorLenses: [],
  },
  confidence: 'NORMAL',
  skippedFiles: [],
};

const finding = {
  id: 'SEC-001',
  severity: 'HIGH' as const,
  category: 'authentication',
  location: 'src/auth.ts:42',
  summary: 'Missing token validation',
  detail: 'The endpoint does not validate JWT tokens before processing.',
  suggestion: 'Add middleware to validate JWT tokens.',
  lenses: ['security'],
  confidenceScore: 85,
};

describe('mapSeverity', () => {
  it('maps CRITICAL to error', () => {
    expect(mapSeverity('CRITICAL')).toBe('error');
  });
  it('maps HIGH to error', () => {
    expect(mapSeverity('HIGH')).toBe('error');
  });
  it('maps MEDIUM to warning', () => {
    expect(mapSeverity('MEDIUM')).toBe('warning');
  });
  it('maps LOW to note', () => {
    expect(mapSeverity('LOW')).toBe('note');
  });
  it('maps INFO to note', () => {
    expect(mapSeverity('INFO')).toBe('note');
  });
});

describe('parseLocation', () => {
  it('parses file:line format', () => {
    expect(parseLocation('src/auth.ts:42')).toEqual({ file: 'src/auth.ts', line: 42 });
  });
  it('handles file without line number', () => {
    expect(parseLocation('src/auth.ts')).toEqual({ file: 'src/auth.ts', line: 1 });
  });
  it('handles deeply nested paths', () => {
    expect(parseLocation('src/a/b/c.ts:100')).toEqual({ file: 'src/a/b/c.ts', line: 100 });
  });
});

describe('renderSarif', () => {
  it('produces valid SARIF 2.1.0 structure', () => {
    const output = JSON.parse(renderSarif(baseReport));
    expect(output.$schema).toBe(
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    );
    expect(output.version).toBe('2.1.0');
    expect(output.runs).toHaveLength(1);
    expect(output.runs[0].tool.driver.name).toBe('AgentReview');
  });

  it('produces valid SARIF with empty findings', () => {
    const output = JSON.parse(renderSarif(baseReport));
    expect(output.runs[0].results).toEqual([]);
    expect(output.runs[0].tool.driver.rules).toEqual([]);
  });

  it('maps findings correctly', () => {
    const report = {
      ...baseReport,
      findings: [finding],
      stats: { ...baseReport.stats, total: 1, bySeverity: { ...baseReport.stats.bySeverity, HIGH: 1 } },
    };
    const output = JSON.parse(renderSarif(report));
    const result = output.runs[0].results[0];
    const rule = output.runs[0].tool.driver.rules[0];

    expect(result.ruleId).toBe('SEC-001');
    expect(result.level).toBe('error');
    expect(result.message.text).toContain('Missing token validation');
    expect(result.message.text).toContain('Suggestion:');
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('src/auth.ts');
    expect(result.locations[0].physicalLocation.region.startLine).toBe(42);
    expect(result.properties.category).toBe('authentication');
    expect(result.properties.confidence).toBe(85);
    expect(result.properties.lenses).toEqual(['security']);

    expect(rule.id).toBe('SEC-001');
    expect(rule.shortDescription.text).toBe('Missing token validation');
    expect(rule.defaultConfiguration.level).toBe('error');
    expect(rule.properties.tags).toEqual(['security']);
  });

  it('includes PR metadata in invocations', () => {
    const output = JSON.parse(renderSarif(baseReport));
    const invocation = output.runs[0].invocations[0];
    expect(invocation.executionSuccessful).toBe(true);
    expect(invocation.properties.pr).toBe('acme/api#42');
    expect(invocation.properties.reviewedAt).toBe('2026-05-12T01:00:00Z');
  });

  it('handles multiple findings with different severities', () => {
    const findings = [
      { ...finding, id: 'SEC-001', severity: 'CRITICAL' as const },
      { ...finding, id: 'SEC-002', severity: 'MEDIUM' as const },
      { ...finding, id: 'SEC-003', severity: 'LOW' as const },
      { ...finding, id: 'SEC-004', severity: 'INFO' as const },
    ];
    const report = { ...baseReport, findings };
    const output = JSON.parse(renderSarif(report));
    expect(output.runs[0].results).toHaveLength(4);
    expect(output.runs[0].results[0].level).toBe('error');
    expect(output.runs[0].results[1].level).toBe('warning');
    expect(output.runs[0].results[2].level).toBe('note');
    expect(output.runs[0].results[3].level).toBe('note');
  });

  it('handles location without line number', () => {
    const report = {
      ...baseReport,
      findings: [{ ...finding, location: 'README.md' }],
    };
    const output = JSON.parse(renderSarif(report));
    const loc = output.runs[0].results[0].locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe('README.md');
    expect(loc.region.startLine).toBe(1);
  });

  it('deduplicates rules when multiple findings share the same id', () => {
    const findings = [
      { ...finding, id: 'SEC-001', summary: 'First occurrence' },
      { ...finding, id: 'SEC-001', summary: 'Duplicate occurrence' },
      { ...finding, id: 'SEC-002', summary: 'Different rule' },
    ];
    const report = { ...baseReport, findings };
    const output = JSON.parse(renderSarif(report));
    const rules = output.runs[0].tool.driver.rules;
    // Should have 2 unique rules, not 3
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('SEC-001');
    expect(rules[0].shortDescription.text).toBe('First occurrence');
    expect(rules[1].id).toBe('SEC-002');
    // But results should still have all 3 findings
    expect(output.runs[0].results).toHaveLength(3);
  });
});

describe('parseLocation edge cases', () => {
  it('returns fallback for empty string (no regex match)', () => {
    expect(parseLocation('')).toEqual({ file: '', line: 1 });
  });
});
