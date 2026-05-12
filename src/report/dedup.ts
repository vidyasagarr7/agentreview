import type { AgentResult, AgentFinding, ParseError, FindingSeverity } from '../types/index.js';
import { SEVERITY_ORDER } from '../types/index.js';

/**
 * Deduplication algorithm (v2):
 * - Pass 1: Exact-match dedup — key by (file, severity, normalized summary). Merge lens tags.
 * - Pass 2: Adjacent-severity merge — for each pair sharing the same file with >80% summary
 *   token overlap and severity within one rank, merge into one finding, keeping highest severity.
 *
 * Semantic/Jaccard dedup across unrelated summaries is intentionally deferred to v3.
 */

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

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

/** Jaccard similarity of word tokens between two normalized strings. */
function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(normalizeString(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeString(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 1 : intersection / union;
}

function isAdjacentSeverity(a: FindingSeverity, b: FindingSeverity): boolean {
  return Math.abs(SEVERITY_RANK[a] - SEVERITY_RANK[b]) <= 1;
}

function higherSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

export function deduplicateFindings(results: AgentResult[]): AgentFinding[] {
  // ── Pass 1: exact-match dedup ─────────────────────────────────────────────
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
      }
    }
  }

  const findings = Array.from(seen.values());

  // ── Pass 2: adjacent-severity merge ──────────────────────────────────────
  // Group by file, then look for pairs with adjacent severity + >80% summary overlap.
  // Keep the one with the highest severity and merge lens tags.
  const byFile = new Map<string, AgentFinding[]>();
  for (const f of findings) {
    const file = getFileFromLocation(f.location);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(f);
  }

  const merged = new Set<AgentFinding>(); // findings absorbed into another
  for (const group of byFile.values()) {
    for (let i = 0; i < group.length; i++) {
      if (merged.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (merged.has(group[j])) continue;
        const a = group[i];
        const b = group[j];
        if (
          isAdjacentSeverity(a.severity, b.severity) &&
          tokenOverlap(a.summary, b.summary) > 0.8
        ) {
          // Merge b into a, keep highest severity
          a.severity = higherSeverity(a.severity, b.severity);
          a.lenses = Array.from(new Set([...a.lenses, ...b.lenses]));
          if (b.detail.length > a.detail.length) {
            a.detail = b.detail;
          }
          merged.add(b);
        }
      }
    }
  }

  return findings.filter((f) => !merged.has(f));
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
