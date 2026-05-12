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
});
