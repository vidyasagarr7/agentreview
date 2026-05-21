import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from './client.js';

const mockOctokit = {
  pulls: {
    get: vi.fn(),
    listFiles: vi.fn(),
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
  Octokit: vi.fn(() => mockOctokit),
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
  });
});
