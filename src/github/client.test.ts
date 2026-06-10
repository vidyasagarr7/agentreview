import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from './client.js';

const mockOctokit = {
  pulls: {
    get: vi.fn(),
    listFiles: vi.fn(),
    createReview: vi.fn(),
  },
  issues: {
    createComment: vi.fn(),
    updateComment: vi.fn(),
    listComments: vi.fn(),
    create: vi.fn(),
  },
  repos: {
    get: vi.fn(),
  },
  rest: {
    git: { getTree: vi.fn() },
    repos: { getContent: vi.fn() },
    pulls: { get: vi.fn() },
  },
  request: vi.fn(),
  paginate: vi.fn(),
};

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function () { return mockOctokit; }),
}));

const octokit = mockOctokit;

describe('GitHubClient', () => {
  let client: GitHubClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GitHubClient('fake-token');
  });

  describe('getPR', () => {
    it('returns PRData with correct fields', async () => {
      octokit.pulls.get.mockResolvedValue({
        data: {
          title: 'Fix bug',
          body: 'Fixes #42',
          user: { login: 'alice' },
          base: { ref: 'main', sha: 'abc123' },
          head: { ref: 'fix-bug' },
          labels: [{ name: 'bug' }],
          additions: 10,
          deletions: 5,
          number: 1,
          draft: false,
          state: 'open',
          merged_at: null,
        },
      });
      octokit.request.mockResolvedValue({ data: 'diff content' });
      octokit.paginate.mockResolvedValue([
        {
          filename: 'src/index.ts',
          status: 'modified',
          additions: 10,
          deletions: 5,
          changes: 15,
          patch: '@@ -1,5 +1,10 @@',
        },
      ]);

      const pr = await client.getPR('owner', 'repo', 1);

      expect(pr.title).toBe('Fix bug');
      expect(pr.body).toBe('Fixes #42');
      expect(pr.author).toBe('alice');
      expect(pr.baseBranch).toBe('main');
      expect(pr.headBranch).toBe('fix-bug');
      expect(pr.labels).toEqual(['bug']);
      expect(pr.additions).toBe(10);
      expect(pr.deletions).toBe(5);
      expect(pr.number).toBe(1);
      expect(pr.isDraft).toBe(false);
      expect(pr.state).toBe('open');
      expect(pr.files).toHaveLength(1);
      expect(pr.files[0].filename).toBe('src/index.ts');
    });

    it('throws GitHubAuthError on 401', async () => {
      octokit.pulls.get.mockRejectedValue({ status: 401 });

      await expect(client.getPR('owner', 'repo', 1)).rejects.toThrow(GitHubAuthError);
    });

    it('throws GitHubNotFoundError on 404', async () => {
      octokit.pulls.get.mockRejectedValue({ status: 404 });

      await expect(client.getPR('owner', 'repo', 99)).rejects.toThrow(GitHubNotFoundError);
    });

    it('throws GitHubRateLimitError on 403 with rate limit headers', async () => {
      octokit.pulls.get.mockRejectedValue({
        status: 403,
        response: {
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1700000000',
          },
        },
      });

      await expect(client.getPR('owner', 'repo', 1)).rejects.toThrow(GitHubRateLimitError);
    });
  });

  describe('postOrUpdateComment', () => {
    it('creates new comment when no existing comment found', async () => {
      octokit.paginate.mockResolvedValue([]);
      octokit.issues.createComment.mockResolvedValue({ data: { id: 100 } });

      await client.postOrUpdateComment('owner', 'repo', 1, 'Review body');

      expect(octokit.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 1,
        body: '<!-- agentreview -->\nReview body',
      });
      expect(octokit.issues.updateComment).not.toHaveBeenCalled();
    });

    it('updates existing comment when marker is found', async () => {
      octokit.paginate.mockResolvedValue([
        { id: 42, body: '<!-- agentreview -->\nOld review' },
      ]);
      octokit.issues.updateComment.mockResolvedValue({});

      await client.postOrUpdateComment('owner', 'repo', 1, 'New review');

      expect(octokit.issues.updateComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 42,
        body: '<!-- agentreview -->\nNew review',
      });
      expect(octokit.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe('getDefaultBranch', () => {
    it('returns branch name', async () => {
      octokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });

      const branch = await client.getDefaultBranch('owner', 'repo');
      expect(branch).toBe('main');
    });
  });

  describe('createIssue', () => {
    it('returns number and url', async () => {
      octokit.issues.create.mockResolvedValue({
        data: { number: 5, html_url: 'https://github.com/owner/repo/issues/5' },
      });

      const result = await client.createIssue('owner', 'repo', 'Title', 'Body', ['bug']);
      expect(result).toEqual({ number: 5, url: 'https://github.com/owner/repo/issues/5' });
    });
  });

  describe('getPR edge cases', () => {
    it('handles null body and missing user', async () => {
      octokit.pulls.get.mockResolvedValue({
        data: {
          title: 'No body PR',
          body: null,
          user: null,
          base: { ref: 'main', sha: 'abc123' },
          head: { ref: 'fix' },
          labels: [],
          additions: 0,
          deletions: 0,
          number: 2,
          draft: undefined,
          state: 'open',
          merged_at: null,
        },
      });
      octokit.request.mockResolvedValue({ data: '' });
      octokit.paginate.mockResolvedValue([]);

      const pr = await client.getPR('owner', 'repo', 2);
      expect(pr.body).toBe('');
      expect(pr.author).toBe('unknown');
      expect(pr.isDraft).toBe(false);
    });

    it('returns merged state when merged_at is set', async () => {
      octokit.pulls.get.mockResolvedValue({
        data: {
          title: 'Merged PR',
          body: 'done',
          user: { login: 'bob' },
          base: { ref: 'main', sha: 'abc' },
          head: { ref: 'feat' },
          labels: [{ name: 'enhancement' }, { name: undefined }],
          additions: 5,
          deletions: 3,
          number: 3,
          draft: true,
          state: 'closed',
          merged_at: '2026-01-01T00:00:00Z',
        },
      });
      octokit.request.mockResolvedValue({ data: '' });
      octokit.paginate.mockResolvedValue([]);

      const pr = await client.getPR('owner', 'repo', 3);
      expect(pr.state).toBe('merged');
      expect(pr.isDraft).toBe(true);
    });

    it('throws GitHubAuthError on 403 without rate limit', async () => {
      octokit.pulls.get.mockRejectedValue({
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '10' } },
      });

      await expect(client.getPR('owner', 'repo', 1)).rejects.toThrow(GitHubAuthError);
    });

    it('throws GitHubRateLimitError with unknown time when no reset header', async () => {
      octokit.pulls.get.mockRejectedValue({
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });

      await expect(client.getPR('owner', 'repo', 1)).rejects.toThrow(GitHubRateLimitError);
      try {
        await client.getPR('owner', 'repo', 1);
      } catch (e: any) {
        expect(e.message).toContain('unknown time');
      }
    });

    it('re-throws unknown errors', async () => {
      const unknownError = new Error('network failure');
      octokit.pulls.get.mockRejectedValue(unknownError);

      await expect(client.getPR('owner', 'repo', 1)).rejects.toThrow('network failure');
    });

    it('throws GitHubAuthError on 403 with no response headers', async () => {
      octokit.pulls.get.mockRejectedValue({
        status: 403,
        response: undefined,
      });

      await expect(client.getPR('owner', 'repo', 1)).rejects.toThrow(GitHubAuthError);
    });
  });

  describe('getFiles', () => {
    it('warns when file count exceeds threshold', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manyFiles = Array.from({ length: 301 }, (_, i) => ({
        filename: `file${i}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ +1 @@',
      }));
      octokit.paginate.mockResolvedValue(manyFiles);

      const files = await client.getFiles('owner', 'repo', 1);
      expect(files).toHaveLength(301);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('301 files'));
      warnSpy.mockRestore();
    });
  });

  describe('getFileContent', () => {
    it('returns file content decoded from base64', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          size: 100,
          content: Buffer.from('hello world').toString('base64'),
        },
      });

      const content = await client.getFileContent('owner', 'repo', 'src/index.ts', 'main');
      expect(content).toBe('hello world');
    });

    it('returns null for directory (array response)', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({ data: [{ type: 'dir' }] });

      const content = await client.getFileContent('owner', 'repo', 'src', 'main');
      expect(content).toBeNull();
    });

    it('returns null for non-file type', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: 'symlink', size: 10 },
      });

      const content = await client.getFileContent('owner', 'repo', 'link', 'main');
      expect(content).toBeNull();
    });

    it('returns null for large files (>512KB)', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: 'file', size: 600000, content: 'abc' },
      });

      const content = await client.getFileContent('owner', 'repo', 'big.bin', 'main');
      expect(content).toBeNull();
    });

    it('returns null when content field is missing', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: 'file', size: 100 },
      });

      const content = await client.getFileContent('owner', 'repo', 'empty.ts', 'main');
      expect(content).toBeNull();
    });

    it('returns null on API error', async () => {
      octokit.rest.repos.getContent.mockRejectedValue(new Error('not found'));

      const content = await client.getFileContent('owner', 'repo', 'missing.ts', 'main');
      expect(content).toBeNull();
    });
  });

  describe('getBaseSha', () => {
    it('returns base SHA from PR', async () => {
      octokit.rest.pulls.get.mockResolvedValue({
        data: { base: { sha: 'base-sha-123' } },
      });

      const sha = await client.getBaseSha('owner', 'repo', 1);
      expect(sha).toBe('base-sha-123');
    });
  });

  describe('createInlineReview', () => {
    it('creates a review with inline comments', async () => {
      octokit.pulls.createReview.mockResolvedValue({ data: { id: 999 } });

      const result = await client.createInlineReview(
        'owner', 'repo', 1, 'Review body',
        [{ path: 'src/index.ts', line: 10, body: 'Fix this' }],
        'REQUEST_CHANGES',
      );

      expect(result).toEqual({ reviewId: 999 });
      expect(octokit.pulls.createReview).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
        event: 'REQUEST_CHANGES',
        body: 'Review body',
        comments: [{ path: 'src/index.ts', line: 10, body: 'Fix this', side: 'RIGHT' }],
      });
    });
  });

  describe('getRepoTree', () => {
    it('returns tree entries', async () => {
      octokit.rest.git.getTree.mockResolvedValue({
        data: {
          sha: 'tree-sha',
          tree: [
            { path: 'src/index.ts', type: 'blob', size: 100 },
            { path: 'src', type: 'tree' },
          ],
          truncated: false,
        },
      });

      const tree = await client.getRepoTree('owner', 'repo', 'abc123');
      expect(tree.sha).toBe('tree-sha');
      expect(tree.truncated).toBe(false);
      expect(tree.entries).toEqual([
        { path: 'src/index.ts', type: 'blob', size: 100 },
        { path: 'src', type: 'tree', size: undefined },
      ]);
    });

    it('handles missing path and truncated fields', async () => {
      octokit.rest.git.getTree.mockResolvedValue({
        data: {
          sha: 'sha',
          tree: [{ type: 'blob', size: 50 }],
          truncated: undefined,
        },
      });

      const tree = await client.getRepoTree('owner', 'repo', 'sha');
      expect(tree.entries[0].path).toBe('');
      expect(tree.truncated).toBe(false);
    });

    it('handles null tree', async () => {
      octokit.rest.git.getTree.mockResolvedValue({
        data: { sha: 'sha', tree: undefined, truncated: true },
      });

      const tree = await client.getRepoTree('owner', 'repo', 'sha');
      expect(tree.entries).toEqual([]);
      expect(tree.truncated).toBe(true);
    });
  });
});
