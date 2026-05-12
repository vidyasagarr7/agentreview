import type { RepoTree } from '../types/index.js';
import type { GitHubClient } from '../github/client.js';

export interface FetcherOptions {
  maxFiles: number;    // default 30
  concurrency: number; // default 5
}

const DEFAULT_OPTIONS: FetcherOptions = {
  maxFiles: 30,
  concurrency: 5,
};

export class CodebaseFetcher {
  private fileCache = new Map<string, string>();
  private opts: FetcherOptions;

  constructor(
    private gh: GitHubClient,
    private owner: string,
    private repo: string,
    private sha: string,
    opts: Partial<FetcherOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  async fetchTree(): Promise<RepoTree> {
    return this.gh.getRepoTree(this.owner, this.repo, this.sha);
  }

  async fetchFile(path: string): Promise<string | null> {
    if (this.fileCache.has(path)) {
      return this.fileCache.get(path)!;
    }
    const content = await this.gh.getFileContent(this.owner, this.repo, path, this.sha);
    if (content !== null) {
      this.fileCache.set(path, content);
    }
    return content;
  }

  async fetchFiles(paths: string[]): Promise<Map<string, string>> {
    const bounded = paths.slice(0, this.opts.maxFiles);
    const result = new Map<string, string>();

    // Process in chunks of opts.concurrency using Promise.allSettled
    for (let i = 0; i < bounded.length; i += this.opts.concurrency) {
      const chunk = bounded.slice(i, i + this.opts.concurrency);
      const settled = await Promise.allSettled(
        chunk.map(async (path) => ({ path, content: await this.fetchFile(path) })),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled' && outcome.value.content !== null) {
          result.set(outcome.value.path, outcome.value.content);
        }
      }
    }

    return result;
  }
}
