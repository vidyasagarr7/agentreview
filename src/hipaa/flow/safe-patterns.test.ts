import { describe, it, expect } from 'vitest';
import { SafePatternMatcher } from './safe-patterns.js';
import type { FlowSafePatternConfig, PhiFlowPath } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePath(overrides: Partial<PhiFlowPath> = {}): PhiFlowPath {
  return {
    source: { file: 'src/a.ts', name: 'getPatient', line: 10, type: 'db-query' },
    intermediates: [],
    sink: { file: 'src/b.ts', name: 'logData', line: 20, type: 'log' },
    confidence: 'high',
    severity: 'HIGH',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SafePatternMatcher', () => {
  describe('matchSanitizer — default built-in patterns', () => {
    const matcher = new SafePatternMatcher([]);

    it.each([
      'redactPhi',
      'redact',
      'maskSSN',
      'mask',
      'sanitizeRecord',
      'sanitize',
      'toPublicProfile',
      'toPublic',
    ])('matches built-in sanitizer: %s', (name) => {
      expect(matcher.matchSanitizer(name)).toBe(true);
    });

    it('does not match non-sanitizer names', () => {
      expect(matcher.matchSanitizer('processData')).toBe(false);
      expect(matcher.matchSanitizer('formatRecord')).toBe(false);
    });
  });

  describe('applySafePatterns — sanitizer in intermediates', () => {
    const matcher = new SafePatternMatcher([]);

    it('downgrades confidence from high → medium when sanitizer is in path', () => {
      const path = makePath({
        confidence: 'high',
        intermediates: [{ file: 'src/c.ts', name: 'redactPhi', line: 15, mechanism: 'direct' }],
      });
      const [result] = matcher.applySafePatterns([path]);
      expect(result.confidence).toBe('medium');
    });

    it('downgrades confidence from medium → low when sanitizer is in path', () => {
      const path = makePath({
        confidence: 'medium',
        intermediates: [{ file: 'src/c.ts', name: 'maskSSN', line: 15, mechanism: 'direct' }],
      });
      const [result] = matcher.applySafePatterns([path]);
      expect(result.confidence).toBe('low');
    });

    it('keeps low confidence as low', () => {
      const path = makePath({
        confidence: 'low',
        intermediates: [{ file: 'src/c.ts', name: 'sanitizeRecord', line: 15, mechanism: 'direct' }],
      });
      const [result] = matcher.applySafePatterns([path]);
      expect(result.confidence).toBe('low');
    });
  });

  describe('applySafePatterns — expected sink', () => {
    const matcher = new SafePatternMatcher([
      { pattern: 'auditLog*', type: 'expected-sink' },
    ]);

    it('sets severity to info for expected sink', () => {
      const path = makePath({
        sink: { file: 'src/audit.ts', name: 'auditLogWrite', line: 30, type: 'log' },
      });
      const [result] = matcher.applySafePatterns([path]);
      expect(result.severity).toBe('INFO');
    });
  });

  describe('applySafePatterns — compliant sink', () => {
    const matcher = new SafePatternMatcher([
      { pattern: 'hipaaStore*', type: 'compliant-sink' },
    ]);

    it('sets severity to info for compliant sink', () => {
      const path = makePath({
        sink: { file: 'src/store.ts', name: 'hipaaStoreRecord', line: 40, type: 'storage' },
      });
      const [result] = matcher.applySafePatterns([path]);
      expect(result.severity).toBe('INFO');
    });
  });

  describe('applySafePatterns — projection', () => {
    const matcher = new SafePatternMatcher([
      { pattern: 'selectPublicFields*', type: 'projection' },
    ]);

    it('downgrades confidence when projection is in intermediates', () => {
      const path = makePath({
        confidence: 'high',
        intermediates: [
          { file: 'src/proj.ts', name: 'selectPublicFieldsOnly', line: 25, mechanism: 'direct' },
        ],
      });
      const [result] = matcher.applySafePatterns([path]);
      expect(result.confidence).toBe('medium');
    });
  });

  describe('applySafePatterns — no match', () => {
    const matcher = new SafePatternMatcher([]);

    it('leaves finding unchanged when no patterns match', () => {
      const path = makePath({
        confidence: 'high',
        severity: 'HIGH',
        intermediates: [{ file: 'src/c.ts', name: 'processData', line: 15, mechanism: 'direct' }],
      });
      const [result] = matcher.applySafePatterns([path]);
      expect(result.confidence).toBe('high');
      expect(result.severity).toBe('HIGH');
    });
  });

  describe('custom patterns from config', () => {
    const custom: FlowSafePatternConfig[] = [
      { pattern: 'myCustomFilter*', type: 'sanitizer' },
      { pattern: 'safeSink', type: 'expected-sink' },
    ];
    const matcher = new SafePatternMatcher(custom);

    it('applies custom sanitizer pattern', () => {
      expect(matcher.matchSanitizer('myCustomFilterV2')).toBe(true);
    });

    it('applies custom expected-sink pattern', () => {
      expect(matcher.matchExpectedSink('safeSink')).toBe(true);
    });

    it('still applies built-in patterns alongside custom', () => {
      expect(matcher.matchSanitizer('redactPhi')).toBe(true);
    });
  });

  describe('regex special characters in function names', () => {
    const matcher = new SafePatternMatcher([
      { pattern: 'process.data*', type: 'sanitizer' },
    ]);

    it('does not break on regex special characters — dot is literal', () => {
      // "process.dataClean" should match (dot is literal in glob)
      expect(matcher.matchSanitizer('process.dataClean')).toBe(true);
      // "processXdataClean" should NOT match (dot must be literal)
      expect(matcher.matchSanitizer('processXdataClean')).toBe(false);
    });

    it('handles function names with special regex chars', () => {
      const m2 = new SafePatternMatcher([]);
      // Names with regex special chars shouldn't throw
      expect(m2.matchSanitizer('func(name)')).toBe(false);
      expect(m2.matchSanitizer('arr[0]')).toBe(false);
      expect(m2.matchSanitizer('a+b')).toBe(false);
    });
  });
});
