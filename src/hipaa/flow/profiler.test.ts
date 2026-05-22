// ─── profiler.test.ts — Tests for PHI file profiler ─────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { profileFile, profileFiles } from './profiler.js';
import type { LLMClient, FilePhiProfile } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_PROFILE: FilePhiProfile = {
  sources: [{ name: 'fetchPatient', line: 10, type: 'fhir-read' }],
  sinks: [{ name: 'console.log', line: 20, type: 'log' }],
  transforms: [],
  exports: [{ name: 'fetchPatient', containsPhi: true }],
  imports: [{ from: 'fhirclient', names: ['client'] }],
  runtimeFlows: [],
};

function mockLlm(responses: string[]): LLMClient {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return resp;
    }),
  };
}

// ─── profileFile Tests ────────────────────────────────────────────────────────

describe('profileFile', () => {
  it('parses valid LLM response correctly', async () => {
    const llm = mockLlm([JSON.stringify(VALID_PROFILE)]);
    const result = await profileFile('src/patient.ts', 'const x = 1;', llm);

    expect(result).not.toBeNull();
    expect(result!.sources).toHaveLength(1);
    expect(result!.sources[0].type).toBe('fhir-read');
    expect(result!.sinks[0].type).toBe('log');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('retries on invalid type and passes on corrected response', async () => {
    const invalidProfile = {
      ...VALID_PROFILE,
      sources: [{ name: 'fetchPatient', line: 10, type: 'INVALID_TYPE' }],
    };
    const llm = mockLlm([
      JSON.stringify(invalidProfile),
      JSON.stringify(VALID_PROFILE),
    ]);
    const result = await profileFile('src/patient.ts', 'const x = 1;', llm);

    expect(result).not.toBeNull();
    expect(result!.sources[0].type).toBe('fhir-read');
    expect(llm.chat).toHaveBeenCalledTimes(2); // initial + retry
  });

  it('returns null when LLM returns garbage twice', async () => {
    const llm = mockLlm([
      'this is not json at all }{}{',
      'still garbage !@#$%',
    ]);
    const result = await profileFile('src/patient.ts', 'const x = 1;', llm);

    expect(result).toBeNull();
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });
});

// ─── profileFiles Tests ───────────────────────────────────────────────────────

describe('profileFiles', () => {
  it('caps files at maxFiles', async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({
      path: `src/file${i}.ts`,
      content: `const x = ${i};`,
    }));
    const llm = mockLlm([JSON.stringify(VALID_PROFILE)]);

    const results = await profileFiles(files, llm, {
      concurrency: 5,
      maxFiles: 100,
    });

    // Should have profiled at most 100 files
    expect(llm.chat).toHaveBeenCalledTimes(100);
    expect(results.size).toBeLessThanOrEqual(100);
  });

  it('skips empty files without making LLM calls', async () => {
    const files = [
      { path: 'src/empty.ts', content: '' },
      { path: 'src/whitespace.ts', content: '   \n\t  ' },
      { path: 'src/real.ts', content: 'const x = 1;' },
    ];
    const llm = mockLlm([JSON.stringify(VALID_PROFILE)]);

    const results = await profileFiles(files, llm, {
      concurrency: 2,
      maxFiles: 100,
    });

    // Only the non-empty file should trigger an LLM call
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(results.size).toBe(1);
    expect(results.has('src/real.ts')).toBe(true);
  });

  it('reports progress via onProgress callback', async () => {
    const files = [
      { path: 'src/a.ts', content: 'const a = 1;' },
      { path: 'src/b.ts', content: 'const b = 2;' },
    ];
    const llm = mockLlm([JSON.stringify(VALID_PROFILE)]);
    const progressCalls: Array<[string, number, number, string | undefined]> = [];

    await profileFiles(files, llm, {
      concurrency: 1,
      maxFiles: 10,
      onProgress: (phase, current, total, detail) => {
        progressCalls.push([phase, current, total, detail]);
      },
    });

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0][0]).toBe('profiling');
    expect(progressCalls[0][2]).toBe(2); // total
    expect(progressCalls[1][1]).toBe(2); // current after both done
  });
});
