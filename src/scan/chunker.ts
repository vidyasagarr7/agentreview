import type {
  ClassifiedFile,
  ChunkFile,
  ScanChunk,
  SecurityDomain,
  SourceReader,
} from './types.js';

/**
 * Rough token estimate: ~4 chars per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate file content to fit within a token budget using head+tail strategy.
 */
export function truncateFile(content: string, budgetTokens: number): string {
  if (estimateTokens(content) <= budgetTokens) {
    return content;
  }

  const halfBudgetChars = Math.floor((budgetTokens / 2) * 4);
  const head = content.slice(0, halfBudgetChars);
  const tail = content.slice(-halfBudgetChars);

  return `${head}\n\n[... TRUNCATED — middle section omitted for token budget ...]\n\n${tail}`;
}

/**
 * Group classified files into LLM-sized chunks by security domain.
 */
export async function chunkFiles(
  files: ClassifiedFile[],
  reader: SourceReader,
  options: { budgetTokens: number; focus?: SecurityDomain[] },
): Promise<ScanChunk[]> {
  const { budgetTokens, focus } = options;
  const effectiveBudget = Math.floor(budgetTokens * 0.85);

  // Group files by domain
  const domainGroups = new Map<SecurityDomain, ClassifiedFile[]>();
  for (const file of files) {
    if (focus && focus.length > 0 && !focus.includes(file.domain)) {
      continue;
    }
    const group = domainGroups.get(file.domain) ?? [];
    group.push(file);
    domainGroups.set(file.domain, group);
  }

  const allChunks: ScanChunk[] = [];

  for (const [domain, domainFiles] of domainGroups) {
    // Sort by priority (P0 first = lowest number first)
    domainFiles.sort((a, b) => a.priority - b.priority);

    // Read contents and build ChunkFiles
    const chunkFiles: ChunkFile[] = [];
    for (const file of domainFiles) {
      const content = await reader.readFile(file.path);
      if (content === null) continue;

      const tokens = estimateTokens(content);
      chunkFiles.push({
        path: file.path,
        content,
        priority: file.priority,
        estimatedTokens: tokens,
      });
    }

    // Pack into chunks
    let currentFiles: ChunkFile[] = [];
    let currentTokens = 0;
    const domainChunks: ScanChunk[] = [];

    for (const cf of chunkFiles) {
      let fileToAdd = cf;

      // If single file exceeds budget, truncate it
      if (cf.estimatedTokens > effectiveBudget) {
        const truncated = truncateFile(cf.content, effectiveBudget);
        const truncTokens = estimateTokens(truncated);
        fileToAdd = { ...cf, content: truncated, estimatedTokens: truncTokens };
      }

      // If adding this file would exceed budget, flush current chunk
      if (currentFiles.length > 0 && currentTokens + fileToAdd.estimatedTokens > effectiveBudget) {
        domainChunks.push({
          id: '', // assigned below
          domain,
          files: currentFiles,
          estimatedTokens: currentTokens,
          focusPrompt: '',
        });
        currentFiles = [];
        currentTokens = 0;
      }

      currentFiles.push(fileToAdd);
      currentTokens += fileToAdd.estimatedTokens;
    }

    // Flush remaining
    if (currentFiles.length > 0) {
      domainChunks.push({
        id: '',
        domain,
        files: currentFiles,
        estimatedTokens: currentTokens,
        focusPrompt: '',
      });
    }

    // Assign IDs
    for (let i = 0; i < domainChunks.length; i++) {
      domainChunks[i].id = `${domain}-${String(i + 1).padStart(3, '0')}`;
    }

    allChunks.push(...domainChunks);
  }

  return allChunks;
}
