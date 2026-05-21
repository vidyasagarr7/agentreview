import { describe, it, expect } from 'vitest';
import { estimateTokens, truncateFile, chunkFiles } from './chunker.js';
import type { ClassifiedFile, SourceReader, FileEntry } from './types.js';

function mockReader(fileContents: Record<string, string | null>): SourceReader {
  return {
    async listFiles(): Promise<FileEntry[]> {
      return Object.keys(fileContents).map((path) => ({
        path,
        size: fileContents[path]?.length ?? 0,
        priority: 0,
      }));
    },
    async readFile(path: string): Promise<string | null> {
      return fileContents[path] ?? null;
    },
  };
}

describe('estimateTokens', () => {
  it('estimates tokens as ceil(length / 4)', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('truncateFile', () => {
  it('returns content as-is when within budget', () => {
    const content = 'short';
    expect(truncateFile(content, 100)).toBe(content);
  });

  it('truncates large content with head+tail', () => {
    // 400 chars → 100 tokens. Budget = 10 tokens.
    const content = 'A'.repeat(200) + 'B'.repeat(200);
    const result = truncateFile(content, 10);
    expect(result).toContain('[... TRUNCATED');
    // head = 5 tokens * 4 = 20 chars, tail = 20 chars
    expect(result.startsWith('A'.repeat(20))).toBe(true);
    expect(result.endsWith('B'.repeat(20))).toBe(true);
  });
});

describe('chunkFiles', () => {
  it('enforces budget with 85% safety margin', async () => {
    const budget = 100; // effective = 85 tokens = 340 chars
    const files: ClassifiedFile[] = [
      { path: 'a.ts', size: 200, priority: 0, domain: 'auth' },
      { path: 'b.ts', size: 200, priority: 1, domain: 'auth' },
    ];
    const reader = mockReader({
      'a.ts': 'x'.repeat(200), // 50 tokens
      'b.ts': 'y'.repeat(200), // 50 tokens
    });

    const chunks = await chunkFiles(files, reader, { budgetTokens: budget });
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(Math.floor(budget * 0.85));
    }
  });

  it('groups files by domain', async () => {
    const files: ClassifiedFile[] = [
      { path: 'auth.ts', size: 10, priority: 0, domain: 'auth' },
      { path: 'config.ts', size: 10, priority: 0, domain: 'config' },
      { path: 'auth2.ts', size: 10, priority: 1, domain: 'auth' },
    ];
    const reader = mockReader({
      'auth.ts': 'auth code',
      'config.ts': 'config code',
      'auth2.ts': 'more auth',
    });

    const chunks = await chunkFiles(files, reader, { budgetTokens: 1000 });
    const authChunks = chunks.filter((c) => c.domain === 'auth');
    const configChunks = chunks.filter((c) => c.domain === 'config');

    expect(authChunks.length).toBeGreaterThanOrEqual(1);
    expect(configChunks.length).toBe(1);

    // Auth files should be in auth chunks
    const authPaths = authChunks.flatMap((c) => c.files.map((f) => f.path));
    expect(authPaths).toContain('auth.ts');
    expect(authPaths).toContain('auth2.ts');
    expect(authPaths).not.toContain('config.ts');
  });

  it('sorts by priority within chunks (P0 first)', async () => {
    const files: ClassifiedFile[] = [
      { path: 'low.ts', size: 10, priority: 2, domain: 'auth' },
      { path: 'high.ts', size: 10, priority: 0, domain: 'auth' },
      { path: 'mid.ts', size: 10, priority: 1, domain: 'auth' },
    ];
    const reader = mockReader({
      'low.ts': 'low',
      'high.ts': 'high',
      'mid.ts': 'mid',
    });

    const chunks = await chunkFiles(files, reader, { budgetTokens: 1000 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].files[0].path).toBe('high.ts');
    expect(chunks[0].files[1].path).toBe('mid.ts');
    expect(chunks[0].files[2].path).toBe('low.ts');
  });

  it('truncates a single large file that exceeds budget', async () => {
    const files: ClassifiedFile[] = [
      { path: 'huge.ts', size: 10000, priority: 0, domain: 'secrets' },
    ];
    const reader = mockReader({
      'huge.ts': 'X'.repeat(10000), // 2500 tokens
    });

    const chunks = await chunkFiles(files, reader, { budgetTokens: 100 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].files[0].content).toContain('[... TRUNCATED');
    expect(chunks[0].estimatedTokens).toBeLessThanOrEqual(Math.floor(100 * 0.85) + 20); // small overhead from truncation marker
  });

  it('creates multiple chunks when domain files exceed budget', async () => {
    // Budget 50 tokens (effective 42 tokens = 168 chars)
    // Each file ~100 chars = 25 tokens → only ~1–2 per chunk
    const files: ClassifiedFile[] = [
      { path: 'a.ts', size: 100, priority: 0, domain: 'injection' },
      { path: 'b.ts', size: 100, priority: 1, domain: 'injection' },
      { path: 'c.ts', size: 100, priority: 2, domain: 'injection' },
    ];
    const reader = mockReader({
      'a.ts': 'A'.repeat(100),
      'b.ts': 'B'.repeat(100),
      'c.ts': 'C'.repeat(100),
    });

    const chunks = await chunkFiles(files, reader, { budgetTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    // Check IDs are sequential
    expect(chunks[0].id).toBe('injection-001');
    expect(chunks[1].id).toBe('injection-002');
  });

  it('filters by focus domains', async () => {
    const files: ClassifiedFile[] = [
      { path: 'auth.ts', size: 10, priority: 0, domain: 'auth' },
      { path: 'config.ts', size: 10, priority: 0, domain: 'config' },
      { path: 'secrets.ts', size: 10, priority: 0, domain: 'secrets' },
    ];
    const reader = mockReader({
      'auth.ts': 'auth',
      'config.ts': 'config',
      'secrets.ts': 'secrets',
    });

    const chunks = await chunkFiles(files, reader, {
      budgetTokens: 1000,
      focus: ['auth', 'secrets'],
    });

    const domains = new Set(chunks.map((c) => c.domain));
    expect(domains.has('auth')).toBe(true);
    expect(domains.has('secrets')).toBe(true);
    expect(domains.has('config')).toBe(false);
  });

  it('skips files where reader returns null', async () => {
    const files: ClassifiedFile[] = [
      { path: 'exists.ts', size: 10, priority: 0, domain: 'auth' },
      { path: 'missing.ts', size: 10, priority: 1, domain: 'auth' },
    ];
    const reader = mockReader({
      'exists.ts': 'content',
      'missing.ts': null,
    });

    const chunks = await chunkFiles(files, reader, { budgetTokens: 1000 });
    const allPaths = chunks.flatMap((c) => c.files.map((f) => f.path));
    expect(allPaths).toContain('exists.ts');
    expect(allPaths).not.toContain('missing.ts');
  });
});
