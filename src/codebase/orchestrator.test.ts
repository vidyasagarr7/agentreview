import { describe, it, expect, vi } from 'vitest';
import { buildCodebaseContext } from './orchestrator.js';
import type { PRData } from '../types/index.js';

const mockPR: PRData = {
  title: 'Test PR',
  body: '',
  author: 'dev',
  baseBranch: 'main',
  headBranch: 'feat',
  labels: [],
  diff: '',
  files: [
    { filename: 'src/auth.ts', status: 'modified', additions: 5, deletions: 1, changes: 6, patch: '+code' },
  ],
  additions: 5,
  deletions: 1,
  number: 42,
  repoOwner: 'owner',
  repoName: 'repo',
  isDraft: false,
  state: 'open',
};

describe('buildCodebaseContext', () => {
  it('returns undefined when disabled', async () => {
    const gh = {} as any;
    const result = await buildCodebaseContext(mockPR, gh, {
      enabled: false,
      budgetTokens: 8000,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined on GitHub API failure (graceful degradation)', async () => {
    const gh = {
      getBaseSha: vi.fn().mockRejectedValue(new Error('API error')),
    } as any;

    const result = await buildCodebaseContext(mockPR, gh, {
      enabled: true,
      budgetTokens: 8000,
    });

    expect(result).toBeUndefined();
  });

  it('returns CodebaseContext on success', async () => {
    const gh = {
      getBaseSha: vi.fn().mockResolvedValue('abc123'),
      getRepoTree: vi.fn().mockResolvedValue({
        sha: 'abc123',
        entries: [
          { path: 'src/auth.ts', type: 'blob', size: 1000 },
          { path: 'src/utils.ts', type: 'blob', size: 500 },
        ],
        truncated: false,
      }),
      getFileContent: vi.fn().mockResolvedValue("import { hash } from './utils';\nexport function login() {}"),
    } as any;

    const result = await buildCodebaseContext(mockPR, gh, {
      enabled: true,
      budgetTokens: 8000,
    });

    expect(result).toBeDefined();
    expect(result!.baseSha).toBe('abc123');
    expect(result!.parserUsed).toBe('regex');
    expect(result!.rendered).toBeTruthy();
    expect(result!.filesAnalyzed).toBeGreaterThanOrEqual(0);
  });
});
