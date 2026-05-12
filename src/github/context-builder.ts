import type { PRData, ChangedFile, ReviewContext } from '../types/index.js';

// Security-relevant filename patterns — prioritize these when truncating
const SECURITY_PATTERNS = [
  /auth/i, /password/i, /token/i, /secret/i, /key/i, /crypt/i,
  /login/i, /session/i, /permission/i, /role/i, /access/i, /credential/i,
];

function isSecurityRelevant(filename: string): boolean {
  return SECURITY_PATTERNS.some((p) => p.test(filename));
}

/**
 * Rough token estimate: 1 token ≈ 4 bytes of English text.
 * For code, this is conservative (code is denser). We use it as a safe upper bound.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildFileList(files: ChangedFile[]): string {
  return files
    .map((f) => {
      const status = f.status === 'renamed' ? 'renamed' : f.status;
      return `- ${f.filename} (${status}, +${f.additions}/-${f.deletions})`;
    })
    .join('\n');
}

/**
 * Extract the diff section for a given filename.
 * Handles both same-name diffs (`a/file b/file`) and renamed files (`a/old b/new`).
 */
function extractFilePatch(diff: string, filename: string): string | null {
  // Escape the filename for use in regex
  const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match "diff --git a/<anything> b/<filename>" to handle renamed files
  const pattern = new RegExp(
    `diff --git a/[^\\n]+ b/${escapedFilename}(?=[\\s\\n])[\\s\\S]*?(?=\\ndiff --git |$)`,
    'g'
  );
  const match = pattern.exec(diff);
  return match ? match[0] : null;
}

/** Build a short summary line for a file that could not fit in the diff budget. */
function buildFileSummary(file: ChangedFile): string {
  return `[diff omitted — too large] ${file.filename} (${file.status}, +${file.additions}/-${file.deletions} lines)`;
}

export function buildReviewContext(
  pr: PRData,
  diff: string,
  files: ChangedFile[],
  modelContextTokens: number
): ReviewContext {
  // Reserve budget for system prompt + PR metadata + output
  const RESERVED_TOKENS = 4000;
  const diffBudget = modelContextTokens - RESERVED_TOKENS;

  const fileList = buildFileList(files);
  const fileListTokens = estimateTokens(fileList);
  const availableForDiff = diffBudget - fileListTokens;

  // Separate binary/patchless files from those with diffs
  const skippedFiles: string[] = [];
  const patchableFiles: ChangedFile[] = [];

  for (const file of files) {
    const patch = extractFilePatch(diff, file.filename);
    if (patch === null && !file.patch) {
      // Binary or renamed without usable diff
      skippedFiles.push(file.filename);
    } else {
      patchableFiles.push(file);
    }
  }

  const fullDiffTokens = estimateTokens(diff);

  if (fullDiffTokens <= availableForDiff) {
    return {
      pr,
      diff,
      fileList,
      truncated: false,
      estimatedTokens: fileListTokens + fullDiffTokens,
      skippedFiles,
    };
  }

  // Need to truncate — prioritize security-relevant files, then by size (smaller first to fit more)
  const sortedFiles = [...patchableFiles].sort((a, b) => {
    const aRelevant = isSecurityRelevant(a.filename) ? 1 : 0;
    const bRelevant = isSecurityRelevant(b.filename) ? 1 : 0;
    if (aRelevant !== bRelevant) return bRelevant - aRelevant; // security-relevant first
    return a.changes - b.changes; // smaller files first to fit more
  });

  const includedPatches: string[] = [];
  let usedTokens = 0;
  const droppedFiles: string[] = [];
  const summaryLines: string[] = [];

  for (const file of sortedFiles) {
    const patch = extractFilePatch(diff, file.filename);
    if (!patch) {
      // No diff available — include a summary fallback
      summaryLines.push(buildFileSummary(file));
      continue;
    }

    const patchTokens = estimateTokens(patch);
    if (usedTokens + patchTokens <= availableForDiff) {
      includedPatches.push(patch);
      usedTokens += patchTokens;
    } else {
      // File too large to fit — add a per-file summary instead
      summaryLines.push(buildFileSummary(file));
      droppedFiles.push(file.filename);
    }
  }

  // Append per-file summary lines for dropped/missing files
  const summaryBlock = summaryLines.length > 0
    ? `\n\n--- Omitted files (summary only) ---\n${summaryLines.join('\n')}`
    : '';

  const truncatedDiff = includedPatches.join('\n') + summaryBlock;
  const truncationNote =
    droppedFiles.length > 0
      ? `[TRUNCATED] ${droppedFiles.length} file(s) omitted due to context limits: ${droppedFiles.slice(0, 5).join(', ')}${droppedFiles.length > 5 ? ` and ${droppedFiles.length - 5} more` : ''}`
      : undefined;

  return {
    pr,
    diff: truncatedDiff,
    fileList,
    truncated: droppedFiles.length > 0,
    truncationNote,
    estimatedTokens: fileListTokens + usedTokens,
    skippedFiles,
  };
}
