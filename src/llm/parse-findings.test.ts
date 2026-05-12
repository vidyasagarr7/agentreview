import { describe, it, expect } from 'vitest';
import { parseFindings } from './parse-findings.js';
import type { ParseError } from '../types/index.js';

const validFinding = {
  id: 'sec-001',
  severity: 'CRITICAL',
  category: 'Test',
  location: 'src/foo.ts:10',
  summary: 'Test finding',
  detail: 'Test detail',
  suggestion: 'Fix it',
};

describe('parseFindings', () => {
  it('parses a valid JSON array directly', () => {
    const raw = JSON.stringify([validFinding]);
    const result = parseFindings(raw, 'security');
    expect(Array.isArray(result)).toBe(true);
    expect((result as ReturnType<typeof parseFindings>).length).toBe(1);
  });

  it('parses JSON inside a markdown code fence', () => {
    const raw = '```json\n' + JSON.stringify([validFinding]) + '\n```';
    const result = parseFindings(raw, 'security');
    expect(Array.isArray(result)).toBe(true);
  });

  it('parses JSON inside an unlabeled code fence', () => {
    const raw = '```\n' + JSON.stringify([validFinding]) + '\n```';
    const result = parseFindings(raw, 'security');
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles prose before JSON array', () => {
    const raw = 'Here are my findings for this PR:\n\n' + JSON.stringify([validFinding]);
    const result = parseFindings(raw, 'security');
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles JSON object with findings key', () => {
    const raw = JSON.stringify({ findings: [validFinding] });
    const result = parseFindings(raw, 'security');
    expect(Array.isArray(result)).toBe(true);
    expect((result as ReturnType<typeof parseFindings>).length).toBe(1);
  });

  it('handles trailing commas (common LLM error)', () => {
    const raw = '[{"id": "x", "severity": "HIGH", "category": "Test", "location": "foo.ts:1", "summary": "test", "detail": "detail", "suggestion": "fix",}]';
    const result = parseFindings(raw, 'security');
    // Should either parse successfully or return ParseError — not crash
    expect(result).toBeDefined();
  });

  it('returns ParseError (NOT empty array) for completely garbled response', () => {
    const raw = 'I am unable to review this code. Here are some thoughts: blah blah blah without any JSON.';
    const result = parseFindings(raw, 'security');
    // Must NOT return empty array — must return ParseError
    expect(Array.isArray(result)).toBe(false);
    expect((result as ParseError).type).toBe('ParseError');
    expect((result as ParseError).lensId).toBe('security');
    expect((result as ParseError).message).toContain('[PARSE ERROR]');
  });

  it('ParseError includes truncated raw response', () => {
    const longGarbage = 'x'.repeat(500);
    const result = parseFindings(longGarbage, 'architecture');
    const error = result as ParseError;
    expect(error.type).toBe('ParseError');
    expect(error.raw.length).toBeLessThanOrEqual(300);
  });

  it('returns empty array for empty JSON array []', () => {
    const result = parseFindings('[]', 'security');
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0);
  });

  it('filters out malformed findings but keeps valid ones', () => {
    const malformed = { id: 'bad', severity: 'CRITICAL' }; // missing required fields
    const raw = JSON.stringify([validFinding, malformed]);
    const result = parseFindings(raw, 'quality');
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(1); // only the valid one
  });

  it('rejects invalid severity values', () => {
    const badSeverity = { ...validFinding, severity: 'BLOCKER' };
    const raw = JSON.stringify([badSeverity]);
    const result = parseFindings(raw, 'quality');
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0); // filtered out
  });
});
