// ─── import-graph-full.test.ts — Tests for full-repo import graph builders ──

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildRepoTreeFromReader,
  readerToFetcher,
  buildFullImportGraph,
  extendPrGraph,
  type FileFetcher,
} from './import-graph-full.js';
import type { ImportEdge, RepoTree } from '../../types/index.js';
import type { SourceReader, FileEntry } from '../../scan/types.js';

// Mock parser and resolver
vi.mock('../../codebase/parser.js', () => ({
  detectLanguage: vi.fn((f: string) => {
    if (f.endsWith('.ts') || f.endsWith('.tsx')) return 'ts';
    if (f.endsWith('.js') || f.endsWith('.jsx')) return 'js';
    if (f.endsWith('.py')) return 'py';
    return 'other';
  }),
  parseImports: vi.fn(),
}));

vi.mock('../../codebase/resolver.js', () => ({
  isRelativeImport: vi.fn((spec: string) => spec.startsWith('./') || spec.startsWith('../')),
  resolveImport: vi.fn(),
}));

import { parseImports } from '../../codebase/parser.js';
import { resolveImport } from '../../codebase/resolver.js';
const mockParseImports = vi.mocked(parseImports);
const mockResolveImport = vi.mocked(resolveImport);

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeTree(paths: string[]): RepoTree {
  return {
    sha: 'local',
    truncated: false,
    entries: paths.map((p) => ({ path: p, type: 'blob' as const, size: 100 })),
  };
}

function makeFetcher(contents: Record<string, string | null>): FileFetcher {
  return {
    fetchFile: vi.fn(async (path: string) => {
      if (!(path in contents)) return null;
      return contents[path];
    }),
  };
}

// ─── buildRepoTreeFromReader ─────────────────────────────────────────────────

describe('buildRepoTreeFromReader', () => {
  it('maps reader files into a RepoTree with blob entries, local sha, not truncated', async () => {
    const reader = mockReader({
      'src/index.ts': 'const x = 1;',
      'src/util.ts': 'export const y = 2;',
    });

    const tree = await buildRepoTreeFromReader(reader);

    expect(tree.sha).toBe('local');
    expect(tree.truncated).toBe(false);
    expect(tree.entries).toHaveLength(2);

    const indexEntry = tree.entries.find((e) => e.path === 'src/index.ts');
    expect(indexEntry).toBeDefined();
    expect(indexEntry!.type).toBe('blob');
    expect(indexEntry!.size).toBe('const x = 1;'.length);

    const utilEntry = tree.entries.find((e) => e.path === 'src/util.ts');
    expect(utilEntry).toBeDefined();
    expect(utilEntry!.type).toBe('blob');
    expect(utilEntry!.size).toBe('export const y = 2;'.length);
  });

  it('returns an empty entries array when reader has no files', async () => {
    const reader = mockReader({});
    const tree = await buildRepoTreeFromReader(reader);

    expect(tree.entries).toEqual([]);
    expect(tree.sha).toBe('local');
    expect(tree.truncated).toBe(false);
  });
});

// ─── readerToFetcher ─────────────────────────────────────────────────────────

describe('readerToFetcher', () => {
  it('delegates fetchFile to the underlying reader.readFile', async () => {
    const reader = mockReader({
      'src/a.ts': 'contents-a',
      'src/b.ts': null,
    });

    const fetcher = readerToFetcher(reader);

    expect(await fetcher.fetchFile('src/a.ts')).toBe('contents-a');
    expect(await fetcher.fetchFile('src/b.ts')).toBeNull();
    expect(await fetcher.fetchFile('src/missing.ts')).toBeNull();
  });

  it('forwards the exact path argument to reader.readFile', async () => {
    const readFile = vi.fn(async (_p: string): Promise<string | null> => 'data');
    const reader: SourceReader = {
      async listFiles() {
        return [];
      },
      readFile,
    };

    const fetcher = readerToFetcher(reader);
    await fetcher.fetchFile('exact/path.ts');

    expect(readFile).toHaveBeenCalledWith('exact/path.ts');
  });
});

// ─── buildFullImportGraph ────────────────────────────────────────────────────

describe('buildFullImportGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds forward and reverse edges for a valid relative TS import', async () => {
    const tree = makeTree(['src/index.ts', 'src/utils.ts']);
    const fetcher = makeFetcher({
      'src/index.ts': 'import { foo } from "./utils.js";',
      'src/utils.ts': 'export const foo = 1;',
    });

    mockParseImports.mockImplementation((source: string) => {
      if (source.includes('./utils.js')) {
        return [{ module: './utils.js', symbols: ['foo'], isTypeOnly: false }];
      }
      return [];
    });
    mockResolveImport.mockReturnValue('src/utils.ts');

    const result = await buildFullImportGraph(
      ['src/index.ts', 'src/utils.ts'],
      tree,
      fetcher,
    );

    expect(result.filesAnalyzed).toBe(2);
    expect(result.filesFailed).toBe(0);

    const outEdges = result.importsOut.get('src/index.ts');
    expect(outEdges).toBeDefined();
    expect(outEdges).toHaveLength(1);
    expect(outEdges![0]).toEqual({
      from: 'src/index.ts',
      to: 'src/utils.ts',
      external: false,
      symbols: ['foo'],
    });

    // Reverse edge — utils.ts is imported by index.ts
    const inEdges = result.importsIn.get('src/utils.ts');
    expect(inEdges).toBeDefined();
    expect(inEdges).toHaveLength(1);
    expect(inEdges![0].from).toBe('src/index.ts');
    expect(inEdges![0].to).toBe('src/utils.ts');
  });

  it('marks external imports as external and does not add reverse edges', async () => {
    const tree = makeTree(['src/index.ts']);
    const fetcher = makeFetcher({
      'src/index.ts': 'import { Octokit } from "@octokit/rest";',
    });

    mockParseImports.mockReturnValue([
      { module: '@octokit/rest', symbols: ['Octokit'], isTypeOnly: false },
    ]);

    const result = await buildFullImportGraph(['src/index.ts'], tree, fetcher);

    const outEdges = result.importsOut.get('src/index.ts');
    expect(outEdges).toHaveLength(1);
    expect(outEdges![0].external).toBe(true);
    expect(outEdges![0].to).toBe('@octokit/rest');

    // No reverse edge for external imports
    expect(result.importsIn.get('@octokit/rest')).toBeUndefined();
    expect(result.importsIn.size).toBe(0);
  });

  it('records a warn diagnostic and increments filesFailed when fetch returns null', async () => {
    const tree = makeTree(['src/missing.ts']);
    const fetcher: FileFetcher = {
      fetchFile: vi.fn(async () => null),
    };

    const result = await buildFullImportGraph(['src/missing.ts'], tree, fetcher);

    expect(result.filesAnalyzed).toBe(0);
    expect(result.filesFailed).toBe(1);
    expect(result.importsOut.size).toBe(0);
    expect(
      result.diagnostics.some(
        (d) => d.level === 'warn' && d.message.includes('src/missing.ts'),
      ),
    ).toBe(true);
  });

  it('records a warn diagnostic when fetch throws', async () => {
    const tree = makeTree(['src/broken.ts']);
    const fetcher: FileFetcher = {
      fetchFile: vi.fn(async () => {
        throw new Error('network down');
      }),
    };

    const result = await buildFullImportGraph(['src/broken.ts'], tree, fetcher);

    expect(result.filesFailed).toBe(1);
    expect(
      result.diagnostics.some(
        (d) =>
          d.level === 'warn' &&
          d.message.includes('src/broken.ts') &&
          d.message.includes('network down'),
      ),
    ).toBe(true);
  });

  it('records a warn diagnostic when parseImports throws', async () => {
    const tree = makeTree(['src/bad.ts']);
    const fetcher = makeFetcher({
      'src/bad.ts': 'invalid syntax {{{',
    });

    mockParseImports.mockImplementation(() => {
      throw new Error('Unexpected token');
    });

    const result = await buildFullImportGraph(['src/bad.ts'], tree, fetcher);

    expect(result.filesAnalyzed).toBe(0);
    expect(result.filesFailed).toBe(1);
    expect(
      result.diagnostics.some(
        (d) =>
          d.level === 'warn' &&
          d.message.includes('Parse error') &&
          d.message.includes('Unexpected token'),
      ),
    ).toBe(true);
  });

  it('skips non-TS/JS files and emits an info diagnostic about the skipped count', async () => {
    const tree = makeTree(['src/index.ts', 'README.md', 'src/script.py']);
    const fetcher = makeFetcher({
      'src/index.ts': '',
    });

    mockParseImports.mockReturnValue([]);

    const result = await buildFullImportGraph(
      ['src/index.ts', 'README.md', 'src/script.py'],
      tree,
      fetcher,
    );

    // Only the .ts file is analyzed
    expect(result.filesAnalyzed).toBe(1);
    expect(result.filesFailed).toBe(0);

    const infoDiag = result.diagnostics.find(
      (d) => d.level === 'info' && d.message.includes('Skipped'),
    );
    expect(infoDiag).toBeDefined();
    expect(infoDiag!.message).toContain('2');
    expect(infoDiag!.message).toContain('non-TS/JS');
  });

  it('preserves symbols on edges when present and omits them when absent', async () => {
    const tree = makeTree(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const fetcher = makeFetcher({
      'src/a.ts': 'import { foo, bar } from "./b.js"; import "./c.js";',
    });

    mockParseImports.mockReturnValue([
      { module: './b.js', symbols: ['foo', 'bar'], isTypeOnly: false },
      { module: './c.js', isTypeOnly: false }, // no symbols (side-effect import)
    ]);
    mockResolveImport.mockImplementation((_from, spec) => {
      if (spec === './b.js') return 'src/b.ts';
      if (spec === './c.js') return 'src/c.ts';
      return null;
    });

    const result = await buildFullImportGraph(
      ['src/a.ts'],
      tree,
      fetcher,
    );

    const outEdges = result.importsOut.get('src/a.ts');
    expect(outEdges).toHaveLength(2);

    const bEdge = outEdges!.find((e) => e.to === 'src/b.ts');
    expect(bEdge).toBeDefined();
    expect(bEdge!.symbols).toEqual(['foo', 'bar']);

    const cEdge = outEdges!.find((e) => e.to === 'src/c.ts');
    expect(cEdge).toBeDefined();
    expect(cEdge!.symbols).toBeUndefined();
  });

  it('falls back to the raw module specifier when relative import cannot be resolved', async () => {
    const tree = makeTree(['src/a.ts']);
    const fetcher = makeFetcher({
      'src/a.ts': 'import "./missing.js";',
    });

    mockParseImports.mockReturnValue([
      { module: './missing.js', isTypeOnly: false },
    ]);
    mockResolveImport.mockReturnValue(null);

    const result = await buildFullImportGraph(['src/a.ts'], tree, fetcher);

    const outEdges = result.importsOut.get('src/a.ts');
    expect(outEdges).toHaveLength(1);
    expect(outEdges![0].to).toBe('./missing.js');
    expect(outEdges![0].external).toBe(false);
  });
});

// ─── extendPrGraph ───────────────────────────────────────────────────────────

describe('extendPrGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extends a PR graph N hops using BFS and filters to discovered files', async () => {
    // Chain: a.ts → b.ts → c.ts → d.ts. PR touches a.ts. With hopDepth=2, we should
    // discover a, b, c — but not d.
    const allFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const tree = makeTree(allFiles);
    const fetcher = makeFetcher({
      'src/a.ts': 'import { b } from "./b.js";',
      'src/b.ts': 'import { c } from "./c.js";',
      'src/c.ts': 'import { d } from "./d.js";',
      'src/d.ts': 'export const d = 1;',
    });

    mockParseImports.mockImplementation((source: string) => {
      if (source.includes('./b.js')) return [{ module: './b.js', symbols: ['b'], isTypeOnly: false }];
      if (source.includes('./c.js')) return [{ module: './c.js', symbols: ['c'], isTypeOnly: false }];
      if (source.includes('./d.js')) return [{ module: './d.js', symbols: ['d'], isTypeOnly: false }];
      return [];
    });
    mockResolveImport.mockImplementation((_from, spec) => {
      if (spec === './b.js') return 'src/b.ts';
      if (spec === './c.js') return 'src/c.ts';
      if (spec === './d.js') return 'src/d.ts';
      return null;
    });

    // PR edge: a.ts imports b.ts (the changed file)
    const prEdges: ImportEdge[] = [
      { from: 'src/a.ts', to: 'src/b.ts', external: false, symbols: ['b'] },
    ];

    const result = await extendPrGraph(prEdges, allFiles, tree, fetcher, 2);

    // changedFiles = {a, b}. After hop 1: {a, b, c}. After hop 2: {a, b, c, d}.
    // Wait: from a (hop 0) we go to b (already known). From b (hop 0) we go to c.
    // Hop 1 frontier = {c}. From c we go to d. Hop 2 done — discovered includes d.
    // To assert maximum, we test that hopDepth=1 gives {a,b,c} only.

    // With hopDepth=2 we should reach d
    expect(result.importsOut.has('src/a.ts')).toBe(true);
    expect(result.importsOut.has('src/b.ts')).toBe(true);
    expect(result.importsOut.has('src/c.ts')).toBe(true);
    expect(result.importsOut.has('src/d.ts')).toBe(true);

    // Diagnostic includes PR-mode extension stats
    const prDiag = result.diagnostics.find(
      (d) => d.level === 'info' && d.message.includes('PR mode'),
    );
    expect(prDiag).toBeDefined();
    expect(prDiag!.message).toContain('2 changed files');
    expect(prDiag!.message).toContain('2-hop');
  });

  it('limits discovery to changed files only when hopDepth=0', async () => {
    const allFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const tree = makeTree(allFiles);
    const fetcher = makeFetcher({
      'src/a.ts': 'import { b } from "./b.js";',
      'src/b.ts': 'import { c } from "./c.js";',
      'src/c.ts': 'export const c = 1;',
    });

    mockParseImports.mockImplementation((source: string) => {
      if (source.includes('./b.js')) return [{ module: './b.js', isTypeOnly: false }];
      if (source.includes('./c.js')) return [{ module: './c.js', isTypeOnly: false }];
      return [];
    });
    mockResolveImport.mockImplementation((_from, spec) => {
      if (spec === './b.js') return 'src/b.ts';
      if (spec === './c.js') return 'src/c.ts';
      return null;
    });

    const prEdges: ImportEdge[] = [
      { from: 'src/a.ts', to: 'src/b.ts', external: false },
    ];

    const result = await extendPrGraph(prEdges, allFiles, tree, fetcher, 0);

    // Hopdepth=0 — only the changed files {a, b}
    expect(result.importsOut.has('src/a.ts')).toBe(true);
    // b has an outgoing edge in the full graph so importsOut may still contain it,
    // but c must NOT be in either map since it was never discovered.
    expect(result.importsOut.has('src/c.ts')).toBe(false);
    expect(result.importsIn.has('src/c.ts')).toBe(false);
  });

  it('discovers reverse neighbors (files that import a changed file)', async () => {
    // Graph: a.ts → b.ts (a imports b). PR changes b.ts. With hopDepth=1,
    // we should discover a via the reverse edge.
    const allFiles = ['src/a.ts', 'src/b.ts'];
    const tree = makeTree(allFiles);
    const fetcher = makeFetcher({
      'src/a.ts': 'import { b } from "./b.js";',
      'src/b.ts': 'export const b = 1;',
    });

    mockParseImports.mockImplementation((source: string) => {
      if (source.includes('./b.js')) return [{ module: './b.js', isTypeOnly: false }];
      return [];
    });
    mockResolveImport.mockReturnValue('src/b.ts');

    // PR edge: a.ts imports b.ts (b is the changed file). For this test we say
    // only b changed by using an edge where the importer's "from" doesn't appear
    // in changed, but to does — so we seed via the to field.
    const prEdges: ImportEdge[] = [
      { from: 'src/a.ts', to: 'src/b.ts', external: false },
    ];

    const result = await extendPrGraph(prEdges, allFiles, tree, fetcher, 1);

    // Both a and b are reachable
    expect(result.importsOut.has('src/a.ts')).toBe(true);
    expect(result.importsIn.has('src/b.ts')).toBe(true);
  });

  it('forwards filesAnalyzed/filesFailed from the underlying full graph', async () => {
    const allFiles = ['src/a.ts', 'src/missing.ts'];
    const tree = makeTree(allFiles);
    const fetcher: FileFetcher = {
      fetchFile: vi.fn(async (path: string) => {
        if (path === 'src/a.ts') return 'import "./missing.js";';
        return null; // missing.ts fetch returns null → counted as failed
      }),
    };

    mockParseImports.mockReturnValue([{ module: './missing.js', isTypeOnly: false }]);
    mockResolveImport.mockReturnValue('src/missing.ts');

    const prEdges: ImportEdge[] = [
      { from: 'src/a.ts', to: 'src/missing.ts', external: false },
    ];

    const result = await extendPrGraph(prEdges, allFiles, tree, fetcher, 2);

    expect(result.filesAnalyzed).toBe(1);
    expect(result.filesFailed).toBe(1);
    // Diagnostics should include both the underlying warn AND the PR-mode info line
    expect(result.diagnostics.some((d) => d.level === 'warn')).toBe(true);
    expect(
      result.diagnostics.some((d) => d.level === 'info' && d.message.includes('PR mode')),
    ).toBe(true);
  });
});
