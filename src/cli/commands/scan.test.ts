import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createScanCommand, parseDomains } from './scan.js';

// ── Mock all external dependencies ──────────────────────────────────────────

vi.mock('../config.js', () => {
  const ConfigManager = vi.fn();
  ConfigManager.prototype.getLLMConfig = vi.fn();
  ConfigManager.prototype.hasAcknowledgedDataPolicy = vi.fn();
  ConfigManager.prototype.getGitHubToken = vi.fn();
  return { ConfigManager };
});

vi.mock('../disclosure.js', () => ({
  checkScanDisclosure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../scan/orchestrator.js', () => ({
  scanCodebase: vi.fn(),
}));

vi.mock('../../scan/renderer.js', () => ({
  renderScanReport: vi.fn().mockReturnValue('# Scan Report\nNo findings'),
}));

vi.mock('../../github/client.js', () => {
  const GitHubClient = vi.fn();
  GitHubClient.prototype.createIssue = vi.fn();
  return { GitHubClient };
});

vi.mock('../../scan/clone.js', () => ({
  parseGitHubUrl: vi.fn((url: string) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    return { owner: match?.[1] ?? 'owner', repo: match?.[2] ?? 'repo' };
  }),
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

vi.mock('../../scan/local-reader.js', () => {
  const LocalSourceReader = vi.fn();
  LocalSourceReader.prototype.listFiles = vi.fn().mockResolvedValue([]);
  return { LocalSourceReader };
});

// ── Import mocked modules ──────────────────────────────────────────────────

import { ConfigManager } from '../config.js';
import { checkScanDisclosure } from '../disclosure.js';
import { scanCodebase } from '../../scan/orchestrator.js';
import { renderScanReport } from '../../scan/renderer.js';
import { writeFile, mkdir } from 'fs/promises';
import { LocalSourceReader } from '../../scan/local-reader.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeScanResult(overrides: Record<string, unknown> = {}) {
  return {
    target: '/tmp/test',
    branch: 'main',
    scannedAt: '2025-01-01T00:00:00Z',
    filesDiscovered: 10,
    filesScanned: 10,
    filesSkipped: 0,
    chunks: [],
    findings: [],
    stats: {
      total: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      byDomain: {},
      cleanDomains: [],
      erroredChunks: [],
    },
    coverage: [],
    ...overrides,
  };
}

function setupMocks(overrides: { llmConfig?: Record<string, unknown>; scanResult?: Record<string, unknown> } = {}) {
  const llmConfig = {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
    timeout: 60,
    contextTokens: 128000,
    ...overrides.llmConfig,
  };

  vi.mocked(ConfigManager.prototype.getLLMConfig).mockReturnValue(llmConfig as any);
  vi.mocked(ConfigManager.prototype.hasAcknowledgedDataPolicy).mockReturnValue(true);
  vi.mocked(ConfigManager.prototype.getGitHubToken).mockReturnValue('ghp_test');
  vi.mocked(scanCodebase).mockResolvedValue(makeScanResult(overrides.scanResult) as any);
  vi.mocked(renderScanReport).mockReturnValue('# Scan Report');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createScanCommand', () => {
  const cmd = createScanCommand();

  it('returns a Command instance', () => {
    expect(cmd).toBeInstanceOf(Command);
  });

  it('has the name "scan"', () => {
    expect(cmd.name()).toBe('scan');
  });

  it('has a required <target> argument', () => {
    const args = cmd.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('target');
    expect(args[0].required).toBe(true);
  });

  it.each([
    '--focus', '--model', '--format', '--output', '--fail-on',
    '--redact', '--issue', '--max-files', '--budget', '--branch',
    '--timeout', '--verbose', '--yes',
  ])('has %s option', (longFlag) => {
    const opt = cmd.options.find((o) => o.long === longFlag);
    expect(opt).toBeDefined();
  });

  it('defaults --format to markdown', () => {
    const opt = cmd.options.find((o) => o.long === '--format');
    expect(opt!.defaultValue).toBe('markdown');
  });

  it('defaults --max-files to 50', () => {
    const opt = cmd.options.find((o) => o.long === '--max-files');
    expect(opt!.defaultValue).toBe(50);
  });

  it('defaults --budget to 100000', () => {
    const opt = cmd.options.find((o) => o.long === '--budget');
    expect(opt!.defaultValue).toBe(100000);
  });

  it.each([
    '--redact', '--issue', '--verbose', '--yes', '--baseline', '--update-baseline',
  ])('defaults %s to false', (longFlag) => {
    const opt = cmd.options.find((o) => o.long === longFlag);
    expect(opt!.defaultValue).toBe(false);
  });
});

describe('parseDomains', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns correct SecurityDomain[] for valid comma-separated input', () => {
    expect(parseDomains('auth,secrets')).toEqual(['auth', 'secrets']);
  });

  it('returns single-element array for a single valid domain', () => {
    expect(parseDomains('injection')).toEqual(['injection']);
  });

  it('handles whitespace around domains', () => {
    expect(parseDomains(' auth , secrets ')).toEqual(['auth', 'secrets']);
  });

  it('filters empty strings from the split result', () => {
    expect(parseDomains('auth,,secrets,')).toEqual(['auth', 'secrets']);
  });

  it('calls process.exit(1) on an invalid domain', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseDomains('not-a-domain')).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── runScan integration tests (via cmd.parseAsync) ──────────────────────────

describe('runScan (via parseAsync)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: scans local target with default markdown format', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']);

    expect(vi.mocked(ConfigManager.prototype.getLLMConfig)).toHaveBeenCalled();
    expect(vi.mocked(checkScanDisclosure)).toHaveBeenCalled();
    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ maxFiles: 50, budgetTokens: 100000 }),
      expect.anything(),
      expect.objectContaining({}),
    );
    expect(vi.mocked(renderScanReport)).toHaveBeenCalledWith(expect.anything(), 'markdown');
    expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('# Scan Report'));
  });

  it('happy path: --output writes report to file', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--output', '/tmp/report.md']);

    expect(vi.mocked(mkdir)).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith('/tmp/report.md', '# Scan Report', 'utf-8');
  });

  it('happy path: --format json passes json format to renderer', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--format', 'json']);

    expect(vi.mocked(renderScanReport)).toHaveBeenCalledWith(expect.anything(), 'json');
  });

  it('happy path: --format sarif passes sarif format to renderer', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--format', 'sarif']);

    expect(vi.mocked(renderScanReport)).toHaveBeenCalledWith(expect.anything(), 'sarif');
  });

  it('error: invalid --fail-on value exits with code 1', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await expect(
      cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--fail-on', 'NOPE']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --fail-on'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('error: invalid --format exits with code 1', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await expect(
      cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--format', 'xml']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --format'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('error: getLLMConfig throws exits with code 1', async () => {
    vi.mocked(ConfigManager.prototype.getLLMConfig).mockImplementation(() => {
      throw new Error('OPENAI_API_KEY not found');
    });
    vi.mocked(ConfigManager.prototype.hasAcknowledgedDataPolicy).mockReturnValue(true);

    const cmd = createScanCommand();
    await expect(
      cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY not found'));
  });

  it('error: scanCodebase throws exits with code 1 and shows unexpected error', async () => {
    setupMocks();
    vi.mocked(scanCodebase).mockRejectedValue(new Error('LLM timeout'));

    const cmd = createScanCommand();
    await expect(
      cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']),
    ).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Unexpected error'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('LLM timeout'));
  });

  it('--baseline flag is passed through to scan options', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--baseline']);

    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ baseline: 'create' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('--update-baseline flag is passed through to scan options', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--update-baseline']);

    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ updateBaseline: true }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('--fail-on triggers process.exit(2) when findings meet severity threshold', async () => {
    setupMocks({
      scanResult: {
        findings: [{ severity: 'HIGH', id: 'f1' }, { severity: 'LOW', id: 'f2' }],
        stats: {
          total: 2,
          bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1, INFO: 0 },
          byDomain: {},
          cleanDomains: [],
          erroredChunks: [],
        },
      },
    });

    const cmd = createScanCommand();
    // process.exit(2) throws, then outer catch calls process.exit(1) which also throws
    await expect(
      cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--fail-on', 'HIGH']),
    ).rejects.toThrow();

    // The important assertion: exit(2) was called before exit(1)
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Exiting with code 2'));
  });

  it('--fail-on does NOT exit when findings are below threshold', async () => {
    setupMocks({
      scanResult: {
        findings: [{ severity: 'LOW', id: 'f1' }],
        stats: {
          total: 1,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1, INFO: 0 },
          byDomain: {},
          cleanDomains: [],
          erroredChunks: [],
        },
      },
    });

    const cmd = createScanCommand();
    // Should NOT throw — LOW is below HIGH threshold
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--fail-on', 'HIGH']);

    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  it('--model passes model override to getLLMConfig', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--model', 'claude-sonnet-4-20250514']);

    expect(vi.mocked(ConfigManager.prototype.getLLMConfig)).toHaveBeenCalledWith('claude-sonnet-4-20250514');
  });

  it('--focus passes parsed domains to scan options', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--focus', 'auth,secrets']);

    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ focus: ['auth', 'secrets'] }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('--redact passes redact option to scan', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--redact']);

    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ redact: true }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('--timeout sets timeout on llmConfig', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--timeout', '120']);

    // timeout is passed through scan options
    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ timeout: 120 }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('shows errored chunks warning', async () => {
    setupMocks({
      scanResult: {
        stats: {
          total: 0,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
          byDomain: {},
          cleanDomains: [],
          erroredChunks: ['chunk-1', 'chunk-2'],
        },
      },
    });

    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('2 chunk(s) errored'));
  });

  it('shows clean summary when no findings', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No findings'));
  });

  it('shows severity breakdown in summary', async () => {
    setupMocks({
      scanResult: {
        findings: [{ severity: 'CRITICAL', id: 'f1' }],
        stats: {
          total: 1,
          bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
          byDomain: {},
          cleanDomains: [],
          erroredChunks: [],
        },
      },
    });

    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('1 CRITICAL'));
  });

  it('--issue with non-GitHub target shows warning', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--issue']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--issue requires a GitHub URL'));
  });

  it('--baseline-path passes baselinePath to scan options', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--baseline-path', '/tmp/my-baseline.json']);

    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ baselinePath: '/tmp/my-baseline.json' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('--issue with GitHub target creates an issue', async () => {
    setupMocks();
    const { GitHubClient } = await import('../../github/client.js');
    vi.mocked(GitHubClient.prototype.createIssue).mockResolvedValue({ url: 'https://github.com/owner/repo/issues/1' } as any);

    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', 'https://github.com/owner/repo', '--yes', '--issue']);

    expect(vi.mocked(GitHubClient.prototype.createIssue)).toHaveBeenCalledWith(
      'owner', 'repo',
      expect.stringContaining('Security Scan'),
      expect.any(String),
      expect.arrayContaining(['security']),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining('--issue requires a GitHub URL'));
  });

  it('--issue with GitHub target handles createIssue failure gracefully', async () => {
    setupMocks();
    const { GitHubClient } = await import('../../github/client.js');
    vi.mocked(GitHubClient.prototype.createIssue).mockRejectedValue(new Error('API rate limit'));

    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', 'https://github.com/owner/repo', '--yes', '--issue']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API rate limit'));
  });

  it('onProgress callback handles started, completed, and failed statuses', async () => {
    setupMocks();
    // Capture the onProgress callback by intercepting scanCodebase
    let capturedOnProgress: ((chunkId: string, status: string, meta?: any) => void) | undefined;
    vi.mocked(scanCodebase).mockImplementation(async (_target, opts, _llm, _extra) => {
      capturedOnProgress = (opts as any).onProgress;
      // Simulate progress events
      if (capturedOnProgress) {
        capturedOnProgress('chunk-1', 'started', { domain: 'auth', fileCount: 5 });
        capturedOnProgress('chunk-1', 'completed', { findingCount: 2, durationMs: 1500 });
        capturedOnProgress('chunk-2', 'started', { domain: 'secrets', fileCount: 3 });
        capturedOnProgress('chunk-2', 'failed', {});
      }
      return makeScanResult() as any;
    });

    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']);

    expect(capturedOnProgress).toBeDefined();
    // ora was called for the spinners — verify at least scan completed
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No findings'));
  });

  it('--verbose shows stack trace on error', async () => {
    setupMocks();
    vi.mocked(scanCodebase).mockRejectedValue(new Error('boom'));

    const cmd = createScanCommand();
    await expect(
      cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--verbose']),
    ).rejects.toThrow('process.exit(1)');

    // One call has the "Unexpected error" and another has the stack
    const calls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((c: unknown) => typeof c === 'string' && c.includes('Unexpected error'))).toBe(true);
    // Stack trace is logged when verbose
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error: boom'));
  });

  it('--max-files and --budget parseInt parsers are applied', async () => {
    setupMocks();
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes', '--max-files', '25', '--budget', '50000']);
    expect(vi.mocked(scanCodebase)).toHaveBeenCalledWith(
      '/tmp/mycode',
      expect.objectContaining({ maxFiles: 25, budgetTokens: 50000 }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('local target: LocalSourceReader.listFiles() success path updates preFileCount', async () => {
    setupMocks();
    vi.mocked(LocalSourceReader.prototype.listFiles).mockResolvedValue(
      ['file1.ts', 'file2.ts', 'file3.ts'] as any,
    );
    const cmd = createScanCommand();
    await cmd.parseAsync(['node', 'test', '/tmp/mycode', '--yes']);
    // Disclosure was called — the file count flows through to checkScanDisclosure
    expect(vi.mocked(checkScanDisclosure)).toHaveBeenCalledWith(
      expect.anything(),
      true,
      expect.objectContaining({ fileCount: 3 }),
    );
  });
});
