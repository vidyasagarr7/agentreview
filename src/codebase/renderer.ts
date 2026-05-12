import type { RepoTree, ImportEdge, CodebaseContextDiagnostic } from '../types/index.js';

export interface RenderInput {
  tree?: RepoTree;
  importsOut: ImportEdge[];
  diagnostics: CodebaseContextDiagnostic[];
  budgetTokens: number;
}

export interface RenderOutput {
  rendered: string;
  estimatedTokens: number;
  truncated: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Strip control characters (including newlines) and cap length to prevent prompt injection. */
function sanitize(str: string): string {
  return str.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 200);
}

const MAX_IMPORTS = 200;
const MAX_TREE_ENTRIES = 500;

export function renderCodebaseContext(input: RenderInput): RenderOutput {
  const { tree, budgetTokens } = input;

  // Work on a copy — never mutate the caller's diagnostics array (Security 3)
  const localDiagnostics: CodebaseContextDiagnostic[] = [...input.diagnostics];

  const sections: string[] = [];
  let truncated = false;
  let usedTokens = 0;

  // Cap importsOut at MAX_IMPORTS before processing (Security 4)
  let importsOut = input.importsOut;
  if (importsOut.length > MAX_IMPORTS) {
    localDiagnostics.push({
      level: 'warn',
      message: `Import edges capped at ${MAX_IMPORTS} (${importsOut.length} total); some dependencies not shown.`,
    });
    importsOut = importsOut.slice(0, MAX_IMPORTS);
  }

  // Helper: try to add a section, partially if needed
  function addSection(header: string, lines: string[]): void {
    if (lines.length === 0) return;
    const full = [header, ...lines].join('\n');
    const fullTokens = estimateTokens(full);

    if (usedTokens + fullTokens <= budgetTokens) {
      sections.push(full);
      usedTokens += fullTokens;
      return;
    }

    // Partial inclusion — incremental running total to avoid O(n²) re-joins (Security 2)
    const partial: string[] = [header];
    let partialTokens = estimateTokens(header);
    for (const line of lines) {
      const lineTokens = estimateTokens('\n' + line);
      if (usedTokens + partialTokens + lineTokens <= budgetTokens) {
        partial.push(line);
        partialTokens += lineTokens;
      } else {
        truncated = true;
        break;
      }
    }
    if (partial.length > 1) {
      const text = partial.join('\n');
      sections.push(text);
      usedTokens += estimateTokens(text);
    } else {
      truncated = true;
    }
  }

  // Section 1: Import Dependencies (highest priority)
  if (importsOut.length > 0) {
    const lines = importsOut.map((edge) => {
      // Sanitize all repo-controlled strings to prevent prompt injection (Security 1)
      const from = sanitize(edge.from);
      const to = sanitize(edge.to);
      const symbolPart =
        edge.symbols && edge.symbols.length > 0
          ? ` (symbols: ${edge.symbols.map(sanitize).join(', ')})`
          : '';
      const target = edge.external ? `${to} (external)` : to;
      return `- ${from} → ${target}${symbolPart}`;
    });
    addSection('## Import Dependencies', lines);
  }

  // Section 2: Repository Structure
  if (tree && usedTokens < budgetTokens) {
    if (tree.truncated) {
      localDiagnostics.push({
        level: 'warn',
        message: 'Repository tree was truncated at GitHub level; some files may not be shown.',
      });
    }

    // Cap total blob entries at MAX_TREE_ENTRIES before processing (Security 4)
    const allBlobEntries = tree.entries.filter((e) => e.type === 'blob');
    let blobEntries = allBlobEntries;
    if (allBlobEntries.length > MAX_TREE_ENTRIES) {
      localDiagnostics.push({
        level: 'warn',
        message: `Repository tree capped at ${MAX_TREE_ENTRIES} entries (${allBlobEntries.length} total); some files not shown.`,
      });
      blobEntries = allBlobEntries.slice(0, MAX_TREE_ENTRIES);
    }

    // Further display cap at 100 entries (existing behaviour)
    const displayEntries = blobEntries.slice(0, 100);

    const lines = displayEntries.map((e) => {
      // Sanitize file paths to prevent prompt injection (Security 1)
      const sizeLabel = e.size !== undefined ? ` (${(e.size / 1024).toFixed(1)}KB)` : '';
      return `- ${sanitize(e.path)}${sizeLabel}`;
    });

    if (displayEntries.length < blobEntries.length) {
      lines.push(`- ... (${blobEntries.length - displayEntries.length} more files)`);
    }

    addSection('## Repository Structure', lines);
  }

  // Section 3: Diagnostics (lowest priority)
  if (localDiagnostics.length > 0 && usedTokens < budgetTokens) {
    const lines = localDiagnostics.map((d) => `- [${d.level.toUpperCase()}] ${d.message}`);
    addSection('## Diagnostics', lines);
  }

  const rendered = sections.join('\n\n');
  return {
    rendered,
    estimatedTokens: estimateTokens(rendered),
    truncated,
  };
}
