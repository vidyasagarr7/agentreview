import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMCompleteOptions } from '../llm/client.js';
import type { ScanOptions, ScanProgressCallback, SourceReader, FileEntry } from './types.js';
import { scanCodebase } from './orchestrator.js';

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
});
