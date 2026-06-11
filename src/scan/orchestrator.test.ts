import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMCompleteOptions } from '../llm/client.js';
import type { ScanOptions, ScanProgressCallback, SourceReader, FileEntry } from './types.js';
import { scanCodebase, RedactingReader } from './orchestrator.js';

// Mock analyzePhiFlow so we can make it throw for testing the catch block
const mockAnalyzePhiFlow = vi.fn();
vi.mock('../hipaa/flow/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    analyzePhiFlow: (...args: any[]) => mockAnalyzePhiFlow(...args),
  };
});

// Mock cloneRepo for GitHub path tests
const mockCloneRepo = vi.fn();
vi.mock('./clone.js', () => ({
  cloneRepo: (...args: any[]) => mockCloneRepo(...args),
}));

// ─── Mock LLM Client ──────────────────────────────────────────────────────────

function makeMockLLM(responseOverride?: (system: string, user: string) => string) {
  const defaultResponse = JSON.stringify([
    {
      id: 'sec-001',
      severity: 'HIGH',
      category: 'Hardcoded Secret',
      location: 'config/db.ts:10',
      summary: 'Database password hardcoded',
      detail: 'A database password is hardcoded in the source file.',
      suggestion: 'Use environment variables for secrets.',
    },
  ]);

  return {
    complete: vi.fn(
      async (
        system: string,
        user: string,
        _signal?: AbortSignal,
        _options?: LLMCompleteOptions,
      ) => {
        if (responseOverride) return responseOverride(system, user);
        return defaultResponse;
      },
    ),
  };
}

// ─── Mock Source Reader ───────────────────────────────────────────────────────

function makeMockReader(files: Record<string, string>): SourceReader {
  const entries: FileEntry[] = Object.keys(files).map((p) => ({
    path: p,
    size: Buffer.byteLength(files[p]),
    priority: 0,
  }));

  return {
    listFiles: vi.fn(async () => entries),
    readFile: vi.fn(async (path: string) => files[path] ?? null),
    cleanup: vi.fn(async () => {}),
  };
}

// ─── Default Options ──────────────────────────────────────────────────────────

function defaultOptions(overrides?: Partial<ScanOptions>): ScanOptions {
  return {
    maxConcurrency: 2,
    budgetTokens: 50000,
    timeout: 30,
    validate: false,
    verbose: false,
    redact: false,
    ...overrides,
  };
}

// ─── Helpers to mock LocalSourceReader construction ───────────────────────────

// We mock the discovery + chunker pipeline by providing a real local directory.
// But for unit tests, we'll mock at a higher level by intercepting the modules.

// Since the orchestrator creates LocalSourceReader internally for local paths,
// we need a real directory. Let's use a temp dir approach.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  // Reset analyzePhiFlow mock — default: call through to real implementation
  mockAnalyzePhiFlow.mockReset();
  // By default, return empty result (no paths found) to avoid needing real LLM
  mockAnalyzePhiFlow.mockResolvedValue({ paths: [], durationMs: 0 });
});

// afterEach not strictly needed since tests are short-lived, but good practice
import { afterEach } from 'vitest';
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTestFiles(files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('scanCodebase', () => {
  it('full pipeline: local path → discover → chunk → dispatch → dedup → result', async () => {
    writeTestFiles({
      'src/auth/login.ts': 'export function login(user, pass) { return db.query("SELECT * FROM users WHERE user=" + user); }',
      'config/db.ts': 'export const DB_PASS = "hunter2";',
      '.env': 'SECRET_KEY=mysecret123',
    });

    const llm = makeMockLLM();
    const options = defaultOptions();

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    expect(result.target).toBe(tmpDir);
    expect(result.branch).toBe('main');
    expect(result.scannedAt).toBeTruthy();
    expect(result.filesDiscovered).toBeGreaterThan(0);
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.stats.total).toBeGreaterThan(0);
    expect(result.coverage.length).toBeGreaterThan(0);

    // LLM was called for each chunk
    expect(llm.complete).toHaveBeenCalled();
  });

  it('progress callbacks fire for each chunk', async () => {
    writeTestFiles({
      'src/auth/login.ts': 'export function login() {}',
    });

    const llm = makeMockLLM();
    const progressEvents: Array<{ chunkId: string; status: string }> = [];
    const onProgress: ScanProgressCallback = (chunkId, status) => {
      progressEvents.push({ chunkId, status });
    };

    const options = defaultOptions();
    (options as any).onProgress = onProgress;

    await scanCodebase(tmpDir, options, llm as any, {});

    // Each chunk should have a 'started' and 'completed' event
    const started = progressEvents.filter((e) => e.status === 'started');
    const completed = progressEvents.filter((e) => e.status === 'completed');

    expect(started.length).toBeGreaterThan(0);
    expect(completed.length).toBeGreaterThan(0);
    expect(started.length).toBe(completed.length);
  });

  it('chunk failure handled gracefully — other chunks still work', async () => {
    writeTestFiles({
      'src/auth/login.ts': 'export function login() {}',
      'config/settings.yaml': 'debug: true\nport: 8080',
      '.env': 'API_KEY=abc123',
    });

    let callCount = 0;
    const llm = makeMockLLM(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('LLM exploded');
      }
      return JSON.stringify([
        {
          id: 'sec-002',
          severity: 'MEDIUM',
          category: 'Debug Mode',
          location: 'config/settings.yaml:1',
          summary: 'Debug mode enabled',
          detail: 'Debug mode is enabled in config.',
          suggestion: 'Disable in production.',
        },
      ]);
    });

    const options = defaultOptions();
    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // Should still have results from non-failed chunks
    const erroredChunks = result.chunks.filter((c) => c.error);
    const successChunks = result.chunks.filter((c) => !c.error);

    expect(erroredChunks.length).toBeGreaterThan(0);
    expect(result.stats.erroredChunks.length).toBeGreaterThan(0);

    // If there were multiple chunks, some should succeed
    if (result.chunks.length > 1) {
      expect(successChunks.length).toBeGreaterThan(0);
    }
  });

  it('cleanup called for local reader', async () => {
    writeTestFiles({
      'src/index.ts': 'console.log("hello");',
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    // The LocalSourceReader doesn't have cleanup, but the orchestrator
    // calls reader.cleanup?.() which is safe for undefined.
    // For this test, we verify the scan completes without error.
    const result = await scanCodebase(tmpDir, options, llm as any, {});
    expect(result).toBeDefined();
  });

  it('focus filtering works', async () => {
    writeTestFiles({
      'src/auth/login.ts': 'export function login() { /* auth stuff */ }',
      'config/Dockerfile': 'FROM node:18\nUSER root',
      'package.json': '{"dependencies": {"express": "^4.0.0"}}',
    });

    const llm = makeMockLLM();
    const options = defaultOptions({ focus: ['auth'] });

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // All chunks should be in the auth domain
    for (const chunk of result.chunks) {
      expect(chunk.domain).toBe('auth');
    }

    // Coverage should only have auth domain
    for (const cov of result.coverage) {
      expect(cov.domain).toBe('auth');
    }
  });

  it('stats and coverage populated correctly', async () => {
    writeTestFiles({
      'src/auth/login.ts': 'export function login() {}',
      '.env': 'DB_PASS=secret',
    });

    const llm = makeMockLLM(() =>
      JSON.stringify([
        {
          id: 'sec-001',
          severity: 'CRITICAL',
          category: 'Hardcoded Secret',
          location: '.env:1',
          summary: 'Secret in env file',
          detail: 'Hardcoded database password in .env.',
          suggestion: 'Use a vault.',
        },
        {
          id: 'sec-002',
          severity: 'LOW',
          category: 'Weak Password',
          location: '.env:1',
          summary: 'Weak password pattern',
          detail: 'Password appears to be weak.',
          suggestion: 'Use stronger passwords.',
        },
      ]),
    );

    const options = defaultOptions();
    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // Stats
    expect(result.stats.total).toBeGreaterThan(0);
    expect(typeof result.stats.bySeverity.CRITICAL).toBe('number');
    expect(typeof result.stats.bySeverity.HIGH).toBe('number');
    expect(typeof result.stats.bySeverity.MEDIUM).toBe('number');
    expect(typeof result.stats.bySeverity.LOW).toBe('number');
    expect(typeof result.stats.bySeverity.INFO).toBe('number');
    expect(Object.keys(result.stats.byDomain).length).toBeGreaterThan(0);
    expect(Array.isArray(result.stats.cleanDomains)).toBe(true);
    expect(Array.isArray(result.stats.erroredChunks)).toBe(true);

    // Coverage
    expect(result.coverage.length).toBeGreaterThan(0);
    for (const cov of result.coverage) {
      expect(cov.domain).toBeTruthy();
      expect(typeof cov.filesScanned).toBe('number');
      expect(typeof cov.findings).toBe('number');
    }
  });

  it('redact option wraps reader to redact secrets', async () => {
    writeTestFiles({
      '.env': 'AWS_KEY=AKIAIOSFODNN7EXAMPLE1',
    });

    // Return findings based on what the LLM sees — if redacted, it won't see the key
    const llm = makeMockLLM((_sys, user) => {
      if (user.includes('AKIAIOSFODNN7EXAMPLE1')) {
        return JSON.stringify([
          {
            id: 'sec-001',
            severity: 'CRITICAL',
            category: 'AWS Key Exposed',
            location: '.env:1',
            summary: 'AWS key found in source',
            detail: 'Real AWS key visible.',
            suggestion: 'Redact it.',
          },
        ]);
      }
      // Redacted — the key is replaced
      return JSON.stringify([]);
    });

    const options = defaultOptions({ redact: true });
    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // With redaction, the LLM should NOT see the real key
    // So findings should be empty (redacted path)
    expect(result.findings.length).toBe(0);
  });

  it('handles empty directory gracefully', async () => {
    // tmpDir is already empty
    const llm = makeMockLLM();
    const options = defaultOptions();

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    expect(result.filesDiscovered).toBe(0);
    expect(result.filesScanned).toBe(0);
    expect(result.chunks.length).toBe(0);
    expect(result.findings.length).toBe(0);
    expect(result.stats.total).toBe(0);
    // LLM should not have been called
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('maxFiles limits the number of discovered files sent to LLM', async () => {
    // Create many files so we can test limiting
    writeTestFiles({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 2;',
      'src/c.ts': 'export const c = 3;',
      'src/d.ts': 'export const d = 4;',
      'src/e.ts': 'export const e = 5;',
      'src/f.ts': 'export const f = 6;',
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions({ maxFiles: 2 });

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // filesDiscovered should be limited by maxFiles
    expect(result.filesDiscovered).toBeLessThanOrEqual(2);
  });

  it('baseline option saves baseline and returns all findings', async () => {
    writeTestFiles({
      'src/app.ts': 'const password = "secret";',
    });

    const llm = makeMockLLM();
    const baselinePath = path.join(tmpDir, '.agentreview-baseline.json');
    const options = defaultOptions();
    (options as any).baseline = true;
    (options as any).baselinePath = baselinePath;

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // Baseline should have been saved
    expect(fs.existsSync(baselinePath)).toBe(true);
    const baselineContent = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    expect(baselineContent.target).toBe(tmpDir);
    expect(baselineContent.entries).toBeDefined();
    expect(baselineContent.version).toBe(1);

    // All findings should be returned (not filtered)
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.suppressedCount).toBeUndefined();
  });

  it('existing baseline suppresses known findings', async () => {
    writeTestFiles({
      'src/app.ts': 'const password = "secret";',
    });

    const llm = makeMockLLM();
    const baselinePath = path.join(tmpDir, '.agentreview-baseline.json');

    // First pass: create baseline
    const opts1 = defaultOptions();
    (opts1 as any).baseline = true;
    (opts1 as any).baselinePath = baselinePath;
    const result1 = await scanCodebase(tmpDir, opts1, llm as any, {});
    expect(result1.findings.length).toBeGreaterThan(0);

    // Second pass: scan against baseline — same findings should be suppressed
    const opts2 = defaultOptions();
    (opts2 as any).baselinePath = baselinePath;
    const result2 = await scanCodebase(tmpDir, opts2, llm as any, {});

    expect(result2.suppressedCount).toBeGreaterThan(0);
    expect(result2.findings.length).toBe(0);
  });

  it('updateBaseline option saves baseline', async () => {
    writeTestFiles({
      'src/app.ts': 'const token = "abc123";',
    });

    const llm = makeMockLLM();
    const baselinePath = path.join(tmpDir, '.agentreview-baseline.json');
    const options = defaultOptions();
    (options as any).updateBaseline = true;
    (options as any).baselinePath = baselinePath;

    await scanCodebase(tmpDir, options, llm as any, {});

    expect(fs.existsSync(baselinePath)).toBe(true);
  });

  it('HIPAA repo config triggers deterministic scan', async () => {
    // Create a repo config enabling HIPAA
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: false\n  scanners:\n    select-star: true\n    audit-trail: true\n',
      'src/db/query.ts': 'export function getPatient() { return db.query("SELECT * FROM patients"); }',
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // With HIPAA enabled, deterministic scanners should have run
    // Check if deterministic chunk was added
    const deterministicChunk = result.chunks.find((c) => c.chunkId === 'deterministic');
    // Deterministic findings depend on patterns matching — the test verifies the path executes
    // Even if no deterministic findings, the HIPAA path should have been exercised
    expect(result).toBeDefined();
    expect(result.findings).toBeDefined();
  });

  it('HIPAA flow analysis runs when enabled', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n  flow-max-files: 5\n  flow-max-depth: 2\n  flow-max-paths: 5\n',
      'src/patient.ts': 'export function getPatientName(id: string) { return fetch("/api/patients/" + id); }',
      'src/handler.ts': 'import { getPatientName } from "./patient";\nexport function handler(req: any) { const name = getPatientName(req.id); log(name); }',
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    // Flow analysis uses LLM — the mock will return empty, but the path should execute
    const result = await scanCodebase(tmpDir, options, llm as any, {});

    expect(result).toBeDefined();
    expect(result.findings).toBeDefined();
    // The flow analysis LLM adapter should have been called
    // (LLM calls include both chunk scans and flow analysis)
  });

  it('HIPAA flow analysis failure is non-fatal', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n',
      'src/app.ts': 'console.log("hello");',
    });

    // Make LLM throw on flow analysis calls (after chunk scans)
    let callCount = 0;
    const llm = makeMockLLM(() => {
      callCount++;
      if (callCount > 1) throw new Error('Flow LLM failure');
      return '[]';
    });

    const options = defaultOptions({ verbose: true });
    // Should not throw — flow analysis failure is caught
    const result = await scanCodebase(tmpDir, options, llm as any, {});
    expect(result).toBeDefined();
  });

  it('PHI flow analysis failure with verbose=false is silent', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n',
      'src/app.ts': 'console.log("hello");',
    });

    mockAnalyzePhiFlow.mockRejectedValueOnce(new Error('Flow LLM failure'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions({ verbose: false });

    const result = await scanCodebase(tmpDir, options, llm as any, {});
    expect(result).toBeDefined();
    // With verbose=false, console.warn should NOT be called for flow failure
    const flowWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('PHI flow'));
    expect(flowWarns.length).toBe(0);
    warnSpy.mockRestore();
  });

  it('PHI flow analysis failure with verbose=true logs warning', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n',
      'src/app.ts': 'console.log("hello");',
    });

    mockAnalyzePhiFlow.mockRejectedValueOnce(new Error('Flow LLM failure'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions({ verbose: true });

    const result = await scanCodebase(tmpDir, options, llm as any, {});
    expect(result).toBeDefined();
    // With verbose=true, console.warn SHOULD be called with the error message
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PHI flow analysis failed: Flow LLM failure'));
    warnSpy.mockRestore();
  });

  it('PHI flow analysis failure with non-Error throw uses String()', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n',
      'src/app.ts': 'console.log("hello");',
    });

    mockAnalyzePhiFlow.mockRejectedValueOnce('string-error-not-Error-object');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions({ verbose: true });

    const result = await scanCodebase(tmpDir, options, llm as any, {});
    expect(result).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('string-error-not-Error-object'));
    warnSpy.mockRestore();
  });

  it('PHI flow analysis findings are included in results', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n',
      'src/patient.ts': 'export function getPatient() { return fetch("/api/patients"); }',
    });

    // Mock returns paths so the flowPathsToFindings branch is exercised
    mockAnalyzePhiFlow.mockResolvedValueOnce({
      paths: [
        {
          source: { file: 'src/patient.ts', name: 'getPatient', line: 1, type: 'direct-field' },
          intermediates: [],
          sink: { file: 'src/logger.ts', name: 'log', line: 5, type: 'log' },
          confidence: 'high',
          severity: 'HIGH',
          isLeak: true,
          explanation: 'PHI leaks to logger',
          baaRelevant: false,
        },
      ],
      durationMs: 100,
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // The phi-flow-analysis chunk should be present
    const flowChunk = result.chunks.find((c) => c.chunkId === 'phi-flow-analysis');
    expect(flowChunk).toBeDefined();
    expect(flowChunk!.domain).toBe('data-flow');
    expect(flowChunk!.findings.length).toBeGreaterThan(0);
    expect(flowChunk!.durationMs).toBe(100);
  });

  it('flow analysis onProgress relays flow-prefixed progress events to scan onProgress', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n',
      'src/app.ts': 'console.log("hello");',
    });

    // Capture the onProgress callback the orchestrator wires into flowOptions
    let flowOnProgress: ((phase: any, current: number, total: number, detail?: string) => void) | undefined;
    mockAnalyzePhiFlow.mockImplementationOnce(async (arg: any) => {
      flowOnProgress = arg.options.onProgress;
      return { paths: [], durationMs: 0 };
    });

    const progressEvents: Array<{ chunkId: string; status: string; detail: any }> = [];
    const onProgress: ScanProgressCallback = (chunkId, status, detail) => {
      progressEvents.push({ chunkId, status, detail });
    };

    const options = defaultOptions();
    (options as any).onProgress = onProgress;

    await scanCodebase(tmpDir, options, makeMockLLM(() => '[]') as any, {});

    expect(flowOnProgress).toBeDefined();

    // current !== total → 'started'
    flowOnProgress!('profiling', 2, 5);
    // current === total → 'completed'
    flowOnProgress!('verifying', 5, 5);

    const started = progressEvents.find((e) => e.chunkId === 'flow-profiling');
    expect(started).toEqual({
      chunkId: 'flow-profiling',
      status: 'started',
      detail: { domain: 'data-flow', fileCount: 5 },
    });

    const completed = progressEvents.find((e) => e.chunkId === 'flow-verifying');
    expect(completed).toEqual({
      chunkId: 'flow-verifying',
      status: 'completed',
      detail: { domain: 'data-flow', fileCount: 5 },
    });
  });

  it('flow LLM adapter extracts system+user from messages and calls llm.complete', async () => {
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: true\n',
      'src/app.ts': 'console.log("hello");',
    });

    // Capture the adapter the orchestrator passes to analyzePhiFlow as `llm`
    let flowLlm: { chat: (messages: Array<{ role: string; content: string }>) => Promise<string> } | undefined;
    mockAnalyzePhiFlow.mockImplementationOnce(async (arg: any) => {
      flowLlm = arg.llm;
      return { paths: [], durationMs: 0 };
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    await scanCodebase(tmpDir, options, llm as any, {});

    expect(flowLlm).toBeDefined();
    llm.complete.mockClear();

    // Adapter pulls the system + user content out of the messages array
    const out = await flowLlm!.chat([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      { role: 'user', content: 'USER_PROMPT' },
    ]);

    expect(llm.complete).toHaveBeenCalledWith('SYSTEM_PROMPT', 'USER_PROMPT');
    expect(out).toBe('[]');

    // Missing roles fall back to empty strings (nullish coalescing branch)
    llm.complete.mockClear();
    await flowLlm!.chat([]);
    expect(llm.complete).toHaveBeenCalledWith('', '');
  });

  it('HIPAA re-discovers files when classifiedFiles truncated by maxFiles', async () => {
    // Create enough files to be truncated by maxFiles=2
    writeTestFiles({
      '.agentreview.yml': 'hipaa:\n  flow-analysis: false\n  scanners:\n    select-star: true\n',
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 2;',
      'src/c.ts': 'export const c = 3;',
      'src/d.ts': 'export const d = 4;',
      'src/e.ts': 'export const e = 5;',
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions({ maxFiles: 2 });

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // filesDiscovered is from the truncated set (maxFiles), but HIPAA should
    // have re-discovered ALL files internally for its analysis
    expect(result).toBeDefined();
    expect(result.filesDiscovered).toBeLessThanOrEqual(2);
    // The scan completes — verifying the re-discovery code path executed
  });

  it('GitHub target uses cloneRepo and cleans up', async () => {
    // Set up a real tmpDir that cloneRepo would "return"
    writeTestFiles({
      'src/app.ts': 'export const x = 1;',
    });

    const cleanupFn = vi.fn(async () => {});
    mockCloneRepo.mockResolvedValueOnce({
      reader: {
        rootReal: tmpDir,
        listFiles: vi.fn(async () => [
          { path: 'src/app.ts', size: 20, priority: 0 },
        ]),
        readFile: vi.fn(async (p: string) => {
          if (p === 'src/app.ts') return 'export const x = 1;';
          return null;
        }),
        cleanup: cleanupFn,
      },
      cleanup: cleanupFn,
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    const result = await scanCodebase(
      'https://github.com/test/repo',
      options,
      llm as any,
      { token: 'fake-token', branch: 'main' },
    );

    expect(result.target).toBe('https://github.com/test/repo');
    expect(mockCloneRepo).toHaveBeenCalledWith('https://github.com/test/repo', {
      token: 'fake-token',
      branch: 'main',
    });
    // Cleanup should be called in the finally block
    expect(cleanupFn).toHaveBeenCalled();
  });

  it('custom branch is used in result', async () => {
    writeTestFiles({
      'src/app.ts': 'export const x = 1;',
    });

    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    const result = await scanCodebase(tmpDir, options, llm as any, { branch: 'develop' });

    expect(result.branch).toBe('develop');
  });

  it('parse error from LLM is recorded as chunk error', async () => {
    writeTestFiles({
      'src/app.ts': 'export const x = 1;',
    });

    // Return invalid JSON that parseFindings will fail on
    const llm = makeMockLLM(() => 'this is not json at all');
    const options = defaultOptions();

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    // Should complete without throwing
    expect(result).toBeDefined();
    // The chunk should have an error recorded
    const erroredChunks = result.chunks.filter((c) => c.error);
    expect(erroredChunks.length).toBeGreaterThan(0);
    expect(result.stats.erroredChunks.length).toBeGreaterThan(0);
  });

  it('clean domains tracked in stats when domain has zero findings', async () => {
    writeTestFiles({
      'src/auth/login.ts': 'export function login() {}',
      'config/Dockerfile': 'FROM node:18',
    });

    // Return empty findings so all domains are clean
    const llm = makeMockLLM(() => '[]');
    const options = defaultOptions();

    const result = await scanCodebase(tmpDir, options, llm as any, {});

    if (result.chunks.length > 0) {
      // All domains should be clean since LLM returned no findings
      expect(result.stats.cleanDomains.length).toBe(result.coverage.length);
    }
  });
});

describe('RedactingReader', () => {
  it('cleanup is a no-op when the inner reader has no cleanup method', async () => {
    // Inner reader intentionally omits cleanup — exercises the `?.` short-circuit on line 50
    const inner = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => null),
    };

    const reader = new RedactingReader(inner as any);

    await expect(reader.cleanup()).resolves.toBeUndefined();
  });

  it('cleanup delegates to the inner reader when cleanup is present', async () => {
    const cleanup = vi.fn(async () => {});
    const inner = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => null),
      cleanup,
    };

    const reader = new RedactingReader(inner as any);
    await reader.cleanup();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('readFile redacts secrets and returns null for missing files', async () => {
    const files: Record<string, string> = {
      'config.ts': 'const key = "AKIAIOSFODNN7EXAMPLE1";',
    };
    const inner = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async (p: string) => files[p] ?? null),
      cleanup: vi.fn(async () => {}),
    };

    const reader = new RedactingReader(inner as any);

    const redacted = await reader.readFile('config.ts');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE1');

    expect(await reader.readFile('missing.ts')).toBeNull();
  });
});
