import { describe, it, expect } from 'vitest';
import { normalizeFindings, normalizeLocation, normalizeSummary } from './normalizer.js';
import type { AgentFinding } from '../types/index.js';

const finding: AgentFinding = {
  id: 'sec-001',
  severity: 'HIGH',
  category: 'Auth',
  location: 'src/auth.ts:42',
  summary: 'Authorization bypass found!',
  detail: 'Details here.',
  suggestion: 'Fix it.',
  lenses: ['security'],
};

describe('normalizeFindings', () => {
  it('adds model source fields', () => {
    const result = normalizeFindings([finding], 'gpt-4o');

    expect(result[0].modelSource).toBe('gpt-4o');
    expect(result[0].modelSources).toEqual(['gpt-4o']);
    expect(result[0].agreementCount).toBe(1);
  });

  it('preserves original finding fields', () => {
    const result = normalizeFindings([finding], 'claude');
    expect(result[0].id).toBe('sec-001');
    expect(result[0].severity).toBe('HIGH');
  });
});

describe('normalizeLocation', () => {
  it('strips line numbers', () => {
    expect(normalizeLocation('src/auth.ts:42')).toBe('src/auth.ts');
  });

  it('lowercases and trims', () => {
    expect(normalizeLocation('  SRC/Auth.ts  ')).toBe('src/auth.ts');
  });

  it('normalizes backslashes', () => {
    expect(normalizeLocation('src\\auth.ts:10')).toBe('src/auth.ts');
  });
});

describe('normalizeSummary', () => {
  it('lowercases and removes punctuation', () => {
    expect(normalizeSummary('Authorization Bypass Found!')).toBe('authorization bypass found');
  });

  it('collapses whitespace', () => {
    expect(normalizeSummary('  too   many    spaces  ')).toBe('too many spaces');
  });
});
