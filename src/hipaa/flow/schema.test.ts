import { describe, it, expect } from 'vitest';
import { FilePhiProfileSchema, VerifierResponseSchema, validateWithRetry, extractJson, formatZodError } from './schema.js';

describe('extractJson', () => {
  it('extracts from markdown code fence', () => {
    const raw = 'Here is the result:\n```json\n{"sources": []}\n```';
    expect(extractJson(raw)).toBe('{"sources": []}');
  });

  it('extracts bare JSON object', () => {
    const raw = 'Some text {"isLeak": true} more text';
    expect(extractJson(raw)).toBe('{"isLeak": true}');
  });

  it('returns trimmed string when no JSON found', () => {
    expect(extractJson('  hello  ')).toBe('hello');
  });
});

describe('FilePhiProfileSchema', () => {
  it('validates a valid profile', () => {
    const profile = {
      sources: [{ name: 'getPatient', line: 10, type: 'fhir-read' }],
      sinks: [{ name: 'console.log', line: 20, type: 'log' }],
      transforms: [],
      exports: [{ name: 'getPatient', containsPhi: true }],
      imports: [{ from: './fhir-client', names: ['FhirClient'] }],
      runtimeFlows: [],
    };
    const result = FilePhiProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it('rejects invalid source type', () => {
    const profile = {
      sources: [{ name: 'fn', line: 1, type: 'invalid-type' }],
      sinks: [],
      transforms: [],
      exports: [],
    };
    const result = FilePhiProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });

  it('defaults optional arrays', () => {
    const profile = {
      sources: [],
      sinks: [],
      transforms: [],
      exports: [],
    };
    const result = FilePhiProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imports).toEqual([]);
      expect(result.data.runtimeFlows).toEqual([]);
    }
  });

  it('validates smart-launch source type', () => {
    const profile = {
      sources: [{ name: 'launchContext', line: 5, type: 'smart-launch' }],
      sinks: [],
      transforms: [],
      exports: [],
    };
    const result = FilePhiProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it('validates fhir-bundle-unwrap mechanism', () => {
    const profile = {
      sources: [],
      sinks: [],
      transforms: [{
        name: 'unwrapBundle',
        line: 15,
        inputParam: 'bundle',
        outputReturn: true,
        mechanism: 'fhir-bundle-unwrap',
      }],
      exports: [],
    };
    const result = FilePhiProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });
});

describe('VerifierResponseSchema', () => {
  it('validates a valid response', () => {
    const response = {
      isLeak: true,
      confidence: 'high',
      explanation: 'PHI flows directly to log without sanitization.',
      baaRelevant: false,
    };
    const result = VerifierResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('rejects invalid confidence', () => {
    const response = {
      isLeak: true,
      confidence: 'very-high',
      explanation: 'test',
      baaRelevant: false,
    };
    const result = VerifierResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe('validateWithRetry', () => {
  it('succeeds on first try with valid JSON', async () => {
    const raw = '{"isLeak": true, "confidence": "high", "explanation": "test", "baaRelevant": false}';
    const result = await validateWithRetry(raw, VerifierResponseSchema, async () => '');
    expect(result).not.toBeNull();
    expect(result!.isLeak).toBe(true);
  });

  it('retries on first failure and succeeds', async () => {
    const bad = '{"isLeak": "not-bool"}';
    const good = '{"isLeak": false, "confidence": "low", "explanation": "sanitized", "baaRelevant": false}';
    let retryCalled = false;

    const result = await validateWithRetry(bad, VerifierResponseSchema, async (error) => {
      retryCalled = true;
      expect(error).toContain('Validation errors');
      return good;
    });

    expect(retryCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.isLeak).toBe(false);
  });

  it('returns null on double failure', async () => {
    const bad = 'not json';
    const result = await validateWithRetry(bad, VerifierResponseSchema, async () => 'still not json');
    expect(result).toBeNull();
  });
});

describe('formatZodError', () => {
  it('formats errors with paths', () => {
    const result = VerifierResponseSchema.safeParse({ isLeak: 'bad' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toContain('isLeak');
    }
  });
});
