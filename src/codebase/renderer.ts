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

export function renderCodebaseContext(input: RenderInput): RenderOutput {
  const { tree, importsOut, diagnostics, budgetTokens } = input;
  const sections: string[] = [];
  let truncated = false;
  let usedTokens = 0;

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

    // Partial inclusion
    const partial: string[] = [header];
    for (const line of lines) {
      const candidate = [...partial, line].join('\n');
      if (usedTokens + estimateTokens(candidate) <= budgetTokens) {
        partial.push(line);
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
      const symbolPart =
        edge.symbols && edge.symbols.length > 0
          ? ` (symbols: ${edge.symbols.join(', ')})`
          : '';
      const target = edge.external ? `${edge.to} (external)` : edge.to;
      return `- ${edge.from} → ${target}${symbolPart}`;
    });
    addSection('## Import Dependencies', lines);
  }

  // Section 2: Repository Structure (flat list, capped at 100 entries)
  if (tree && usedTokens < budgetTokens) {
    const allDiags = [...diagnostics];
    if (tree.truncated) {
      allDiags.push({ level: 'warn', message: 'Repository tree was truncated at GitHub level; some files may not be shown.' });
    }

    const blobEntries = tree.entries
      .filter((e) => e.type === 'blob')
      .slice(0, 100);

    const lines = blobEntries.map((e) => {
      const sizeLabel = e.size !== undefined ? ` (${(e.size / 1024).toFixed(1)}KB)` : '';
      return `- ${e.path}${sizeLabel}`;
    });

    if (blobEntries.length < tree.entries.filter((e) => e.type === 'blob').length) {
      lines.push(`- ... (${tree.entries.filter((e) => e.type === 'blob').length - blobEntries.length} more files)`);
    }

    addSection('## Repository Structure', lines);

    // Update diagnostics with tree-level warnings
    if (tree.truncated && !diagnostics.some((d) => d.message.includes('truncated'))) {
      diagnostics.push({ level: 'warn', message: 'Repository tree was truncated at GitHub level; some files may not be shown.' });
    }
  }

  // Section 3: Diagnostics (lowest priority)
  if (diagnostics.length > 0 && usedTokens < budgetTokens) {
    const lines = diagnostics.map((d) => `- [${d.level.toUpperCase()}] ${d.message}`);
    addSection('## Diagnostics', lines);
  }

  const rendered = sections.join('\n\n');
  return {
    rendered,
    estimatedTokens: estimateTokens(rendered),
    truncated,
  };
}
