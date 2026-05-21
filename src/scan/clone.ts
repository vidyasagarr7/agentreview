import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { LocalSourceReader } from './local-reader.js';

const execFileAsync = promisify(execFile);

// ─── URL Parsing ──────────────────────────────────────────────────────────────

const GITHUB_URL_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Parse a GitHub HTTPS URL into owner/repo.
 * Supports `https://github.com/owner/repo` and `https://github.com/owner/repo.git`.
 */
export function parseGitHubUrl(url: string): GitHubRepo {
  const m = url.match(GITHUB_URL_RE);
  if (!m) {
    throw new Error(
      `Invalid GitHub URL: ${url}. Expected https://github.com/owner/repo[.git]`,
    );
  }
  return { owner: m[1], repo: m[2] };
}

// ─── Clone Options ────────────────────────────────────────────────────────────

export interface CloneOptions {
  /** Branch or tag to clone. */
  branch?: string;
  /** GitHub PAT / installation token for private repos. */
  token?: string;
  /** Clone timeout in milliseconds (default 60 000). */
  timeoutMs?: number;
}

export interface CloneResult {
  reader: LocalSourceReader;
  cleanup: () => Promise<void>;
}

// ─── Clone Helper ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Shallow-clone a GitHub repo into a temp directory and return a
 * `LocalSourceReader` pointed at it plus a `cleanup()` disposer.
 */
export async function cloneRepo(
  repoUrl: string,
  options?: CloneOptions,
): Promise<CloneResult> {
  const { owner, repo } = parseGitHubUrl(repoUrl);

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build the effective clone URL (with or without token auth).
  let cloneUrl: string;
  if (options?.token) {
    cloneUrl = `https://x-access-token:${options.token}@github.com/${owner}/${repo}.git`;
  } else {
    cloneUrl = `https://github.com/${owner}/${repo}.git`;
  }

  // Create temp directory.
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'agentreview-scan-'),
  );

  const cleanup = async (): Promise<void> => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  };

  try {
    const args = ['clone', '--depth', '1'];
    if (options?.branch) {
      args.push('--branch', options.branch);
    }
    args.push(cloneUrl, tmpDir);

    await execFileAsync('git', args, {
      timeout: timeoutMs,
      // Suppress interactive prompts (e.g. credential helpers).
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const reader = new LocalSourceReader(tmpDir);
    return { reader, cleanup };
  } catch (err: unknown) {
    // Best-effort cleanup on failure.
    await cleanup();

    const message =
      err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to clone ${owner}/${repo}: ${message}`,
    );
  }
}
