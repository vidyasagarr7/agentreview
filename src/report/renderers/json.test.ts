import { describe, it, expect } from 'vitest';
import { renderJSON } from './json.js';
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

describe('renderJSON', () => {
  it('returns a valid JSON string for a basic report', () => {
    const output = renderJSON(baseReport);
    expect(typeof output).toBe('string');
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('serializes empty findings and parseErrors arrays', () => {
    const output = renderJSON(baseReport);
    const parsed = JSON.parse(output);
    expect(parsed.findings).toEqual([]);
    expect(parsed.parseErrors).toEqual([]);
  });

  it('round-trips through JSON.parse preserving report data', () => {
    const output = renderJSON(baseReport);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual(baseReport);
    expect(parsed.pr.number).toBe(42);
    expect(parsed.confidence).toBe('NORMAL');
  });

  it('indents output with 2 spaces', () => {
    const output = renderJSON(baseReport);
    expect(output).toContain('\n  "pr": {');
    expect(output).toContain('\n    "title": "Add auth endpoint"');
  });
});
