// ─── import-graph.ts — Build an imports-out graph for changed TS/JS files ────

import type { ImportEdge, RepoTree, CodebaseContextDiagnostic } from '../types/index.js';
import type { CodebaseFetcher } from './fetcher.js';
import { detectLanguage, parseImports } from './parser.js';
import { resolveImport, isRelativeImport } from './resolver.js';

export interface ImportGraphResult {
  importsOut: ImportEdge[];
  diagnostics: CodebaseContextDiagnostic[];
  filesAnalyzed: number;
  filesFailed: number;
}

/**
 * Build an import graph for the given changed files.
 *
 * - Filters to TS/JS only (detectLanguage)
 * - Fetches each file's source via the fetcher
 * - Parses imports with parseImports
 * - Resolves relative imports against the repo tree
 * - Returns ImportEdge[] and accumulated diagnostics
 * - Never throws — all errors become diagnostics
 */
export async function buildImportGraph(
  changedFiles: string[],
  tree: RepoTree,
  fetcher: CodebaseFetcher,
): Promise<ImportGraphResult> {
  const importsOut: ImportEdge[] = [];
  const diagnostics: CodebaseContextDiagnostic[] = [];
  let filesAnalyzed = 0;
  let filesFailed = 0;

  // Filter to TS/JS files only
  const supportedFiles = changedFiles.filter((f) => {
    const lang = detectLanguage(f);
    if (lang !== 'ts' && lang !== 'js') {
      diagnostics.push({
        level: 'info',
        message: `Skipped unsupported language for file: ${f}`,
      });
      return false;
    }
    return true;
  });

  for (const filePath of supportedFiles) {
    // Fetch file content
    let source: string | null = null;
    try {
      source = await fetcher.fetchFile(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        level: 'error',
        message: `Failed to fetch file ${filePath}: ${msg}`,
      });
      filesFailed++;
      continue;
    }

    if (source === null) {
      diagnostics.push({
        level: 'warn',
        message: `File not found or empty: ${filePath}`,
      });
      filesFailed++;
      continue;
    }

    // Parse imports
    let rawImports;
    try {
      rawImports = parseImports(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        level: 'error',
        message: `Parse error in ${filePath}: ${msg}`,
      });
      filesFailed++;
      continue;
    }

    filesAnalyzed++;

    // Resolve each import and build edges
    for (const rawImport of rawImports) {
      const isExternal = !isRelativeImport(rawImport.module);

      let resolvedTo: string;
      if (isExternal) {
        // External (bare) import — use specifier as-is
        resolvedTo = rawImport.module;
      } else {
        // Relative import — try to resolve against the tree
        const resolved = resolveImport(filePath, rawImport.module, tree);
        if (resolved === null) {
          diagnostics.push({
            level: 'warn',
            message: `Could not resolve import '${rawImport.module}' from ${filePath}`,
          });
          // Still emit the edge with the raw specifier so the graph is complete
          resolvedTo = rawImport.module;
        } else {
          resolvedTo = resolved;
        }
      }

      const edge: ImportEdge = {
        from: filePath,
        to: resolvedTo,
        external: isExternal,
      };

      if (rawImport.symbols && rawImport.symbols.length > 0) {
        edge.symbols = rawImport.symbols;
      }

      importsOut.push(edge);
    }
  }

  return {
    importsOut,
    diagnostics,
    filesAnalyzed,
    filesFailed,
  };
}
