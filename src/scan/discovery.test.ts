import { describe, it, expect } from 'vitest';
import { classifyPriority, classifyDomain, discoverFiles } from './discovery.js';
import type { SourceReader, FileEntry, SecurityDomain } from './types.js';

// ─── classifyPriority ─────────────────────────────────────────────────────────

describe('classifyPriority', () => {
  it('P0: auth middleware', () => {
    expect(classifyPriority('src/auth/middleware.ts')).toBe(0);
  });

  it('P0: jwt library', () => {
    expect(classifyPriority('lib/jwt.ts')).toBe(0);
  });

  it('P1: .env.production', () => {
    expect(classifyPriority('.env.production')).toBe(1);
  });

  it('P1: Dockerfile', () => {
    expect(classifyPriority('Dockerfile')).toBe(1);
  });

  it('P1: GitHub workflow', () => {
    expect(classifyPriority('.github/workflows/deploy.yml')).toBe(1);
  });

  it('P2: routes', () => {
    expect(classifyPriority('src/routes/api.ts')).toBe(2);
  });

  it('P2: controllers', () => {
    expect(classifyPriority('src/controllers/users.ts')).toBe(2);
  });

  it('P3: models', () => {
    expect(classifyPriority('src/models/user.ts')).toBe(3);
  });

  it('P4: test files', () => {
    expect(classifyPriority('test/auth.test.ts')).toBe(4);
  });
});

// ─── classifyDomain ───────────────────────────────────────────────────────────

describe('classifyDomain', () => {
  it('auth domain for login file', () => {
    expect(classifyDomain('src/auth/login.ts')).toBe('auth');
  });

  it('secrets domain for .env', () => {
    expect(classifyDomain('.env')).toBe('secrets');
  });

  it('injection domain for routes', () => {
    expect(classifyDomain('src/routes/users.ts')).toBe('injection');
  });

  it('config domain for Dockerfile', () => {
    expect(classifyDomain('Dockerfile')).toBe('config');
  });

  it('deps domain for package.json', () => {
    expect(classifyDomain('package.json')).toBe('deps');
  });

  it('crypto domain for crypto util', () => {
    expect(classifyDomain('src/utils/crypto.ts')).toBe('crypto');
  });

  it('data-flow domain for worker', () => {
    expect(classifyDomain('src/jobs/worker.ts')).toBe('data-flow');
  });

  it('general domain for misc file', () => {
    expect(classifyDomain('src/utils/format.ts')).toBe('general');
  });
});

// ─── discoverFiles ────────────────────────────────────────────────────────────

function mockReader(files: Array<{ path: string; size: number }>): SourceReader {
  return {
    listFiles: async (): Promise<FileEntry[]> =>
      files.map((f) => ({ path: f.path, size: f.size, priority: 0 })),
    readFile: async () => null,
  };
}

describe('discoverFiles', () => {
  const testFiles = [
    { path: 'src/models/user.ts', size: 500 },
    { path: 'src/auth/middleware.ts', size: 300 },
    { path: '.env', size: 100 },
    { path: 'src/routes/api.ts', size: 400 },
    { path: 'test/auth.test.ts', size: 200 },
  ];

  it('returns files sorted by priority (P0 first)', async () => {
    const result = await discoverFiles(mockReader(testFiles));
    expect(result[0].path).toBe('src/auth/middleware.ts');
    expect(result[0].priority).toBe(0);
    expect(result[result.length - 1].priority).toBeGreaterThanOrEqual(
      result[0].priority,
    );
  });

  it('classifies all files with domain and priority', async () => {
    const result = await discoverFiles(mockReader(testFiles));
    expect(result).toHaveLength(5);
    for (const file of result) {
      expect(file).toHaveProperty('domain');
      expect(file).toHaveProperty('priority');
      expect(file).toHaveProperty('size');
    }
  });

  it('filters by focus domains', async () => {
    const focus: SecurityDomain[] = ['auth'];
    const result = await discoverFiles(mockReader(testFiles), focus);
    expect(result.every((f) => f.domain === 'auth')).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty when focus matches nothing', async () => {
    const focus: SecurityDomain[] = ['crypto'];
    const result = await discoverFiles(mockReader(testFiles), focus);
    expect(result).toHaveLength(0);
  });
});
