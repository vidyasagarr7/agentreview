import { describe, it, expect } from 'vitest';
import { renderEnsembleSummary, renderEnsembleFinding, renderEnsembleReport } from './renderer.js';
import type { EnsembleResult, ModelFinding } from '../types/index.js';

function mf(overrides: Partial<ModelFinding> = {}): ModelFinding {
  return {
    id: 'sec-001',
    severity: 'HIGH',
    category: 'Auth',
    location: 'src/auth.ts:42',
    summary: 'Auth bypass',
    detail: 'Details.',
    suggestion: 'Fix it.',
    lenses: ['security'],
    modelSource: 'gpt-4o',
    modelSources: ['gpt-4o', 'claude'],
    agreementCount: 2,
    ...overrides,
  };
}

const baseResult: EnsembleResult = {
  modelResults: [
    { label: 'gpt-4o', model: 'gpt-4o', findings: [], durationMs: 5000 },
    { label: 'claude', model: 'claude-sonnet-4-20250514', findings: [], durationMs: 3000 },
  ],
  mergedFindings: [mf()],
  stats: {
    modelsRun: 2,
    modelsSucceeded: 2,
    totalRawFindings: 4,
    mergedFindings: 1,
    unanimousFindings: 1,
    majorityFindings: 0,
    singleSourceFindings: 0,
  },
};

describe('renderEnsembleSummary', () => {
  it('includes model labels and durations', () => {
    const output = renderEnsembleSummary(baseResult);
    expect(output).toContain('gpt-4o');
    expect(output).toContain('claude');
    expect(output).toContain('5.0s');
  });

  it('shows agreement stats', () => {
    const output = renderEnsembleSummary(baseResult);
    expect(output).toContain('Unanimous');
  });
});

describe('renderEnsembleFinding', () => {
  it('shows model attribution', () => {
    const output = renderEnsembleFinding(mf());
    expect(output).toContain('gpt-4o');
    expect(output).toContain('claude');
    expect(output).toContain('Found by');
  });

  it('shows severity emoji', () => {
    const output = renderEnsembleFinding(mf({ severity: 'CRITICAL' }));
    expect(output).toContain('🔴');
  });
});

describe('renderEnsembleReport', () => {
  it('includes PR title and number', () => {
    const output = renderEnsembleReport(baseResult, 'Add auth', 42);
    expect(output).toContain('PR #42');
    expect(output).toContain('Add auth');
  });

  it('groups findings by agreement level', () => {
    const result: EnsembleResult = {
      ...baseResult,
      mergedFindings: [
        mf({ agreementCount: 2 }),
        mf({ id: 'single', agreementCount: 1, modelSources: ['gpt'], summary: 'Single source issue' }),
      ],
      stats: { ...baseResult.stats, unanimousFindings: 1, singleSourceFindings: 1, mergedFindings: 2 },
    };
    const output = renderEnsembleReport(result, 'Test', 1);
    expect(output).toContain('Unanimous');
    expect(output).toContain('Single-Source');
  });

  it('shows error for failed models', () => {
    const result: EnsembleResult = {
      ...baseResult,
      modelResults: [
        ...baseResult.modelResults,
        { label: 'gemini', model: 'gemini-pro', findings: [], error: 'API timeout', durationMs: 60000 },
      ],
    };
    const output = renderEnsembleReport(result, 'Test', 1);
    expect(output).toContain('API timeout');
  });
});
