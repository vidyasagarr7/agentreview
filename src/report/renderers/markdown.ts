import type { ConsolidatedReport, AgentFinding, FindingSeverity, FindingDisposition } from '../../types/index.js';

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🔵',
  INFO: '⚪',
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  CRITICAL: 'Must fix before merge',
  HIGH: 'Should fix before merge',
  MEDIUM: 'Consider fixing',
  LOW: 'Minor improvement',
  INFO: 'Informational',
};

const SEVERITY_ORDER: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

function renderFinding(f: AgentFinding, showConfidence = false): string {
  const lensTag = f.lenses.length > 1
    ? `[${f.lenses.join(' + ')}]`
    : `[${f.lenses[0] ?? 'unknown'}]`;

  const confidenceTag = showConfidence && f.confidenceScore !== undefined
    ? ` _(confidence: ${f.confidenceScore}%)_`
    : '';

  return [
    `#### ${SEVERITY_EMOJI[f.severity]} ${lensTag} ${f.summary}${confidenceTag}`,
    ``,
    `**Location:** \`${f.location}\`  `,
    `**Category:** ${f.category}`,
    ``,
    f.detail,
    ``,
    `> **Suggestion:** ${f.suggestion}`,
    ``,
    `---`,
  ].join('\n');
}

function renderSummaryTable(report: ConsolidatedReport): string {
  const rows = SEVERITY_ORDER
    .filter((s) => report.stats.bySeverity[s] > 0)
    .map((s) => `| ${SEVERITY_EMOJI[s]} ${s} | ${report.stats.bySeverity[s]} | ${SEVERITY_LABEL[s]} |`);

  if (rows.length === 0) {
    return '| Severity | Count | Meaning |\n|----------|-------|------|\n| ✅ All clean | 0 | No issues found |';
  }

  return [
    '| Severity | Count | Meaning |',
    '|----------|-------|---------|',
    ...rows,
  ].join('\n');
}

export function renderMarkdown(report: ConsolidatedReport): string {
  const { pr, stats, findings, parseErrors, lensesRun, confidence, reviewedAt } = report;

  const lines: string[] = [];

  // Header (the <!-- agentreview --> marker is added by the GitHub posting layer only)
  lines.push(`# AgentReview: PR #${pr.number} — ${pr.title}`);
  lines.push(``);
  lines.push(`> **Reviewed by:** ${lensesRun.join(' · ')}  `);
  lines.push(`> **Reviewed at:** ${reviewedAt}  `);
  lines.push(`> **Files changed:** ${pr.filesChanged} | **+${pr.additions}** / **-${pr.deletions}** lines`);

  if (confidence === 'LOW') {
    lines.push(``);
    lines.push(`> ⚠️ **Review confidence: LOW** — one or more lenses failed or returned unparseable output. Results may be incomplete.`);
  }

  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(renderSummaryTable(report));

  // ParseErrors (shown prominently before findings)
  if (parseErrors.length > 0) {
    lines.push(``);
    lines.push(`## ⚠️ Parse Errors`);
    lines.push(``);
    lines.push(`The following lenses returned responses that could not be parsed. These results are **missing from the report** and the review may be incomplete:`);
    lines.push(``);
    for (const err of parseErrors) {
      lines.push(`### ⚠️ [PARSE ERROR] \`${err.lensId}\` lens`);
      lines.push(``);
      lines.push(`${err.message}`);
      lines.push(``);
      if (err.raw) {
        lines.push(`<details><summary>Raw response (truncated)</summary>`);
        lines.push(``);
        lines.push(`\`\`\``);
        lines.push(err.raw);
        lines.push(`\`\`\``);
        lines.push(`</details>`);
      }
      lines.push(``);
    }
  }

  // Validation Summary (only when validation was performed)
  const vs = report.validationStats;
  const hasValidation = vs && (vs.confirmed + vs.uncertain + vs.disproven + vs.unvalidated) > 0;

  if (hasValidation && vs) {
    lines.push(`## Validation Summary`);
    lines.push(``);
    lines.push(`| Status | Count |`);
    lines.push(`|--------|-------|`);
    if (vs.confirmed > 0) lines.push(`| ✅ Confirmed | ${vs.confirmed} |`);
    if (vs.uncertain > 0) lines.push(`| ⚠️ Uncertain | ${vs.uncertain} |`);
    if (vs.disproven > 0) lines.push(`| ❌ Disproven | ${vs.disproven} |`);
    if (vs.unvalidated > 0) lines.push(`| ❓ Unvalidated | ${vs.unvalidated} |`);
    if (vs.filtered > 0) lines.push(``);
    if (vs.filtered > 0) lines.push(`> Filtered from PR comment: ${vs.filtered} low-confidence finding${vs.filtered !== 1 ? 's' : ''} hidden.`);
    lines.push(``);
  }

  // Findings grouped by disposition when validated, or by severity when not
  if (findings.length > 0 && hasValidation) {
    const confirmed = findings.filter((f) => f.disposition === 'confirmed');
    const uncertain = findings.filter((f) => f.disposition === 'uncertain');
    const unvalidated = findings.filter((f) => !f.disposition || f.disposition === 'unvalidated');

    if (confirmed.length > 0) {
      lines.push(`## ✅ Confirmed Findings`);
      lines.push(``);
      for (const f of confirmed) {
        lines.push(renderFinding(f, true));
        lines.push(``);
      }
    }

    if (uncertain.length > 0) {
      lines.push(`## ⚠️ Uncertain Findings`);
      lines.push(``);
      lines.push(`> These findings scored between 40-59% confidence. Review manually.`);
      lines.push(``);
      for (const f of uncertain) {
        lines.push(renderFinding(f, true));
        lines.push(``);
      }
    }

    if (unvalidated.length > 0) {
      lines.push(`## Unvalidated Findings`);
      lines.push(``);
      for (const f of unvalidated) {
        lines.push(renderFinding(f));
        lines.push(``);
      }
    }
  } else if (findings.length > 0) {
    lines.push(`## Findings`);
    lines.push(``);

    for (const severity of SEVERITY_ORDER) {
      const severityFindings = findings.filter((f) => f.severity === severity);
      if (severityFindings.length === 0) continue;

      lines.push(`### ${SEVERITY_EMOJI[severity]} ${severity} (${severityFindings.length})`);
      lines.push(``);

      for (const f of severityFindings) {
        lines.push(renderFinding(f));
        lines.push(``);
      }
    }
  } else if (parseErrors.length === 0) {
    lines.push(``);
    lines.push(`## ✅ No Issues Found`);
    lines.push(``);
    lines.push(`All lenses reviewed this PR and found no issues. Ship it! 🚀`);
  }

  // Lens Notes
  lines.push(`## Lens Notes`);
  lines.push(``);

  for (const lensId of lensesRun) {
    const count = stats.byLens[lensId] ?? 0;
    const isClean = stats.cleanLenses.includes(lensId);
    const isErrored = stats.erroredLenses.includes(lensId);
    const isParseError = stats.parseErrorLenses.includes(lensId);

    lines.push(`### ${lensId}`);

    if (isErrored) {
      lines.push(`❌ This lens encountered an error and could not complete the review.`);
    } else if (isParseError) {
      lines.push(`⚠️ This lens returned a response that could not be parsed.`);
    } else if (isClean) {
      lines.push(`✅ No issues found.`);
    } else {
      lines.push(`Found ${count} issue${count !== 1 ? 's' : ''}.`);
    }
    lines.push(``);
  }

  // Skipped files (binary or no patch available)
  if (report.skippedFiles && report.skippedFiles.length > 0) {
    lines.push(`## ⚠️ Skipped Files`);
    lines.push(``);
    lines.push(`The following files were not reviewed because they are binary or have no diff patch:`);
    lines.push(``);
    for (const f of report.skippedFiles) {
      lines.push(`- \`${f}\` _(binary or no patch)_`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Generated by [AgentReview](https://github.com/vidyasagarr7/agentreview)*`);

  return lines.join('\n');
}
