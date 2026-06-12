// ─── profiler.test.ts — Tests for PHI file profiler ─────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Mock that returns a response based on the file path embedded in the user
// prompt — lets a single LLM produce different outcomes per file.
function pathAwareLlm(responder: (filePath: string) => string): LLMClient {
  return {
    chat: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const match = user.match(/^File: (.+)$/m);
      const filePath = match ? match[1].trim() : '';
      return responder(filePath);
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

// ─── profileFile Timeout Tests ──────────────────────────────────────────────

describe('profileFile timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a timeout error when the LLM call exceeds the timeout', async () => {
    // chat never resolves, so the internal setTimeout wins the race.
    const llm: LLMClient = { chat: vi.fn(() => new Promise<string>(() => {})) };

    const promise = profileFile('src/slow.ts', 'const x = 1;', llm, 1_000);
    const assertion = expect(promise).rejects.toThrow(
      'Timeout after 1000ms: profile src/slow.ts',
    );

    // Advance past the timeout so the rejection fires.
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it('propagates inner promise rejection without waiting for timeout', async () => {
    // Real timers here: we are exercising the rejection path in withTimeout,
    // not the timeout path. The inner promise rejects, so clearTimeout fires
    // and the rejection propagates immediately.
    vi.useRealTimers();

    const llm: LLMClient = {
      chat: vi.fn(async () => {
        throw new Error('LLM network error');
      }),
    };

    await expect(profileFile('src/net.ts', 'const x = 1;', llm, 30_000)).rejects.toThrow(
      'LLM network error',
    );
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

  it('aborts remaining tasks once the failure rate exceeds the threshold', async () => {
    // 12 files, all of which fail validation (LLM returns garbage). Running
    // sequentially (concurrency 1), after 5 completed tasks the failure rate
    // is 100% > 30%, so the aborted flag flips and later tasks return early.
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: `const x = ${i};`,
    }));
    const calledPaths = new Set<string>();
    const llm = pathAwareLlm((filePath) => {
      calledPaths.add(filePath);
      return 'not json garbage }{';
    });

    const results = await profileFiles(files, llm, {
      concurrency: 1,
      maxFiles: 100,
    });

    // No file profiled successfully...
    expect(results.size).toBe(0);
    // ...and the abort short-circuited before every file got an LLM call.
    expect(calledPaths.size).toBeLessThan(files.length);
  });

  it('excludes null profiles from results but still counts the total files', async () => {
    // One file returns garbage (profileFile -> null); the rest are valid.
    const files = [
      { path: 'src/good1.ts', content: 'const a = 1;' },
      { path: 'src/good2.ts', content: 'const b = 2;' },
      { path: 'src/good3.ts', content: 'const c = 3;' },
      { path: 'src/bad.ts', content: 'const d = 4;' },
    ];
    const llm = pathAwareLlm((filePath) =>
      filePath.includes('bad') ? 'totally not json }{' : JSON.stringify(VALID_PROFILE),
    );

    const results = await profileFiles(files, llm, {
      concurrency: 4,
      maxFiles: 100,
    });

    // The null-profiling file is not in results, so size < total files.
    expect(results.size).toBe(3);
    expect(results.size).toBeLessThan(files.length);
    expect(results.has('src/bad.ts')).toBe(false);
    expect(results.has('src/good1.ts')).toBe(true);
  });

  it('counts throws from profileFile as failures', async () => {
    // An LLM whose chat always throws makes profileFile reject, exercising the
    // catch block in profileFiles that counts the throw as a failure rather
    // than letting it escape.
    const files = [
      { path: 'src/a.ts', content: 'const a = 1;' },
      { path: 'src/b.ts', content: 'const b = 2;' },
      { path: 'src/c.ts', content: 'const c = 3;' },
    ];
    const llm: LLMClient = {
      chat: vi.fn(async () => {
        throw new Error('network failure');
      }),
    };

    const results = await profileFiles(files, llm, {
      concurrency: 2,
      maxFiles: 100,
    });

    // Every file threw, so none made it into results.
    expect(results.size).toBe(0);
  });
});
