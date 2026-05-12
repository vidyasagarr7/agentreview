import type { EnsembleResult, ModelFinding, FindingSeverity } from '../types/index.js';

// ─── Severity Helpers ──────────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🔵',
  INFO: '⚪',
};

// ─── Agreement Indicator ───────────────────────────────────────────────────────

function agreementIndicator(finding: ModelFinding, totalModels: number): string {
  if (finding.agreementCount === totalModels) {
    return '✅'; // unanimous
  } else if (finding.agreementCount > 1) {
    return '⚠️'; // majority
  } else {
    return 'ℹ️'; // single-source
  }
}

// ─── renderEnsembleSummary ─────────────────────────────────────────────────────

export function renderEnsembleSummary(result: EnsembleResult): string {
  const lines: string[] = [];

  // Model table
  lines.push('## Model Results');
  lines.push('');
  lines.push('| Model | Findings | Duration | Status |');
  lines.push('|-------|----------|----------|--------|');

  for (const mr of result.modelResults) {
    const duration = (mr.durationMs / 1000).toFixed(1) + 's';
    const status = mr.error ? `❌ ${mr.error}` : '✅ OK';
    lines.push(`| ${mr.label} | ${mr.findings.length} | ${duration} | ${status} |`);
  }

  lines.push('');

  // Stats summary
  const { stats } = result;
  lines.push('## Ensemble Stats');
  lines.push('');
  lines.push(`- **Models run:** ${stats.modelsRun} (${stats.modelsSucceeded} succeeded)`);
  lines.push(`- **Raw findings:** ${stats.totalRawFindings} → **Merged:** ${stats.mergedFindings}`);
  lines.push('');
  lines.push('**Agreement breakdown:**');
  lines.push('');
  lines.push(`| Agreement | Count |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| ✅ Unanimous (all models) | ${stats.unanimousFindings} |`);
  lines.push(`| ⚠️ Majority (>1 model) | ${stats.majorityFindings} |`);
  lines.push(`| ℹ️ Single-source (1 model) | ${stats.singleSourceFindings} |`);

  return lines.join('\n');
}

// ─── renderEnsembleFinding ────────────────────────────────────────────────────

export function renderEnsembleFinding(finding: ModelFinding, totalModels?: number): string {
  const severityEmoji = SEVERITY_EMOJI[finding.severity];
  const lensTag = finding.lenses.length > 1
    ? `[${finding.lenses.join(' + ')}]`
    : `[${finding.lenses[0] ?? 'unknown'}]`;

  const indicator = totalModels !== undefined
    ? agreementIndicator(finding, totalModels)
    : finding.agreementCount > 1 ? '⚠️' : 'ℹ️';

  const lines: string[] = [
    `#### ${severityEmoji} ${lensTag} ${finding.summary}`,
    ``,
    `**Location:** \`${finding.location}\`  `,
    `**Category:** ${finding.category}`,
    ``,
    finding.detail,
    ``,
    `> **Suggestion:** ${finding.suggestion}`,
    ``,
    `🏷️ **Found by:** ${finding.modelSources.join(', ')} ${indicator}`,
    ``,
    `---`,
  ];

  return lines.join('\n');
}

// ─── renderEnsembleReport ─────────────────────────────────────────────────────

export function renderEnsembleReport(
  result: EnsembleResult,
  prTitle: string,
  prNumber: number,
): string {
  const lines: string[] = [];
  const { stats, mergedFindings } = result;

  // Header
  lines.push(`# AgentReview Ensemble: PR #${prNumber} — ${prTitle}`);
  lines.push('');
  lines.push(`> **Models run:** ${stats.modelsRun} | **Succeeded:** ${stats.modelsSucceeded}`);
  lines.push(`> **Raw findings:** ${stats.totalRawFindings} → **Merged:** ${stats.mergedFindings}`);
  lines.push('');

  // Summary section
  lines.push(renderEnsembleSummary(result));
  lines.push('');

  // Partition findings
  const unanimousFindings = mergedFindings.filter(f => f.agreementCount === stats.modelsRun);
  const majorityFindings = mergedFindings.filter(f => f.agreementCount > 1 && f.agreementCount < stats.modelsRun);
  const singleSourceFindings = mergedFindings.filter(f => f.agreementCount === 1);

  // Unanimous section
  if (unanimousFindings.length > 0) {
    lines.push('## ✅ Unanimous Findings');
    lines.push('');
    lines.push(`> All ${stats.modelsRun} models agree on these issues.`);
    lines.push('');
    for (const finding of unanimousFindings) {
      lines.push(renderEnsembleFinding(finding, stats.modelsRun));
      lines.push('');
    }
  }

  // Majority section
  if (majorityFindings.length > 0) {
    lines.push('## ⚠️ Majority Findings');
    lines.push('');
    lines.push('> Multiple models (but not all) agree on these issues.');
    lines.push('');
    for (const finding of majorityFindings) {
      lines.push(renderEnsembleFinding(finding, stats.modelsRun));
      lines.push('');
    }
  }

  // Single-source section
  if (singleSourceFindings.length > 0) {
    lines.push('## ℹ️ Single-Source Findings');
    lines.push('');
    lines.push('> Flagged by only one model. Review with discretion.');
    lines.push('');
    for (const finding of singleSourceFindings) {
      lines.push(renderEnsembleFinding(finding, stats.modelsRun));
      lines.push('');
    }
  }

  return lines.join('\n');
}
