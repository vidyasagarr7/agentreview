import { describe, expect, it } from 'vitest';
import { applyValidationGate } from './validator.js';
import type { AgentFinding } from '../types/index.js';

function finding(id: string, confidenceScore: number): AgentFinding {
  return {
    id,
    severity: 'MEDIUM',
    category: 'Test',
    location: 'src/test.ts:1',
    summary: id,
    detail: 'detail',
    suggestion: 'suggestion',
    lenses: ['quality'],
    confidenceScore,
    disposition: 'unvalidated',
  };
}

describe('applyValidationGate', () => {
  it('marks findings by confidence thresholds', () => {
    const gated = applyValidationGate([
      finding('disproven', 39),
      finding('uncertain', 40),
      finding('confirmed', 60),
    ]);

    expect(gated.map((f) => f.disposition)).toEqual(['disproven', 'uncertain', 'confirmed']);
  });

  it('uses the configured minimum confidence for disproven filtering', () => {
    const gated = applyValidationGate([finding('low', 45)], { minConfidence: 50 });

    expect(gated[0].disposition).toBe('disproven');
  });
});
