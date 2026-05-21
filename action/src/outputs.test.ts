import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @actions/core before importing the module under test
vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
}));

import * as core from '@actions/core';
import { setOutputs, type ReviewResult } from './outputs.js';

const mockedSetOutput = vi.mocked(core.setOutput);

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    report: '## Review\nAll good.',
    findings: [
      { severity: 'HIGH' },
      { severity: 'MEDIUM' },
    ],
    stats: {
      total: 2,
      bySeverity: { HIGH: 1, MEDIUM: 1 },
    },
    shouldFail: false,
    ...overrides,
  };
}

function outputMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, value] of mockedSetOutput.mock.calls) {
    map[name as string] = value as string;
  }
  return map;
}

describe('setOutputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets all outputs correctly', () => {
    const result = makeResult({
      commentId: 42,
      stats: { total: 3, bySeverity: { CRITICAL: 1, HIGH: 1, LOW: 1 } },
    });

    setOutputs(result);

    const out = outputMap();
    expect(out['findings-count']).toBe('3');
    expect(out['critical-count']).toBe('1');
    expect(out['high-count']).toBe('1');
    expect(out['review-comment-id']).toBe('42');
    expect(out['report']).toBe(result.report);
    expect(out['exit-code']).toBe('0');
  });

  it('sets critical and high counts correctly', () => {
    setOutputs(makeResult({
      stats: { total: 5, bySeverity: { CRITICAL: 2, HIGH: 3 } },
    }));

    const out = outputMap();
    expect(out['critical-count']).toBe('2');
    expect(out['high-count']).toBe('3');
  });

  it('defaults missing severity to 0', () => {
    setOutputs(makeResult({
      stats: { total: 1, bySeverity: { LOW: 1 } },
    }));

    const out = outputMap();
    expect(out['critical-count']).toBe('0');
    expect(out['high-count']).toBe('0');
  });

  it('truncates report if >1MB', () => {
    const bigReport = 'x'.repeat(2 * 1024 * 1024); // 2 MB
    setOutputs(makeResult({ report: bigReport }));

    const out = outputMap();
    const reportBytes = Buffer.byteLength(out['report'], 'utf8');
    // Must be at most ~1 MB (with truncation warning)
    expect(reportBytes).toBeLessThanOrEqual(1_048_576 + 100); // small tolerance for warning text
    expect(out['report']).toContain('⚠️ Report truncated');
  });

  it('does not truncate report at exactly 1MB', () => {
    // 1 MB exactly should NOT be truncated
    const exactReport = 'a'.repeat(1_048_576);
    setOutputs(makeResult({ report: exactReport }));

    const out = outputMap();
    expect(out['report']).not.toContain('⚠️ Report truncated');
    expect(out['report']).toBe(exactReport);
  });

  it('exit-code reflects shouldFail', () => {
    setOutputs(makeResult({ shouldFail: true }));
    expect(outputMap()['exit-code']).toBe('2');

    vi.clearAllMocks();

    setOutputs(makeResult({ shouldFail: false }));
    expect(outputMap()['exit-code']).toBe('0');
  });

  it('handles optional commentId (undefined)', () => {
    setOutputs(makeResult()); // no commentId

    const out = outputMap();
    expect(out['review-comment-id']).toBe('');
  });

  it('handles commentId = 0', () => {
    setOutputs(makeResult({ commentId: 0 }));

    const out = outputMap();
    expect(out['review-comment-id']).toBe('0');
  });
});
