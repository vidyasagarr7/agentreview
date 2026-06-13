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

  it('includes diagnostic when PR has added files', async () => {
    const prWithAdded: PRData = {
      ...mockPR,
      files: [
        { filename: 'src/auth.ts', status: 'modified', additions: 5, deletions: 1, changes: 6, patch: '+code' },
        { filename: 'src/new-file.ts', status: 'added', additions: 10, deletions: 0, changes: 10, patch: '+new' },
      ],
    };

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

    const result = await buildCodebaseContext(prWithAdded, gh, {
      enabled: true,
      budgetTokens: 8000,
    });

    expect(result).toBeDefined();
    expect(result!.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('newly added files'),
        }),
      ]),
    );
  });

  it('logs verbose output on success when verbose is true', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
      verbose: true,
    });

    expect(result).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[codebase]'),
    );

    consoleSpy.mockRestore();
  });

  it('logs verbose diagnostics when PR has added files', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const prWithAdded: PRData = {
      ...mockPR,
      files: [
        { filename: 'src/auth.ts', status: 'modified', additions: 5, deletions: 1, changes: 6, patch: '+code' },
        { filename: 'src/new-file.ts', status: 'added', additions: 10, deletions: 0, changes: 10, patch: '+new' },
      ],
    };

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

    const result = await buildCodebaseContext(prWithAdded, gh, {
      enabled: true,
      budgetTokens: 8000,
      verbose: true,
    });

    expect(result).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[codebase]'),
    );
    const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(calls.some((msg) => msg.includes('newly added files'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('logs verbose error when GitHub API fails and verbose is true', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const gh = {
      getBaseSha: vi.fn().mockRejectedValue(new Error('API error')),
    } as any;

    const result = await buildCodebaseContext(mockPR, gh, {
      enabled: true,
      budgetTokens: 8000,
      verbose: true,
    });

    expect(result).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('buildCodebaseContext failed'),
    );

    consoleSpy.mockRestore();
  });
});
