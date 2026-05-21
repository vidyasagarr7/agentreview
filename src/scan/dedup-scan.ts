import type { AgentFinding, FindingSeverity } from '../types/index.js';
import { SEVERITY_ORDER } from '../types/index.js';
import type { ChunkResult, SecurityDomain } from './types.js';

// ─── Severity Ranking ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

function higherSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

// ─── Location Parsing ─────────────────────────────────────────────────────────

function parseLocation(location: string): { file: string; line: number | null } {
  const parts = location.split(':');
  const file = parts[0].trim().toLowerCase();
  const line = parts.length > 1 ? parseInt(parts[1], 10) : null;
  return { file, line: line != null && !isNaN(line) ? line : null };
}

// ─── Token Overlap (local implementation) ─────────────────────────────────────

function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...tokensA].filter((t) => tokensB.has(t));
  const union = new Set([...tokensA, ...tokensB]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

const SUMMARY_SIMILARITY_THRESHOLD = 0.5;
const LINE_PROXIMITY_THRESHOLD = 5;

// ─── Merge Helper ─────────────────────────────────────────────────────────────

function mergeInto(target: AgentFinding, source: AgentFinding): void {
  target.severity = higherSeverity(target.severity, source.severity);
  target.lenses = Array.from(new Set([...target.lenses, ...source.lenses]));
  if (source.detail.length > target.detail.length) {
    target.detail = source.detail;
  }
  if (source.suggestion && (!target.suggestion || source.suggestion.length > target.suggestion.length)) {
    target.suggestion = source.suggestion;
  }
  // Preserve deterministic metadata if either side is deterministic
  if (source.deterministic || target.deterministic) {
    target.deterministic = true;
    target.confidenceScore = 100;
  }
}

// ─── Main Dedup Function ──────────────────────────────────────────────────────

/**
 * Scan-specific cross-chunk deduplication.
 *
 * Strategy:
 * 1. Location-proximity merge: same file, ±5 lines, same category → merge
 * 2. Cross-domain merge: same file, similar summary across different domains → merge
 *
 * Returns findings sorted by severity (CRITICAL first).
 */
export function dedupScanFindings(chunkResults: ChunkResult[]): AgentFinding[] {
  // Collect all findings, tagging with source domain via lenses
  const allFindings: AgentFinding[] = [];

  for (const chunk of chunkResults) {
    for (const finding of chunk.findings) {
      const tagged: AgentFinding = {
        ...finding,
        lenses: Array.from(new Set([...finding.lenses, chunk.domain])),
      };
      allFindings.push(tagged);
    }
  }

  if (allFindings.length === 0) return [];

  // ── Pass 1: Location-proximity merge ────────────────────────────────────
  // Group by file, then merge findings within ±5 lines with same category
  const byFile = new Map<string, AgentFinding[]>();
  for (const f of allFindings) {
    const { file } = parseLocation(f.location);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(f);
  }

  const absorbed = new Set<AgentFinding>();

  for (const group of byFile.values()) {
    for (let i = 0; i < group.length; i++) {
      if (absorbed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (absorbed.has(group[j])) continue;
        const a = group[i];
        const b = group[j];

        const locA = parseLocation(a.location);
        const locB = parseLocation(b.location);

        // Same category + within line proximity
        if (
          a.category === b.category &&
          locA.line != null &&
          locB.line != null &&
          Math.abs(locA.line - locB.line) <= LINE_PROXIMITY_THRESHOLD
        ) {
          // When merging deterministic + non-deterministic, keep deterministic as anchor
          if (b.deterministic && !a.deterministic) {
            mergeInto(b, a);
            absorbed.add(a);
          } else {
            mergeInto(a, b);
            absorbed.add(b);
          }
        }
      }
    }
  }

  const afterPass1 = allFindings.filter((f) => !absorbed.has(f));

  // ── Pass 2: Cross-domain merge ──────────────────────────────────────────
  // Same file + similar summary across different chunk domains
  const byFile2 = new Map<string, AgentFinding[]>();
  for (const f of afterPass1) {
    const { file } = parseLocation(f.location);
    if (!byFile2.has(file)) byFile2.set(file, []);
    byFile2.get(file)!.push(f);
  }

  const absorbed2 = new Set<AgentFinding>();

  for (const group of byFile2.values()) {
    for (let i = 0; i < group.length; i++) {
      if (absorbed2.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (absorbed2.has(group[j])) continue;
        const a = group[i];
        const b = group[j];

        // Check they come from different domains (via lenses)
        const domainsA = new Set(a.lenses);
        const domainsB = new Set(b.lenses);

        // Only cross-domain merge if they don't fully share all domains
        const allSame = domainsA.size === domainsB.size && [...domainsA].every((d) => domainsB.has(d));

        if (!allSame && tokenOverlap(a.summary, b.summary) >= SUMMARY_SIMILARITY_THRESHOLD) {
          // When merging deterministic + non-deterministic, keep deterministic as anchor
          if (b.deterministic && !a.deterministic) {
            mergeInto(b, a);
            absorbed2.add(a);
          } else {
            mergeInto(a, b);
            absorbed2.add(b);
          }
        }
      }
    }
  }

  const deduplicated = afterPass1.filter((f) => !absorbed2.has(f));

  // Sort by severity (CRITICAL first)
  deduplicated.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return deduplicated;
}
