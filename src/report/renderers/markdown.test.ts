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
  confidenceScore: 85,
  disposition: 'confirmed' as const,
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

  it('shows validation summary and confidence on findings', () => {
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [criticalFinding],
      validationStats: {
        confirmed: 1,
        uncertain: 0,
        disproven: 2,
        unvalidated: 0,
        filtered: 2,
      },
      stats: {
        ...baseReport.stats,
        total: 1,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 1 },
        byLens: { security: 1 },
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('Validation Summary');
    expect(output).toContain('confidence: 85%');
    expect(output).toContain('Filtered from PR comment: 2');
    expect(output).toContain('Confirmed Findings');
  });

  it('groups uncertain findings separately with a caveat', () => {
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [{ ...criticalFinding, disposition: 'uncertain' as const, confidenceScore: 45 }],
      validationStats: {
        confirmed: 0,
        uncertain: 1,
        disproven: 0,
        unvalidated: 0,
        filtered: 0,
      },
      stats: {
        ...baseReport.stats,
        total: 1,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 1 },
        byLens: { security: 1 },
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('Uncertain Findings');
    expect(output).toContain('⚠️');
    expect(output).toContain('confidence: 45%');
  });

  it('shows unvalidated findings section when disposition is unvalidated and validation stats present', () => {
    const unvalidatedFinding = {
      ...criticalFinding,
      disposition: 'unvalidated' as const,
      confidenceScore: undefined,
    };
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [unvalidatedFinding],
      validationStats: {
        confirmed: 0,
        uncertain: 0,
        disproven: 0,
        unvalidated: 1,
        filtered: 0,
      },
      stats: {
        ...baseReport.stats,
        total: 1,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 1 },
        byLens: { security: 1 },
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('Unvalidated Findings');
    expect(output).toContain('Hardcoded AWS access key');
    // Should NOT contain confidence tag since confidenceScore is undefined
    expect(output).not.toContain('confidence:');
  });

  it('shows errored lens note with error icon', () => {
    const report: ConsolidatedReport = {
      ...baseReport,
      lensesRun: ['security', 'architecture'],
      stats: {
        ...baseReport.stats,
        erroredLenses: ['security'],
        cleanLenses: ['architecture'],
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('❌ This lens encountered an error and could not complete the review.');
  });

  it('shows skipped files section when skippedFiles has entries', () => {
    const report: ConsolidatedReport = {
      ...baseReport,
      skippedFiles: ['binary.jpg', 'generated.lock'],
    };

    const output = renderMarkdown(report);

    expect(output).toContain('Skipped Files');
    expect(output).toContain('`binary.jpg`');
    expect(output).toContain('`generated.lock`');
    expect(output).toContain('binary or no patch');
  });

  it('renders a multi-lens tag when a finding has more than one lens', () => {
    const multiLensFinding = {
      ...criticalFinding,
      lenses: ['security', 'architecture'],
    };
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [multiLensFinding],
      stats: {
        ...baseReport.stats,
        total: 1,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 1 },
        byLens: { security: 1, architecture: 1 },
        cleanLenses: ['quality'],
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('[security + architecture]');
  });

  it('falls back to [unknown] when a finding has no lenses', () => {
    const noLensFinding = {
      ...criticalFinding,
      lenses: [] as string[],
    };
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [noLensFinding],
      stats: {
        ...baseReport.stats,
        total: 1,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 1 },
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('[unknown]');
  });

  it('omits the raw response details when a parse error has no raw payload', () => {
    const parseError: ParseError = {
      type: 'ParseError',
      lensId: 'security',
      raw: '',
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
    expect(output).not.toContain('<details>');
    expect(output).not.toContain('Raw response (truncated)');
  });

  it('uses singular wording when exactly one low-confidence finding is filtered', () => {
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [criticalFinding],
      validationStats: {
        confirmed: 1,
        uncertain: 0,
        disproven: 0,
        unvalidated: 0,
        filtered: 1,
      },
      stats: {
        ...baseReport.stats,
        total: 1,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 1 },
        byLens: { security: 1 },
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('Filtered from PR comment: 1 low-confidence finding hidden.');
    expect(output).not.toContain('findings hidden');
  });

  it('shows plural issue count in lens note when a lens has multiple findings', () => {
    const report: ConsolidatedReport = {
      ...baseReport,
      findings: [criticalFinding, { ...criticalFinding, id: 'sec-002' }],
      stats: {
        ...baseReport.stats,
        total: 2,
        bySeverity: { ...baseReport.stats.bySeverity, CRITICAL: 2 },
        byLens: { security: 2 },
        cleanLenses: ['architecture', 'quality'],
      },
    };

    const output = renderMarkdown(report);

    expect(output).toContain('Found 2 issues.');
  });

  it('shows singular issue count in lens note when a lens has exactly one finding', () => {
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

    expect(output).toContain('Found 1 issue.');
    expect(output).not.toContain('Found 1 issues.');
  });
});
