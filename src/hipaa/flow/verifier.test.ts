import { describe, it, expect, vi } from 'vitest';
import { verifyPaths } from './verifier.js';
import type { PhiFlowPath, LLMClient, FileContentMap } from './types.js';
import type { BaaRegistry } from '../baa-registry.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePath(overrides: Partial<PhiFlowPath> = {}): PhiFlowPath {
  return {
    source: { file: 'src/api/patients.ts', name: 'getPatient', line: 10, type: 'fhir-read' },
    intermediates: [],
    sink: { file: 'src/logging/logger.ts', name: 'logger.info', line: 25, type: 'log' },
    confidence: 'high',
    severity: 'HIGH',
    ...overrides,
  };
}

function makeFileContents(files?: Record<string, string>): FileContentMap {
  const map = new Map<string, string>();
  map.set('src/api/patients.ts', 'const patient = await fhir.read("Patient", id);\nreturn patient;');
  map.set('src/logging/logger.ts', 'logger.info("Request received", { data });\n');
  if (files) {
    for (const [k, v] of Object.entries(files)) map.set(k, v);
  }
  return map;
}

function makeLlm(responses: string[]): LLMClient {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      const resp = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return resp;
    }),
  };
}

const defaultBaaRegistry: BaaRegistry = {
  covered: ['*.amazonaws.com', '*.azure.com'],
  noBaa: ['*.sentry.io', '*.mixpanel.com'],
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('verifyPaths', () => {
  it('returns verified leaks in results', async () => {
    const llm = makeLlm([
      JSON.stringify({
        isLeak: true,
        confidence: 'high',
        explanation: 'PHI is logged directly without sanitization',
        baaRelevant: false,
      }),
    ]);

    const paths = [makePath()];
    const results = await verifyPaths(paths, makeFileContents(), llm, undefined);

    expect(results).toHaveLength(1);
    expect(results[0].isLeak).toBe(true);
    expect(results[0].explanation).toContain('logged directly');
    expect(results[0].severity).toBe('HIGH');
  });

  it('filters out sanitized (non-leak) paths', async () => {
    const llm = makeLlm([
      JSON.stringify({
        isLeak: false,
        confidence: 'high',
        explanation: 'Data is properly de-identified before logging',
        baaRelevant: false,
      }),
    ]);

    const paths = [makePath()];
    const results = await verifyPaths(paths, makeFileContents(), llm, undefined);

    expect(results).toHaveLength(0);
  });

  it('escalates severity for external sink without BAA', async () => {
    const llm = makeLlm([
      JSON.stringify({
        isLeak: true,
        confidence: 'high',
        explanation: 'PHI sent to error tracking without BAA',
        baaRelevant: true,
      }),
    ]);

    const path = makePath({
      sink: { file: 'src/errors/sentry.ts', name: 'https://sentry.io/api/report', line: 5, type: 'error-tracking' },
      severity: 'HIGH',
    });

    const results = await verifyPaths([path], makeFileContents({
      'src/errors/sentry.ts': 'Sentry.captureException(err, { extra: { patient } });',
    }), llm, defaultBaaRegistry);

    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('CRITICAL'); // HIGH → CRITICAL
    expect(results[0].baaStatus).toBe('no-baa');
  });

  it('does not escalate severity for external sink with BAA', async () => {
    const llm = makeLlm([
      JSON.stringify({
        isLeak: true,
        confidence: 'medium',
        explanation: 'PHI sent to S3 but BAA is in place',
        baaRelevant: true,
      }),
    ]);

    const path = makePath({
      sink: { file: 'src/storage/s3.ts', name: 'https://s3.amazonaws.com/bucket', line: 12, type: 'storage' },
      severity: 'MEDIUM',
    });

    const results = await verifyPaths([path], makeFileContents({
      'src/storage/s3.ts': 'await s3.putObject({ Bucket, Key, Body: JSON.stringify(patient) });',
    }), llm, defaultBaaRegistry);

    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('MEDIUM'); // unchanged
    expect(results[0].baaStatus).toBe('covered');
  });

  it('handles Zod validation failure with retry', async () => {
    const badResponse = '{ "not": "valid" }';
    const goodResponse = JSON.stringify({
      isLeak: true,
      confidence: 'high',
      explanation: 'Retry succeeded — PHI is leaked',
      baaRelevant: false,
    });

    // First call returns bad JSON, second (retry) returns good
    const llm = makeLlm([badResponse, goodResponse]);

    const results = await verifyPaths([makePath()], makeFileContents(), llm, undefined);

    expect(results).toHaveLength(1);
    expect(results[0].explanation).toContain('Retry succeeded');
    // LLM should have been called twice (initial + retry)
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('aborts early when failure threshold exceeded', async () => {
    // Create an LLM that always throws
    const llm: LLMClient = {
      chat: vi.fn(async () => { throw new Error('rate limited'); }),
    };

    // Create enough paths so that after the first few fail, the threshold kicks in
    const paths = Array.from({ length: 10 }, (_, i) =>
      makePath({
        source: { file: `src/file${i}.ts`, name: `fn${i}`, line: 1, type: 'fhir-read' },
      }),
    );

    const results = await verifyPaths(paths, makeFileContents(), llm, undefined, {
      concurrency: 1, // serialize to make abort deterministic
      failureAbortThreshold: 0.3,
    });

    expect(results).toHaveLength(0);
    // With concurrency 1 and abort, not all paths should be attempted
    // At least some should be skipped due to abort
    const callCount = (llm.chat as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeLessThan(10);
  });

  it('reports progress via onProgress callback', async () => {
    const llm = makeLlm([
      JSON.stringify({ isLeak: true, confidence: 'high', explanation: 'leak', baaRelevant: false }),
    ]);

    const progressCalls: Array<{ phase: string; current: number; total: number }> = [];
    const onProgress = vi.fn((phase: string, current: number, total: number) => {
      progressCalls.push({ phase, current, total });
    });

    const paths = [makePath(), makePath()];
    await verifyPaths(paths, makeFileContents(), llm, undefined, {
      concurrency: 1,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalled();
    // Should report progress for each path
    expect(progressCalls.some((c) => c.phase === 'verifying' && c.total === 2)).toBe(true);
  });

  it('returns empty array for empty input', async () => {
    const llm = makeLlm([]);
    const results = await verifyPaths([], makeFileContents(), llm, undefined);
    expect(results).toHaveLength(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });
});
