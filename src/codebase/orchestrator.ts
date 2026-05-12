import type { PRData, CodebaseContext } from '../types/index.js';
import type { GitHubClient } from '../github/client.js';
import { CodebaseFetcher } from './fetcher.js';
import { buildImportGraph } from './import-graph.js';
import { renderCodebaseContext } from './renderer.js';

export interface CodebaseContextOptions {
  enabled: boolean;
  budgetTokens: number; // default 8000
  verbose?: boolean;
}

export async function buildCodebaseContext(
  pr: PRData,
  gh: GitHubClient,
  options: CodebaseContextOptions,
): Promise<CodebaseContext | undefined> {
  if (!options.enabled) return undefined;

  const diagnostics: Array<{ level: 'info' | 'warn' | 'error'; message: string }> = [];

  try {
    const owner = pr.repoOwner;
    const repo = pr.repoName;
    const baseSha = await gh.getBaseSha(owner, repo, pr.number);

    // Codebase context is built from the base branch; files added by this PR
    // won't exist at baseSha and therefore cannot be analyzed (Bug 5)
    const addedFiles = pr.files.filter((f) => f.status === 'added');
    if (addedFiles.length > 0) {
      diagnostics.push({
        level: 'info',
        message: 'Codebase context reflects the base branch; newly added files in this PR are not analyzed.',
      });
    }

    const fetcher = new CodebaseFetcher(gh, owner, repo, baseSha, {
      maxFiles: 30,
      concurrency: 5,
    });

    const tree = await fetcher.fetchTree();

    const changedFilesPaths = pr.files.map((f) => f.filename);
    const graphResult = await buildImportGraph(changedFilesPaths, tree, fetcher);

    diagnostics.push(...graphResult.diagnostics);

    const { rendered, estimatedTokens, truncated } = renderCodebaseContext({
      tree,
      importsOut: graphResult.importsOut,
      diagnostics,
      budgetTokens: options.budgetTokens,
    });

    if (options.verbose) {
      console.error(`[codebase] ${estimatedTokens} tokens, ${graphResult.filesAnalyzed} files analyzed, truncated=${truncated}`);
      for (const d of diagnostics) {
        console.error(`[codebase] [${d.level}] ${d.message}`);
      }
    }

    return {
      baseSha,
      tree,
      importsOut: graphResult.importsOut,
      rendered,
      estimatedTokens,
      truncated,
      diagnostics,
      parserUsed: 'regex',
      languagesCovered: ['ts', 'js'],
      filesAnalyzed: graphResult.filesAnalyzed,
      filesFailed: graphResult.filesFailed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.verbose) {
      console.error(`[codebase] buildCodebaseContext failed: ${message}`);
    }
    return undefined;
  }
}
