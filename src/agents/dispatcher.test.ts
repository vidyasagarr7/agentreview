import { describe, it, expect, vi } from 'vitest';
import { dispatchAgents } from './dispatcher.js';
import type { Lens, ReviewContext, PRData } from '../types/index.js';
import type { LLMClient } from '../llm/client.js';
import type { ParseError } from '../types/index.js';

const mockPR: PRData = {
  title: 'Test',
  body: '',
  author: 'test',
  baseBranch: 'main',
  headBranch: 'feature',
  labels: [],
  diff: 'diff --git a/foo.ts b/foo.ts\n+ test\n',
  files: [],
  additions: 1,
  deletions: 0,
  number: 1,
  repoOwner: 'owner',
  repoName: 'repo',
  isDraft: false,
  state: 'open',
};

const mockContext: ReviewContext = {
  pr: mockPR,
  diff: 'diff content',
  fileList: '- foo.ts',
  truncated: false,
  estimatedTokens: 100,
};

const mockLenses: Lens[] = [
  { id: 'security', name: 'Security', description: '', systemPrompt: 'Security prompt', focusAreas: [] },
  { id: 'quality', name: 'Quality', description: '', systemPrompt: 'Quality prompt', focusAreas: [] },
];

const validFindingResponse = JSON.stringify([{
  id: 'sec-001',
  severity: 'HIGH',
  category: 'Test',
  location: 'foo.ts:1',
  summary: 'Test finding',
  detail: 'Detail here',
  suggestion: 'Fix it',
}]);

describe('dispatchAgents', () => {
  it('dispatches all lenses and returns results', async () => {
    const mockLLM = {
      complete: vi.fn().mockResolvedValue(validFindingResponse),
    } as unknown as LLMClient;

    const results = await dispatchAgents(mockLenses, mockContext, mockLLM);

    expect(results).toHaveLength(2);
    expect(results[0].lensId).toBe('security');
    expect(results[1].lensId).toBe('quality');
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
  });

  it('tags findings with lens ID', async () => {
    const mockLLM = {
      complete: vi.fn().mockResolvedValue(validFindingResponse),
    } as unknown as LLMClient;

    const results = await dispatchAgents(mockLenses, mockContext, mockLLM);
    const secResult = results.find((r) => r.lensId === 'security');

    expect(Array.isArray(secResult?.findings)).toBe(true);
    if (Array.isArray(secResult?.findings)) {
      expect(secResult.findings[0].lenses).toContain('security');
    }
  });

  it('returns ParseError result when LLM returns garbled output', async () => {
    const mockLLM = {
      complete: vi.fn().mockResolvedValue('completely garbled not json at all blah blah'),
    } as unknown as LLMClient;

    const singleLens = [mockLenses[0]];
    const results = await dispatchAgents(singleLens, mockContext, mockLLM);

    expect(results[0].lensId).toBe('security');
    // findings should be a ParseError, not an empty array
    const findings = results[0].findings;
    expect(Array.isArray(findings)).toBe(false);
    expect((findings as ParseError).type).toBe('ParseError');
  });

  it('handles agent LLM error gracefully — other lenses continue', async () => {
    let callCount = 0;
    const mockLLM = {
      complete: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('LLM timeout');
        return Promise.resolve(validFindingResponse);
      }),
    } as unknown as LLMClient;

    const results = await dispatchAgents(mockLenses, mockContext, mockLLM);

    expect(results).toHaveLength(2);
    // One should have error, other should have findings
    const errored = results.find((r) => r.error);
    const succeeded = results.find((r) => !r.error);
    expect(errored).toBeDefined();
    expect(succeeded).toBeDefined();
  });

  it('calls onProgress callbacks', async () => {
    const mockLLM = {
      complete: vi.fn().mockResolvedValue('[]'),
    } as unknown as LLMClient;

    const events: string[] = [];
    await dispatchAgents([mockLenses[0]], mockContext, mockLLM, {
      onProgress: (lensId, status) => events.push(`${lensId}:${status}`),
    });

    expect(events).toContain('security:started');
    expect(events).toContain('security:completed');
  });

  it('times out when LLM hangs and returns error with timeout message', async () => {
    vi.useFakeTimers();
    try {
      const mockLLM = {
        complete: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      } as unknown as LLMClient;

      const resultPromise = dispatchAgents([mockLenses[0]], mockContext, mockLLM, {
        timeoutMs: 5000,
      });

      await vi.runAllTimersAsync();
      const results = await resultPromise;

      expect(results).toHaveLength(1);
      expect(results[0].lensId).toBe('security');
      expect(results[0].error).toMatch(/timed out/i);
      expect(results[0].findings).toEqual([]);
      expect(results[0].durationMs).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls onProgress with durationMs on success', async () => {
    const mockLLM = {
      complete: vi.fn().mockResolvedValue(validFindingResponse),
    } as unknown as LLMClient;

    const progressEvents: Array<{ lensId: string; status: string; durationMs?: number }> = [];
    await dispatchAgents([mockLenses[0]], mockContext, mockLLM, {
      onProgress: (lensId, status, durationMs) => progressEvents.push({ lensId, status, durationMs }),
    });

    const started = progressEvents.find((e) => e.status === 'started');
    const completed = progressEvents.find((e) => e.status === 'completed');
    expect(started).toBeDefined();
    expect(started!.durationMs).toBeUndefined(); // started has no durationMs
    expect(completed).toBeDefined();
    expect(typeof completed!.durationMs).toBe('number');
    expect(completed!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles non-Error thrown by LLM (string coercion)', async () => {
    const mockLLM = {
      complete: vi.fn().mockImplementation(() => {
        // eslint-disable-next-line no-throw-literal
        throw 'raw string error';
      }),
    } as unknown as LLMClient;

    const results = await dispatchAgents([mockLenses[0]], mockContext, mockLLM);

    expect(results).toHaveLength(1);
    expect(results[0].lensId).toBe('security');
    expect(results[0].error).toBe('raw string error');
    expect(results[0].findings).toEqual([]);
  });

  it('handles non-Error thrown by LLM (number coercion)', async () => {
    const mockLLM = {
      complete: vi.fn().mockImplementation(() => {
        // eslint-disable-next-line no-throw-literal
        throw 42;
      }),
    } as unknown as LLMClient;

    const results = await dispatchAgents([mockLenses[0]], mockContext, mockLLM);

    expect(results).toHaveLength(1);
    expect(results[0].error).toBe('42');
    expect(results[0].findings).toEqual([]);
  });

  it('passes hipaaContext option through to buildPrompt without error', async () => {
    const hipaaLens: Lens = { id: 'hipaa', name: 'HIPAA', description: '', systemPrompt: 'HIPAA prompt', focusAreas: [] };
    const mockLLM = {
      complete: vi.fn().mockResolvedValue(validFindingResponse),
    } as unknown as LLMClient;

    const results = await dispatchAgents([hipaaLens], mockContext, mockLLM, {
      hipaaContext: 'PHI handling policy: encrypt all fields',
    });

    expect(results).toHaveLength(1);
    expect(results[0].lensId).toBe('hipaa');
    expect(results[0].error).toBeUndefined();
    // Verify the LLM was called with hipaaContext in the user prompt
    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    const userPrompt = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(userPrompt).toContain('PHI handling policy');
  });

  it('calls onProgress with durationMs on failure', async () => {
    const mockLLM = {
      complete: vi.fn().mockRejectedValue(new Error('LLM error')),
    } as unknown as LLMClient;

    const progressEvents: Array<{ lensId: string; status: string; durationMs?: number }> = [];
    await dispatchAgents([mockLenses[0]], mockContext, mockLLM, {
      onProgress: (lensId, status, durationMs) => progressEvents.push({ lensId, status, durationMs }),
    });

    const failed = progressEvents.find((e) => e.status === 'failed');
    expect(failed).toBeDefined();
    expect(typeof failed!.durationMs).toBe('number');
    expect(failed!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
