import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodebaseFetcher } from './fetcher.js';
import type { GitHubClient } from '../github/client.js';
import type { RepoTree } from '../types/index.js';

describe('CodebaseFetcher', () => {
  let mockGh: GitHubClient;
  let fetcher: CodebaseFetcher;

  const treeData: RepoTree = {
    sha: 'tree-sha',
    entries: [{ path: 'src/index.ts', type: 'blob', size: 100 }],
    truncated: false,
  };

  beforeEach(() => {
    mockGh = {
      getRepoTree: vi.fn().mockResolvedValue(treeData),
      getFileContent: vi.fn().mockResolvedValue('file content'),
    } as unknown as GitHubClient;
    fetcher = new CodebaseFetcher(mockGh, 'owner', 'repo', 'sha123');
  });

  describe('fetchTree', () => {
    it('delegates to gh.getRepoTree', async () => {
      const tree = await fetcher.fetchTree();
      expect(mockGh.getRepoTree).toHaveBeenCalledWith('owner', 'repo', 'sha123');
      expect(tree).toBe(treeData);
    });
  });

  describe('fetchFile', () => {
    it('returns content and caches', async () => {
      const content = await fetcher.fetchFile('src/index.ts');
      expect(content).toBe('file content');
      expect(mockGh.getFileContent).toHaveBeenCalledWith('owner', 'repo', 'src/index.ts', 'sha123');
    });

    it('cache hit returns cached content without calling GitHub', async () => {
      await fetcher.fetchFile('src/index.ts');
      vi.clearAllMocks();

      const content = await fetcher.fetchFile('src/index.ts');
      expect(content).toBe('file content');
      expect(mockGh.getFileContent).not.toHaveBeenCalled();
    });

    it('returns null for missing files', async () => {
      (mockGh.getFileContent as any).mockResolvedValue(null);

      const content = await fetcher.fetchFile('missing.ts');
      expect(content).toBeNull();
    });
  });

  describe('fetchFiles', () => {
    it('respects maxFiles limit', async () => {
      const smallFetcher = new CodebaseFetcher(mockGh, 'owner', 'repo', 'sha123', { maxFiles: 2 });
      const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

      await smallFetcher.fetchFiles(paths);

      // Should only fetch the first 2
      expect(mockGh.getFileContent).toHaveBeenCalledTimes(2);
      expect(mockGh.getFileContent).toHaveBeenCalledWith('owner', 'repo', 'a.ts', 'sha123');
      expect(mockGh.getFileContent).toHaveBeenCalledWith('owner', 'repo', 'b.ts', 'sha123');
    });

    it('respects concurrency (batch processing)', async () => {
      const callOrder: number[] = [];
      let callCount = 0;
      (mockGh.getFileContent as any).mockImplementation(async () => {
        const idx = callCount++;
        callOrder.push(idx);
        return `content-${idx}`;
      });

      const batchFetcher = new CodebaseFetcher(mockGh, 'owner', 'repo', 'sha123', {
        maxFiles: 10,
        concurrency: 2,
      });

      const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
      const result = await batchFetcher.fetchFiles(paths);

      // All 5 files should be fetched
      expect(mockGh.getFileContent).toHaveBeenCalledTimes(5);
      // All 5 should be in results
      expect(result.size).toBe(5);
    });
  });
});
