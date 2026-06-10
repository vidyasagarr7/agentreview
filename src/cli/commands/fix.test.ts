import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createFixCommand } from './fix.js';

// ── Mock all external dependencies ──────────────────────────────────────────

vi.mock('../config.js', () => {
  const ConfigManager = vi.fn();
  ConfigManager.prototype.getLLMConfig = vi.fn();
  ConfigManager.prototype.hasAcknowledgedDataPolicy = vi.fn();
  ConfigManager.prototype.getGitHubToken = vi.fn();
  return { ConfigManager };
});

vi.mock('../disclosure.js', () => ({
  checkDataDisclosure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../github/parse-url.js', () => ({
  parsePRUrl: vi.fn(),
  InvalidPRUrlError: class InvalidPRUrlError extends Error {
    constructor(msg: string) { super(msg); this.name = 'InvalidPRUrlError'; }
  },
}));

vi.mock('../../github/client.js', () => {
  const GitHubClient = vi.fn();
  GitHubClient.prototype.getPR = vi.fn();
  // Named error classes
  class GitHubAuthError extends Error { constructor(msg: string) { super(msg); this.name = 'GitHubAuthError'; } }
  class GitHubNotFoundError extends Error { constructor(msg: string) { super(msg); this.name = 'GitHubNotFoundError'; } }
  class GitHubRateLimitError extends Error { constructor(msg: string) { super(msg); this.name = 'GitHubRateLimitError'; } }
  return { GitHubClient, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError };
});

vi.mock('../../github/context-builder.js', () => ({
  buildReviewContext: vi.fn().mockReturnValue({ files: [], diff: '' }),
}));

vi.mock('../../lenses/registry.js', () => {
  const LensRegistry = vi.fn();
  LensRegistry.prototype.resolveLenses = vi.fn().mockReturnValue([]);
  return { LensRegistry };
});

vi.mock('../../llm/client.js', () => {
  const LLMClient = vi.fn();
  return { LLMClient };
});

vi.mock('../../agents/dispatcher.js', () => ({
  dispatchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../validation/validator.js', () => ({
  validateAgentResults: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../report/consolidator.js', () => ({
  consolidate: vi.fn().mockReturnValue({ findings: [] }),
}));

vi.mock('../../fix/generator.js', () => ({
  generateFixes: vi.fn().mockResolvedValue([]),
  isFixable: vi.fn().mockReturnValue(true),
}));

vi.mock('../../fix/verifier.js', () => ({
  verifyFixes: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../fix/applier.js', () => ({
  applyPatch: vi.fn().mockResolvedValue(true),
  revertPatch: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../fix/report.js', () => ({
  renderFixReport: vi.fn().mockReturnValue('# Fix Report'),
}));

vi.mock('ora', () => {
  const spinner = {
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  };
  return { default: vi.fn(() => spinner) };
});

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── Import mocked modules ──────────────────────────────────────────────────

import { ConfigManager } from '../config.js';
import { checkDataDisclosure } from '../disclosure.js';
import { parsePRUrl, InvalidPRUrlError } from '../../github/parse-url.js';
import { GitHubClient, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../../github/client.js';
import { consolidate } from '../../report/consolidator.js';
import { generateFixes, isFixable } from '../../fix/generator.js';
import { verifyFixes } from '../../fix/verifier.js';
import { applyPatch, revertPatch } from '../../fix/applier.js';
import { renderFixReport } from '../../fix/report.js';
import { writeFile, mkdir } from 'fs/promises';

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_PR_URL = 'https://github.com/owner/repo/pull/42';

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test PR',
    number: 42,
    diff: 'diff --git a/file.ts',
    files: [{ filename: 'file.ts', status: 'modified', patch: '+foo' }],
    ...overrides,
  };
}

function setupMocks(overrides: {
  findings?: Array<Record<string, unknown>>;
  fixes?: Array<Record<string, unknown>>;
} = {}) {
  const llmConfig = {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
    timeout: 60,
    contextTokens: 128000,
  };

  vi.mocked(ConfigManager.prototype.getLLMConfig).mockReturnValue(llmConfig as any);
  vi.mocked(ConfigManager.prototype.hasAcknowledgedDataPolicy).mockReturnValue(true);
  vi.mocked(ConfigManager.prototype.getGitHubToken).mockReturnValue('ghp_test');
  vi.mocked(parsePRUrl).mockReturnValue({ owner: 'owner', repo: 'repo', number: 42 });
  vi.mocked(GitHubClient.prototype.getPR).mockResolvedValue(makePR() as any);

  const findings = overrides.findings ?? [];
  vi.mocked(consolidate).mockReturnValue({ findings } as any);
  vi.mocked(isFixable).mockReturnValue(true);

  const fixes = overrides.fixes ?? [];
  vi.mocked(generateFixes).mockResolvedValue(fixes as any);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createFixCommand', () => {
  const cmd = createFixCommand();

  it('returns a Command instance', () => {
    expect(cmd).toBeInstanceOf(Command);
  });

  it('has the name "fix"', () => {
    expect(cmd.name()).toBe('fix');
  });

  it('has a required <pr-url> argument', () => {
    const args = cmd.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('pr-url');
    expect(args[0].required).toBe(true);
  });

  it.each([
    '--model', '--output', '--dry-run', '--min-confidence',
    '--verbose', '--yes', '--repo-dir',
  ])('has %s option', (longFlag) => {
    const opt = cmd.options.find((o) => o.long === longFlag);
    expect(opt).toBeDefined();
  });
});

// ── runFix integration tests (via cmd.parseAsync) ───────────────────────────

describe('runFix (via parseAsync)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: --dry-run generates patches without applying', async () => {
    const fixFindings = [
      { id: 'f1', severity: 'HIGH', confidenceScore: 90, title: 'SQL injection' },
    ];
    const fixes = [
      { findingId: 'f1', status: 'pending', patch: 'diff...', explanation: 'Fixed SQL' },
    ];
    setupMocks({ findings: fixFindings, fixes });

    const cmd = createFixCommand();
    await cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']);

    expect(vi.mocked(generateFixes)).toHaveBeenCalled();
    expect(vi.mocked(applyPatch)).not.toHaveBeenCalled();
    expect(vi.mocked(renderFixReport)).toHaveBeenCalled();
    expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('# Fix Report'));
  });

  it('happy path: non-dry-run applies patches with --repo-dir', async () => {
    const fixFindings = [
      { id: 'f1', severity: 'HIGH', confidenceScore: 90, title: 'Bug' },
    ];
    const fixes = [
      { findingId: 'f1', status: 'pending', patch: 'diff...', explanation: 'Fixed' },
    ];
    setupMocks({ findings: fixFindings, fixes });
    vi.mocked(verifyFixes).mockResolvedValue([{ findingId: 'f1', passed: true, issues: [] }] as any);

    const cmd = createFixCommand();
    await cmd.parseAsync(['node', 'test', VALID_PR_URL, '--yes', '--repo-dir', '/tmp/repo']);

    expect(vi.mocked(applyPatch)).toHaveBeenCalledWith('diff...', '/tmp/repo');
    expect(vi.mocked(verifyFixes)).toHaveBeenCalled();
  });

  it('error: non-dry-run without --repo-dir exits with code 1', async () => {
    setupMocks();

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', VALID_PR_URL, '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--repo-dir is required'));
  });

  it('error: parsePRUrl throws InvalidPRUrlError exits with code 1', async () => {
    setupMocks();
    // Override parsePRUrl to throw
    const { InvalidPRUrlError: IPE } = await import('../../github/parse-url.js');
    vi.mocked(parsePRUrl).mockImplementation(() => {
      throw new IPE('Invalid PR URL format');
    });

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'not-a-url', '--dry-run', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid PR URL'));
  });

  it('error: GitHubAuthError exits with code 1', async () => {
    setupMocks();
    const { GitHubAuthError: GAE } = await import('../../github/client.js');
    vi.mocked(GitHubClient.prototype.getPR).mockRejectedValue(new GAE('Bad credentials'));

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Bad credentials'));
  });

  it('error: GitHubNotFoundError exits with code 1', async () => {
    setupMocks();
    const { GitHubNotFoundError: GNF } = await import('../../github/client.js');
    vi.mocked(GitHubClient.prototype.getPR).mockRejectedValue(new GNF('Not found'));

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Not found'));
  });

  it('error: GitHubRateLimitError exits with code 1', async () => {
    setupMocks();
    const { GitHubRateLimitError: GRL } = await import('../../github/client.js');
    vi.mocked(GitHubClient.prototype.getPR).mockRejectedValue(new GRL('Rate limited'));

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limited'));
  });

  it('error: getLLMConfig throws exits with code 1', async () => {
    vi.mocked(ConfigManager.prototype.hasAcknowledgedDataPolicy).mockReturnValue(true);
    vi.mocked(parsePRUrl).mockReturnValue({ owner: 'o', repo: 'r', number: 1 });
    vi.mocked(ConfigManager.prototype.getGitHubToken).mockReturnValue('ghp_test');
    vi.mocked(ConfigManager.prototype.getLLMConfig).mockImplementation(() => {
      throw new Error('OPENAI_API_KEY not found');
    });

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY not found'));
  });

  it('--output writes fix report to file', async () => {
    const fixFindings = [{ id: 'f1', severity: 'HIGH', title: 'Bug' }];
    const fixes = [{ findingId: 'f1', status: 'pending', patch: 'p', explanation: 'e' }];
    setupMocks({ findings: fixFindings, fixes });

    const cmd = createFixCommand();
    await cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes', '--output', '/tmp/fix.md']);

    expect(vi.mocked(mkdir)).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith('/tmp/fix.md', '# Fix Report', 'utf-8');
  });

  it('exits early with message when no fixable findings', async () => {
    setupMocks({ findings: [] });

    const cmd = createFixCommand();
    await cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No fixable findings'));
    expect(vi.mocked(generateFixes)).not.toHaveBeenCalled();
  });

  it('--min-confidence filters findings below threshold', async () => {
    const fixFindings = [
      { id: 'f1', severity: 'HIGH', confidenceScore: 90, title: 'High conf' },
      { id: 'f2', severity: 'LOW', confidenceScore: 30, title: 'Low conf' },
    ];
    setupMocks({ findings: fixFindings, fixes: [] });

    const cmd = createFixCommand();
    await cmd.parseAsync([
      'node', 'test', VALID_PR_URL, '--dry-run', '--yes', '--min-confidence', '50',
    ]);

    // After filtering, only f1 remains. With an empty fixes array, generateFixes is called for the remaining finding(s)
    // Since we mock isFixable to return true, both pass that filter first, then min-confidence filters
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('1 finding(s) eligible'));
  });

  it('reverts patch when verification fails', async () => {
    const fixFindings = [{ id: 'f1', severity: 'HIGH', title: 'Bug' }];
    const fixes = [
      { findingId: 'f1', status: 'pending', patch: 'diff...', explanation: 'Fix' },
    ];
    setupMocks({ findings: fixFindings, fixes });
    vi.mocked(verifyFixes).mockResolvedValue([
      { findingId: 'f1', passed: false, issues: ['Regression detected'] },
    ] as any);

    const cmd = createFixCommand();
    await cmd.parseAsync(['node', 'test', VALID_PR_URL, '--yes', '--repo-dir', '/tmp/repo']);

    expect(vi.mocked(applyPatch)).toHaveBeenCalled();
    expect(vi.mocked(revertPatch)).toHaveBeenCalledWith('diff...', '/tmp/repo');
  });

  it('marks fix as failed when patch fails to apply', async () => {
    const fixFindings = [{ id: 'f1', severity: 'HIGH', title: 'Bug' }];
    const fixes = [
      { findingId: 'f1', status: 'pending', patch: 'diff...', explanation: 'Fix' },
    ];
    setupMocks({ findings: fixFindings, fixes });
    vi.mocked(applyPatch).mockResolvedValue(false);

    const cmd = createFixCommand();
    await cmd.parseAsync(['node', 'test', VALID_PR_URL, '--yes', '--repo-dir', '/tmp/repo']);

    expect(vi.mocked(verifyFixes)).not.toHaveBeenCalled();
    // Fix status should be set to 'failed'
    expect(fixes[0].status).toBe('failed');
  });

  it('unexpected error shows message and exits with code 1', async () => {
    setupMocks();
    vi.mocked(GitHubClient.prototype.getPR).mockRejectedValue(new Error('Network error'));

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Unexpected error'));
  });

  it('--verbose shows stack trace on unexpected error', async () => {
    setupMocks();
    vi.mocked(GitHubClient.prototype.getPR).mockRejectedValue(new Error('boom'));

    const cmd = createFixCommand();
    await expect(
      cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes', '--verbose']),
    ).rejects.toThrow('process.exit(1)');

    const calls = consoleErrorSpy.mock.calls.map((c) => c[0]);
    expect(calls.some((c: string) => typeof c === 'string' && c.includes('boom'))).toBe(true);
  });

  it('shows fix summary in output', async () => {
    const fixFindings = [{ id: 'f1', severity: 'HIGH', title: 'Bug' }];
    const fixes = [
      { findingId: 'f1', status: 'verified', patch: 'p', explanation: 'e' },
    ];
    setupMocks({ findings: fixFindings, fixes });

    const cmd = createFixCommand();
    await cmd.parseAsync(['node', 'test', VALID_PR_URL, '--dry-run', '--yes']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Fix Summary'));
  });
});
