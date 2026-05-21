import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseGitHubUrl } from './clone.js';

// ─── parseGitHubUrl ───────────────────────────────────────────────────────────

describe('parseGitHubUrl', () => {
  it('parses a standard GitHub URL', () => {
    expect(parseGitHubUrl('https://github.com/octocat/hello-world')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    });
  });

  it('parses a .git suffixed URL', () => {
    expect(
      parseGitHubUrl('https://github.com/octocat/hello-world.git'),
    ).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });

  it('parses a URL with trailing slash', () => {
    expect(
      parseGitHubUrl('https://github.com/octocat/hello-world/'),
    ).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });

  it('handles http scheme', () => {
    expect(parseGitHubUrl('http://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('handles dots and underscores in owner/repo', () => {
    expect(
      parseGitHubUrl('https://github.com/my_org.name/my-repo.js'),
    ).toEqual({ owner: 'my_org.name', repo: 'my-repo.js' });
  });

  it('throws on non-GitHub URL', () => {
    expect(() => parseGitHubUrl('https://gitlab.com/a/b')).toThrow(
      'Invalid GitHub URL',
    );
  });

  it('throws on bare GitHub URL without repo', () => {
    expect(() => parseGitHubUrl('https://github.com/octocat')).toThrow(
      'Invalid GitHub URL',
    );
  });

  it('throws on empty string', () => {
    expect(() => parseGitHubUrl('')).toThrow('Invalid GitHub URL');
  });
});

// ─── cloneRepo ────────────────────────────────────────────────────────────────

// Mock child_process.execFile — vi.hoisted so the fn is available when vi.mock is hoisted
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

describe('cloneRepo', () => {
  let fakeTmpDir: string;
  // Dynamic import to pick up the mock
  let cloneRepo: typeof import('./clone.js')['cloneRepo'];

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Re-mock after restoreAllMocks clears it
    mockExecFile.mockReset();

    // Dynamic import each time so promisify picks up the mock
    const mod = await import('./clone.js');
    cloneRepo = mod.cloneRepo;

    // Create a real temp dir so LocalSourceReader can resolve it.
    fakeTmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agentreview-clone-test-'),
    );

    // Make mkdtemp always return our controlled dir.
    vi.spyOn(fs.promises, 'mkdtemp').mockResolvedValue(fakeTmpDir);

    // Default: execFile succeeds (callback-style).
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cb) cb(null, '', '');
        return undefined as unknown;
      },
    );
  });

  afterEach(async () => {
    await fs.promises
      .rm(fakeTmpDir, { recursive: true, force: true })
      .catch(() => {});
  });

  it('constructs unauthenticated clone URL when no token', async () => {
    const { cleanup } = await cloneRepo(
      'https://github.com/octocat/hello-world',
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'clone',
        '--depth',
        '1',
        'https://github.com/octocat/hello-world.git',
      ]),
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function),
    );

    await cleanup();
  });

  it('constructs authenticated URL when token provided', async () => {
    const { cleanup } = await cloneRepo(
      'https://github.com/octocat/hello-world',
      { token: 'ghp_test123' },
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'https://x-access-token:ghp_test123@github.com/octocat/hello-world.git',
      ]),
      expect.any(Object),
      expect.any(Function),
    );

    await cleanup();
  });

  it('passes --branch when branch option specified', async () => {
    const { cleanup } = await cloneRepo(
      'https://github.com/octocat/hello-world',
      { branch: 'develop' },
    );

    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--branch');
    expect(callArgs).toContain('develop');

    await cleanup();
  });

  it('returns a reader and cleanup function', async () => {
    const result = await cloneRepo(
      'https://github.com/octocat/hello-world',
    );

    expect(result.reader).toBeDefined();
    expect(typeof result.cleanup).toBe('function');

    await result.cleanup();
  });

  it('cleanup() removes the temp directory', async () => {
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    const { cleanup } = await cloneRepo(
      'https://github.com/octocat/hello-world',
    );
    await cleanup();

    expect(rmSpy).toHaveBeenCalledWith(fakeTmpDir, {
      recursive: true,
      force: true,
    });
  });

  it('cleans up temp dir and throws on clone failure', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null) => void,
      ) => {
        if (cb) cb(new Error('fatal: repository not found'));
        return undefined as unknown;
      },
    );

    const rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    await expect(
      cloneRepo('https://github.com/octocat/hello-world'),
    ).rejects.toThrow('Failed to clone octocat/hello-world');

    expect(rmSpy).toHaveBeenCalledWith(fakeTmpDir, {
      recursive: true,
      force: true,
    });
  });
});
