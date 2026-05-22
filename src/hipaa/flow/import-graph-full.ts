// ─── import-graph-full.ts — Full-repo bidirectional import graph ─────────────

import pLimit from 'p-limit';
import type { ImportEdge, RepoTree, CodebaseContextDiagnostic } from '../../types/index.js';
import type { FullImportGraph } from './types.js';
import { detectLanguage, parseImports } from '../../codebase/parser.js';
import { resolveImport, isRelativeImport } from '../../codebase/resolver.js';
import type { SourceReader } from '../../scan/types.js';

/** Minimal file-fetcher interface (works with CodebaseFetcher or SourceReader wrapper) */
export interface FileFetcher {
  fetchFile(path: string): Promise<string | null>;
}

// ─── RepoTree Adapter (Claude challenge #1) ──────────────────────────────────
// Build a RepoTree from a local SourceReader for scan mode.

export async function buildRepoTreeFromReader(reader: SourceReader): Promise<RepoTree> {
  const files = await reader.listFiles();
  return {
    sha: 'local',
    truncated: false,
    entries: files.map((f) => ({
      path: f.path,
      type: 'blob' as const,
      size: f.size,
    })),
  };
}

// ─── Fetcher Adapter ──────────────────────────────────────────────────────────
// Wrap a SourceReader as a CodebaseFetcher for import resolution.

export function readerToFetcher(reader: SourceReader): FileFetcher {
  return {
    fetchFile: async (path: string) => reader.readFile(path),
  };
}

// ─── Build Full Import Graph ──────────────────────────────────────────────────

/**
 * Build a bidirectional import graph for all TS/JS files in the repo.
 * - importsOut: file → what it imports
 * - importsIn: file → what imports it (reverse edges)
 */
export async function buildFullImportGraph(
  allFiles: string[],
  tree: RepoTree,
  fetcher: FileFetcher,
): Promise<FullImportGraph> {
  const importsOut = new Map<string, ImportEdge[]>();
  const importsIn = new Map<string, ImportEdge[]>();
  const diagnostics: CodebaseContextDiagnostic[] = [];
  let filesAnalyzed = 0;
  let filesFailed = 0;

  // Filter to TS/JS files
  const supportedFiles = allFiles.filter((f) => {
    const lang = detectLanguage(f);
    return lang === 'ts' || lang === 'js';
  });

  const nonSupported = allFiles.length - supportedFiles.length;
  if (nonSupported > 0) {
    diagnostics.push({
      level: 'info',
      message: `Skipped ${nonSupported} non-TS/JS files for import graph`,
    });
  }

  // Parallelize file fetching + parsing (concurrency 10)
  const limit = pLimit(10);
  const fileResults: Array<{ filePath: string; edges: ImportEdge[] } | { filePath: string; error: string }> = [];

  await Promise.all(
    supportedFiles.map((filePath) =>
      limit(async () => {
        let source: string | null = null;
        try {
          source = await fetcher.fetchFile(filePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fileResults.push({ filePath, error: `Failed to fetch: ${msg}` });
          return;
        }

        if (source === null) {
          fileResults.push({ filePath, error: 'File not found or empty' });
          return;
        }

        let rawImports;
        try {
          rawImports = parseImports(source);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fileResults.push({ filePath, error: `Parse error: ${msg}` });
          return;
        }

        const edges: ImportEdge[] = [];
        for (const rawImport of rawImports) {
          const isExt = !isRelativeImport(rawImport.module);
          let resolvedTo: string;
          if (isExt) {
            resolvedTo = rawImport.module;
          } else {
            const resolved = resolveImport(filePath, rawImport.module, tree);
            resolvedTo = resolved ?? rawImport.module;
          }
          const edge: ImportEdge = { from: filePath, to: resolvedTo, external: isExt };
          if (rawImport.symbols && rawImport.symbols.length > 0) {
            edge.symbols = rawImport.symbols;
          }
          edges.push(edge);
        }

        fileResults.push({ filePath, edges });
      }),
    ),
  );

  // Merge results (sequential to avoid Map race conditions)
  for (const result of fileResults) {
    if ('error' in result) {
      diagnostics.push({ level: 'warn', message: `${result.filePath}: ${result.error}` });
      filesFailed++;
      continue;
    }

    filesAnalyzed++;
    importsOut.set(result.filePath, result.edges);

    for (const edge of result.edges) {
      if (!edge.external) {
        const existing = importsIn.get(edge.to) ?? [];
        existing.push(edge);
        importsIn.set(edge.to, existing);
      }
    }
  }

  return {
    importsOut,
    importsIn,
    filesAnalyzed,
    filesFailed,
    diagnostics,
  };
}

// ─── Extend PR Graph (2-hop, Claude challenge #7) ────────────────────────────

/**
 * For PR mode: take the PR-scoped edges and extend with N-hop neighbors
 * from all changed files. Returns a full bidirectional graph.
 */
export async function extendPrGraph(
  prEdges: ImportEdge[],
  allFiles: string[],
  tree: RepoTree,
  fetcher: FileFetcher,
  hopDepth: number = 2,
): Promise<FullImportGraph> {
  // Collect changed files from PR edges
  const changedFiles = new Set<string>();
  for (const edge of prEdges) {
    changedFiles.add(edge.from);
    if (!edge.external) changedFiles.add(edge.to);
  }

  // BFS to discover N-hop neighbors
  const discovered = new Set<string>(changedFiles);
  let frontier = new Set<string>(changedFiles);

  // We need to build the full graph first to discover neighbors
  const fullGraph = await buildFullImportGraph(allFiles, tree, fetcher);

  for (let hop = 0; hop < hopDepth; hop++) {
    const nextFrontier = new Set<string>();

    for (const file of frontier) {
      // Forward neighbors (files this file imports)
      const outEdges = fullGraph.importsOut.get(file) ?? [];
      for (const edge of outEdges) {
        if (!edge.external && !discovered.has(edge.to)) {
          discovered.add(edge.to);
          nextFrontier.add(edge.to);
        }
      }

      // Reverse neighbors (files that import this file)
      const inEdges = fullGraph.importsIn.get(file) ?? [];
      for (const edge of inEdges) {
        if (!discovered.has(edge.from)) {
          discovered.add(edge.from);
          nextFrontier.add(edge.from);
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  // Filter full graph to only discovered files
  const filteredOut = new Map<string, ImportEdge[]>();
  const filteredIn = new Map<string, ImportEdge[]>();

  for (const file of discovered) {
    const outEdges = fullGraph.importsOut.get(file);
    if (outEdges) filteredOut.set(file, outEdges);

    const inEdges = fullGraph.importsIn.get(file);
    if (inEdges) filteredIn.set(file, inEdges);
  }

  return {
    importsOut: filteredOut,
    importsIn: filteredIn,
    filesAnalyzed: fullGraph.filesAnalyzed,
    filesFailed: fullGraph.filesFailed,
    diagnostics: [
      ...fullGraph.diagnostics,
      {
        level: 'info',
        message: `PR mode: ${changedFiles.size} changed files → ${discovered.size} files after ${hopDepth}-hop extension`,
      },
    ],
  };
}
