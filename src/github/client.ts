import { Octokit } from '@octokit/rest';
import type { PRData, ChangedFile, RepoTree, RepoFileEntry } from '../types/index.js';

export class GitHubAuthError extends Error {
  constructor(statusCode = 401) {
    super(
      `GitHub token ${statusCode === 403 ? 'lacks required permissions' : 'is missing or invalid'}.\n` +
      'Set GITHUB_TOKEN environment variable:\n' +
      '  export GITHUB_TOKEN=ghp_...\n' +
      'Or create a .env file with GITHUB_TOKEN=ghp_...\n' +
      'Required scopes: repo (for private repos) or public_repo (for public repos)'
    );
    this.name = 'GitHubAuthError';
  }
}

export class GitHubRateLimitError extends Error {
  constructor(resetAt: string) {
    super(
      `GitHub API rate limit exceeded.\n` +
      `Rate limit resets at: ${resetAt}\n` +
      'Consider using a GitHub token with higher rate limits:\n' +
      '  export GITHUB_TOKEN=ghp_...'
    );
    this.name = 'GitHubRateLimitError';
  }
}

export class GitHubNotFoundError extends Error {
  constructor(owner: string, repo: string, number: number) {
    super(`PR #${number} not found in ${owner}/${repo}. Check the URL and your token permissions.`);
    this.name = 'GitHubNotFoundError';
  }
}

const FILE_WARNING_THRESHOLD = 300;

/** Parses a GitHub API error and throws a typed error. */
function throwGitHubError(err: unknown, owner: string, repo: string, number: number): never {
  const error = err as {
    status?: number;
    response?: { headers?: Record<string, string> };
  };

  if (error.status === 401) {
    throw new GitHubAuthError(401);
  }

  if (error.status === 403) {
    // Distinguish rate limit (x-ratelimit-remaining: 0) from permission errors
    const remaining = error.response?.headers?.['x-ratelimit-remaining'];
    const resetEpoch = error.response?.headers?.['x-ratelimit-reset'];
    if (remaining === '0') {
      const resetAt = resetEpoch
        ? new Date(parseInt(resetEpoch, 10) * 1000).toISOString()
        : 'unknown time';
      throw new GitHubRateLimitError(resetAt);
    }
    throw new GitHubAuthError(403);
  }

  if (error.status === 404) {
    throw new GitHubNotFoundError(owner, repo, number);
  }

  throw err;
}

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getPR(owner: string, repo: string, number: number): Promise<PRData> {
    try {
      const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
      const diff = await this.getDiff(owner, repo, number);
      const files = await this.getFiles(owner, repo, number);

      return {
        title: pr.title,
        body: pr.body ?? '',
        author: pr.user?.login ?? 'unknown',
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        labels: pr.labels.map((l) => l.name ?? ''),
        diff,
        files,
        additions: pr.additions,
        deletions: pr.deletions,
        number: pr.number,
        repoOwner: owner,
        repoName: repo,
        isDraft: pr.draft ?? false,
        state: pr.merged_at ? 'merged' : (pr.state as 'open' | 'closed'),
      };
    } catch (err: unknown) {
      throwGitHubError(err, owner, repo, number);
    }
  }

  async getDiff(owner: string, repo: string, number: number): Promise<string> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: number,
      headers: { accept: 'application/vnd.github.diff' },
    });
    return response.data as unknown as string;
  }

  async getFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]> {
    // Paginate ALL pages to avoid silent data loss on large PRs
    const allFiles = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });

    if (allFiles.length > FILE_WARNING_THRESHOLD) {
      console.warn(
        `⚠️  Warning: This PR touches ${allFiles.length} files (>${FILE_WARNING_THRESHOLD}). ` +
        `Review may be expensive and context may be truncated.`
      );
    }

    return allFiles.map((f) => ({
      filename: f.filename,
      status: f.status as ChangedFile['status'],
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
    }));
  }

  async postComment(owner: string, repo: string, number: number, body: string): Promise<number> {
    const { data } = await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body,
    });
    return data.id;
  }

  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    await this.octokit.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  }

  async findAgentReviewComment(owner: string, repo: string, number: number): Promise<number | null> {
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });

    for (const comment of comments) {
      if (comment.body?.includes('<!-- agentreview -->')) {
        return comment.id;
      }
    }
    return null;
  }

  async postOrUpdateComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    // Only the GitHub posting layer owns the hidden update marker — do not add it in the renderer.
    const markedBody = `<!-- agentreview -->\n${body}`;
    const existingId = await this.findAgentReviewComment(owner, repo, number);

    if (existingId) {
      await this.updateComment(owner, repo, existingId, markedBody);
    } else {
      await this.postComment(owner, repo, number, markedBody);
    }
  }

  async getRepoTree(owner: string, repo: string, sha: string): Promise<RepoTree> {
    const { data } = await this.octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: sha,
      recursive: 'true',
    });
    const entries: RepoFileEntry[] = (data.tree ?? []).map((item) => ({
      path: item.path ?? '',
      type: (item.type === 'tree' ? 'tree' : 'blob') as 'blob' | 'tree',
      size: item.size ?? undefined,
    }));
    return {
      sha: data.sha,
      entries,
      truncated: data.truncated ?? false,
    };
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({ owner, repo, path, ref });
      // directories return an array
      if (Array.isArray(data)) return null;
      if (data.type !== 'file') return null;
      // skip large binary files
      if ((data.size ?? 0) > 512000) return null;
      if (!('content' in data) || !data.content) return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  async getBaseSha(owner: string, repo: string, prNumber: number): Promise<string> {
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    return data.base.sha;
  }
}
