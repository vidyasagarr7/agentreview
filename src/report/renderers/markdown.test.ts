import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';
import type { ConsolidatedReport, ParseError } from '../../types/index.js';

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

const criticalFinding = {
  id: 'sec-001',
  severity: 'CRITICAL' as const,
  category: 'Hardcoded Secret',
  location: 'src/config.ts:42',
  summary: 'Hardcoded AWS access key',
  detail: 'Found AKIA... key in source',
  suggestion: 'Use env vars',
  lenses: ['security'],
};

describe('renderMarkdown', () => {
  it('includes PR title and number in header', () => {
    const output = renderMarkdown(baseReport);
    expect(output).toContain('PR #42');
    expect(output).toContain('Add auth endpoint');
  });

  it('includes reviewed-by lenses', () => {
    const output = renderMarkdown(baseReport);
    expect(output).toContain('security');
    expect(output).toContain('architecture');
    expect(output).toContain('quality');
  });

  it('shows clean message when no findings', () => {
    const output = renderMarkdown(baseReport);
    expect(output).toContain('No Issues Found');
  });

  it('shows CRITICAL finding with correct emoji', () => {
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [criticalFinding],
      stats: {
        ...baseReport.stats,
        total: 1,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 1 },
        byLens: { security: 1 },
        cleanLenses: ['architecture', 'quality'],
      },
    };
    const output = renderMarkdown(report);
    expect(output).toContain('🔴');
    expect(output).toContain('CRITICAL');
    expect(output).toContain('Hardcoded AWS access key');
  });

  it('shows low confidence warning when confidence is LOW', () => {
    const report: ConsolidatedReport = { ...baseReport, confidence: 'LOW' };
    const output = renderMarkdown(report);
    expect(output).toContain('Review confidence: LOW');
  });

  it('shows parse error prominently', () => {
    const parseError: ParseError = {
      type: 'ParseError',
      lensId: 'security',
      raw: 'garbage output',
      message: '[PARSE ERROR] security lens returned garbled response',
    };
    const report: ConsolidatedReport = {
      ...baseReport,
      parseErrors: [parseError],
      confidence: 'LOW',
      stats: {
        ...baseReport.stats,
        parseErrorLenses: ['security'],
        cleanLenses: ['architecture', 'quality'],
      },
    };
    const output = renderMarkdown(report);
    expect(output).toContain('[PARSE ERROR]');
    expect(output).toContain('security');
    expect(output).toContain('incomplete');
  });

  it('shows lens notes section', () => {
    const output = renderMarkdown(baseReport);
    expect(output).toContain('Lens Notes');
    expect(output).toContain('✅ No issues found.');
  });
});
