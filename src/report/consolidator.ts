import type {
  AgentResult,
  ConsolidatedReport,
  PRData,
  FindingSeverity,
  FindingStats,
  ValidationStats,
  ReviewConfidence,
  AgentFinding,
  ParseError,
} from '../types/index.js';
import { SEVERITY_ORDER } from '../types/index.js';
import { deduplicateFindings, collectParseErrors } from './dedup.js';

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

const LENS_ORDER = ['security', 'architecture', 'quality'];

function lensRank(lensId: string): number {
  const idx = LENS_ORDER.indexOf(lensId);
  return idx >= 0 ? idx : LENS_ORDER.length;
}

function sortFindings(findings: AgentFinding[]): AgentFinding[] {
  return [...findings].sort((a, b) => {
    // 1. Severity (CRITICAL first)
    const severityDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDiff !== 0) return severityDiff;

    // 2. Primary lens (security > architecture > quality)
    const aLens = Math.min(...a.lenses.map(lensRank));
    const bLens = Math.min(...b.lenses.map(lensRank));
    if (aLens !== bLens) return aLens - bLens;

    // 3. File path alphabetical
    return a.location.localeCompare(b.location);
  });
}

function computeStats(
  findings: AgentFinding[],
  parseErrors: ParseError[],
  results: AgentResult[],
  lensesRun: string[]
): FindingStats {
  const bySeverity: Record<FindingSeverity, number> = {
    CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0,
  };

  const byLens: Record<string, number> = {};

  for (const f of findings) {
    bySeverity[f.severity]++;
    for (const lensId of f.lenses) {
      byLens[lensId] = (byLens[lensId] ?? 0) + 1;
    }
  }

  const erroredLenses = results
    .filter((r) => !!r.error)
    .map((r) => r.lensId);

  const parseErrorLenses = parseErrors.map((e) => e.lensId);

  const cleanLenses = lensesRun.filter(
    (id) =>
      !erroredLenses.includes(id) &&
      !parseErrorLenses.includes(id) &&
      (byLens[id] ?? 0) === 0
  );

  return {
    total: findings.length,
    bySeverity,
    byLens,
    cleanLenses,
    erroredLenses,
    parseErrorLenses,
  };
}

function computeValidationStats(findings: AgentFinding[], visibleFindings: AgentFinding[]): ValidationStats {
  const stats: ValidationStats = {
    confirmed: 0,
    uncertain: 0,
    disproven: 0,
    unvalidated: 0,
    filtered: findings.length - visibleFindings.length,
  };

  for (const finding of findings) {
    switch (finding.disposition) {
      case 'confirmed':
        stats.confirmed++;
        break;
      case 'uncertain':
        stats.uncertain++;
        break;
      case 'disproven':
        stats.disproven++;
        break;
      default:
        stats.unvalidated++;
        break;
    }
  }

  return stats;
}

export function consolidate(
  results: AgentResult[],
  pr: PRData,
  noDedup = false,
  skippedFiles: string[] = []
): ConsolidatedReport {
  const lensesRun = results.map((r) => r.lensId);

  const dedupedFindings = noDedup
    ? results.flatMap((r) => (Array.isArray(r.findings) ? r.findings : []))
    : deduplicateFindings(results);

  const sortedFindings = sortFindings(dedupedFindings);
  const visibleFindings = sortedFindings.filter((finding) => finding.disposition !== 'disproven');
  const parseErrors = collectParseErrors(results);

  const stats = computeStats(visibleFindings, parseErrors, results, lensesRun);
  const validationStats = computeValidationStats(sortedFindings, visibleFindings);

  const hasErrors = results.some((r) => !!r.error);
  const hasParseErrors = parseErrors.length > 0;
  const confidence: ReviewConfidence = hasErrors || hasParseErrors ? 'LOW' : 'NORMAL';

  return {
    pr: {
      title: pr.title,
      number: pr.number,
      author: pr.author,
      repoOwner: pr.repoOwner,
      repoName: pr.repoName,
      filesChanged: pr.files.length,
      additions: pr.additions,
      deletions: pr.deletions,
    },
    reviewedAt: new Date().toISOString(),
    lensesRun,
    findings: visibleFindings,
    parseErrors,
    stats,
    validationStats,
    confidence,
    skippedFiles,
  };
}
