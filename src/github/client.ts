import { Octokit } from '@octokit/rest';
import type { PRData, ChangedFile } from '../types/index.js';

export class GitHubAuthError extends Error {
  constructor() {
    super(
      'GitHub token missing or invalid.\n' +
      'Set GITHUB_TOKEN environment variable:\n' +
      '  export GITHUB_TOKEN=ghp_...\n' +
      'Or create a .env file with GITHUB_TOKEN=ghp_...'
    );
    this.name = 'GitHubAuthError';
  }
}

export class GitHubNotFoundError extends Error {
  constructor(owner: string, repo: string, number: number) {
    super(`PR #${number} not found in ${owner}/${repo}. Check the URL and your token permissions.`);
    this.name = 'GitHubNotFoundError';
  }
}

const FILE_WARNING_THRESHOLD = 300;

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
      const error = err as { status?: number };
      if (error.status === 401 || error.status === 403) throw new GitHubAuthError();
      if (error.status === 404) throw new GitHubNotFoundError(owner, repo, number);
      throw err;
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
    const markedBody = `<!-- agentreview -->\n${body}`;
    const existingId = await this.findAgentReviewComment(owner, repo, number);

    if (existingId) {
      await this.updateComment(owner, repo, existingId, markedBody);
    } else {
      await this.postComment(owner, repo, number, markedBody);
    }
  }
}
