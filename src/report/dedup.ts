import type { AgentResult, AgentFinding, ParseError } from '../types/index.js';

/**
 * Simple exact-match deduplication.
 * Two findings are duplicates if they share the same file, severity, and normalized summary.
 * Jaccard/semantic dedup is intentionally deferred to v2.
 */

function normalizeString(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ''); // strip punctuation
}

function getFileFromLocation(location: string): string {
  // Extract filename part before any line number
  // e.g., "src/auth.ts:42" → "src/auth.ts"
  return location.split(':')[0].toLowerCase().trim();
}

function findingKey(finding: AgentFinding): string {
  const file = getFileFromLocation(finding.location);
  const summary = normalizeString(finding.summary);
  return `${file}|${finding.severity}|${summary}`;
}

export function deduplicateFindings(results: AgentResult[]): AgentFinding[] {
  const seen = new Map<string, AgentFinding>();

  for (const result of results) {
    if (!Array.isArray(result.findings)) {
      // ParseError — skip (handled separately)
      continue;
    }

    for (const finding of result.findings) {
      const key = findingKey(finding);
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, { ...finding });
      } else {
        // Merge: union lens tags, keep longest detail
        existing.lenses = Array.from(new Set([...existing.lenses, ...finding.lenses]));
        if (finding.detail.length > existing.detail.length) {
          existing.detail = finding.detail;
        }
        // Keep highest severity (already same in our exact-match key, but guard for safety)
        // (Not needed for exact-match but kept for future extension)
      }
    }
  }

  return Array.from(seen.values());
}

export function collectParseErrors(results: AgentResult[]): ParseError[] {
  const errors: ParseError[] = [];
  for (const result of results) {
    if (!Array.isArray(result.findings) && result.findings && (result.findings as ParseError).type === 'ParseError') {
      errors.push(result.findings as ParseError);
    }
  }
  return errors;
}
