import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildImportGraph } from './import-graph.js';
import type { RepoTree } from '../types/index.js';
import type { CodebaseFetcher } from './fetcher.js';

// Mock parser and resolver
vi.mock('./parser.js', () => ({
  detectLanguage: vi.fn((f: string) => {
    if (f.endsWith('.ts') || f.endsWith('.tsx')) return 'ts';
    if (f.endsWith('.js') || f.endsWith('.jsx')) return 'js';
    if (f.endsWith('.py')) return 'py';
    return 'other';
  }),
  parseImports: vi.fn(),
}));

vi.mock('./resolver.js', () => ({
  isRelativeImport: vi.fn((spec: string) => spec.startsWith('./') || spec.startsWith('../')),
  resolveImport: vi.fn(),
}));

import { parseImports } from './parser.js';
import { resolveImport } from './resolver.js';
const mockParseImports = vi.mocked(parseImports);
const mockResolveImport = vi.mocked(resolveImport);

describe('buildImportGraph', () => {
  const tree: RepoTree = {
    sha: 'abc',
    entries: [
      { path: 'src/index.ts', type: 'blob', size: 100 },
      { path: 'src/utils.ts', type: 'blob', size: 50 },
    ],
    truncated: false,
  };

  let fetcher: CodebaseFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = {
      fetchFile: vi.fn(),
      fetchFiles: vi.fn(),
      fetchTree: vi.fn(),
    } as unknown as CodebaseFetcher;
  });

  it('builds edges for simple imports', async () => {
    (fetcher.fetchFile as any).mockResolvedValue('import { foo } from "./utils.js";');
    mockParseImports.mockReturnValue([
      { module: './utils.js', symbols: ['foo'], isTypeOnly: false },
    ]);
    mockResolveImport.mockReturnValue('src/utils.ts');

    const result = await buildImportGraph(['src/index.ts'], tree, fetcher);

    expect(result.importsOut).toHaveLength(1);
    expect(result.importsOut[0]).toEqual({
      from: 'src/index.ts',
      to: 'src/utils.ts',
      external: false,
      symbols: ['foo'],
    });
    expect(result.filesAnalyzed).toBe(1);
    expect(result.filesFailed).toBe(0);
  });

  it('handles external vs internal imports', async () => {
    (fetcher.fetchFile as any).mockResolvedValue('import { Octokit } from "@octokit/rest";');
    mockParseImports.mockReturnValue([
      { module: '@octokit/rest', symbols: ['Octokit'], isTypeOnly: false },
    ]);

    const result = await buildImportGraph(['src/index.ts'], tree, fetcher);

    expect(result.importsOut).toHaveLength(1);
    expect(result.importsOut[0].external).toBe(true);
    expect(result.importsOut[0].to).toBe('@octokit/rest');
  });

  it('handles files that do not exist (null from fetcher)', async () => {
    (fetcher.fetchFile as any).mockResolvedValue(null);

    const result = await buildImportGraph(['src/missing.ts'], tree, fetcher);

    expect(result.importsOut).toHaveLength(0);
    expect(result.filesFailed).toBe(1);
    expect(result.diagnostics.some((d) => d.level === 'warn' && d.message.includes('missing.ts'))).toBe(true);
  });

  it('returns diagnostics for failed parses', async () => {
    (fetcher.fetchFile as any).mockResolvedValue('invalid code {{{');
    mockParseImports.mockImplementation(() => {
      throw new Error('Unexpected token');
    });

    const result = await buildImportGraph(['src/broken.ts'], tree, fetcher);

    expect(result.importsOut).toHaveLength(0);
    expect(result.filesFailed).toBe(1);
    expect(result.diagnostics.some((d) => d.level === 'error' && d.message.includes('Parse error'))).toBe(true);
  });

  it('returns an error diagnostic when fetchFile throws', async () => {
    (fetcher.fetchFile as any).mockRejectedValue(new Error('network down'));

    const result = await buildImportGraph(['src/index.ts'], tree, fetcher);

    expect(result.importsOut).toHaveLength(0);
    expect(result.filesAnalyzed).toBe(0);
    expect(result.filesFailed).toBe(1);
    expect(
      result.diagnostics.some(
        (d) =>
          d.level === 'error' &&
          d.message.includes('Failed to fetch file src/index.ts') &&
          d.message.includes('network down'),
      ),
    ).toBe(true);
  });

  it('emits a warn diagnostic and raw edge when a relative import cannot be resolved', async () => {
    (fetcher.fetchFile as any).mockResolvedValue('import { gone } from "./missing.js";');
    mockParseImports.mockReturnValue([
      { module: './missing.js', symbols: ['gone'], isTypeOnly: false },
    ]);
    mockResolveImport.mockReturnValue(null);

    const result = await buildImportGraph(['src/index.ts'], tree, fetcher);

    expect(result.importsOut).toHaveLength(1);
    expect(result.importsOut[0]).toEqual({
      from: 'src/index.ts',
      to: './missing.js',
      external: false,
      symbols: ['gone'],
    });
    expect(
      result.diagnostics.some(
        (d) => d.level === 'warn' && d.message.includes("Could not resolve import './missing.js'"),
      ),
    ).toBe(true);
  });

  it('does not set edge.symbols when the import has an empty symbols array', async () => {
    (fetcher.fetchFile as any).mockResolvedValue('import "./side-effect.js";');
    mockParseImports.mockReturnValue([
      { module: './side-effect.js', symbols: [], isTypeOnly: false },
    ]);
    mockResolveImport.mockReturnValue('src/utils.ts');

    const result = await buildImportGraph(['src/index.ts'], tree, fetcher);

    expect(result.importsOut).toHaveLength(1);
    expect(result.importsOut[0]).toEqual({
      from: 'src/index.ts',
      to: 'src/utils.ts',
      external: false,
    });
    expect(result.importsOut[0].symbols).toBeUndefined();
  });
});
