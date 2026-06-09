import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEnsembleReview } from './orchestrator.js';
import type { ModelConfig, ReviewContext, Lens, AgentResult, AgentFinding } from '../types/index.js';

// Mock LLMClient constructor
vi.mock('../llm/client.js', () => ({
  LLMClient: vi.fn(function () { return {}; }),
}));

// Mock dispatchAgents
vi.mock('../agents/dispatcher.js', () => ({
  dispatchAgents: vi.fn(),
}));

import { dispatchAgents } from '../agents/dispatcher.js';
const mockDispatch = vi.mocked(dispatchAgents);

function makeFinding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    id: 'f1',
    severity: 'HIGH',
    category: 'security',
    location: 'src/a.ts:1',
    summary: 'Issue found',
    detail: 'Details',
    suggestion: 'Fix it',
    lenses: ['security'],
    ...overrides,
  };
}

describe('runEnsembleReview', () => {
  const lenses: Lens[] = [
    { id: 'security', name: 'Security', description: 'Security review', systemPrompt: 'Review for security', focusAreas: ['auth'], severity: 'strict' },
  ];

  const context: ReviewContext = {
    pr: {
      title: 'Test PR',
      body: '',
      author: 'alice',
      baseBranch: 'main',
      headBranch: 'feat',
      labels: [],
      diff: 'diff',
      files: [],
      additions: 1,
      deletions: 0,
      number: 1,
      repoOwner: 'o',
      repoName: 'r',
      isDraft: false,
      state: 'open',
    },
    diff: 'diff content',
    fileList: 'src/a.ts',
    truncated: false,
    estimatedTokens: 1000,
  };

  const models: ModelConfig[] = [
    { provider: 'anthropic', model: 'claude-sonnet', apiKey: 'key1', label: 'sonnet' },
    { provider: 'openai', model: 'gpt-4o', apiKey: 'key2', label: 'gpt4o' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches to all models in config', async () => {
    mockDispatch.mockResolvedValue([
      { lensId: 'security', findings: [makeFinding()], durationMs: 100 },
    ]);

    const results = await runEnsembleReview(models, lenses, context);

    expect(results).toHaveLength(2);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('returns results from each model', async () => {
    const findingA = makeFinding({ id: 'a', summary: 'Bug A' });
    const findingB = makeFinding({ id: 'b', severity: 'LOW', summary: 'Bug B' });

    mockDispatch
      .mockResolvedValueOnce([
        { lensId: 'security', findings: [findingA], durationMs: 50 },
      ])
      .mockResolvedValueOnce([
        { lensId: 'security', findings: [findingB], durationMs: 80 },
      ]);

    const results = await runEnsembleReview(models, lenses, context);

    expect(results[0].label).toBe('sonnet');
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0].summary).toBe('Bug A');

    expect(results[1].label).toBe('gpt4o');
    expect(results[1].findings).toHaveLength(1);
    expect(results[1].findings[0].summary).toBe('Bug B');
  });

  it('handles one model failure gracefully', async () => {
    mockDispatch
      .mockResolvedValueOnce([
        { lensId: 'security', findings: [], durationMs: 30 },
      ])
      .mockRejectedValueOnce(new Error('API timeout'));

    const results = await runEnsembleReview(models, lenses, context);

    expect(results).toHaveLength(2);
    expect(results[0].error).toBeUndefined();
    expect(results[1].error).toBe('API timeout');
    expect(results[1].findings).toEqual([]);
  });

  it('returns timing info per model', async () => {
    mockDispatch.mockResolvedValue([]);

    const results = await runEnsembleReview(models, lenses, context);

    for (const result of results) {
      expect(result.durationMs).toBeTypeOf('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
