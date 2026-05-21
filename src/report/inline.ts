import type { AgentFinding, FindingSeverity } from '../types/index.js';

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🔵',
  INFO: '⚪',
};

export interface InlineComment {
  path: string;
  line: number;
  body: string;
  severity: FindingSeverity;
}

/**
 * Parse a finding location string like "file.ts:42" or "src/auth/login.ts:3-15"
 * into a structured path and line number.
 * Returns null if the location cannot be parsed.
 */
export function parseLocation(location: string): { path: string; line: number } | null {
  // Match "path:line" or "path:startLine-endLine"
  const match = location.match(/^(.+?):(\d+)(?:-\d+)?$/);
  if (!match) return null;

  const path = match[1];
  const line = parseInt(match[2], 10);

  if (!path || Number.isNaN(line) || line <= 0) return null;

  return { path, line };
}

/**
 * Format a finding as an inline review comment body.
 */
export function formatInlineComment(finding: AgentFinding): string {
  const emoji = SEVERITY_EMOJI[finding.severity];
  const lensTag = finding.lenses.length > 1
    ? `[${finding.lenses.join(' + ')}]`
    : `[${finding.lenses[0] ?? 'unknown'}]`;

  const lines: string[] = [
    `**${emoji} ${finding.severity} — ${finding.category}**`,
    `> ${finding.summary}`,
    '',
    finding.detail,
  ];

  if (finding.suggestion) {
    lines.push('', `**Suggestion:** ${finding.suggestion}`);
  }

  lines.push('', `*AgentReview ${lensTag}*`);

  return lines.join('\n');
}

/**
 * Map findings to inline review comments.
 * Only findings with parseable locations whose file appears in changedFiles
 * are mapped to inline comments. The rest go to the fallback array.
 */
export function mapFindingsToInlineComments(
  findings: AgentFinding[],
  changedFiles: string[],
): { inline: InlineComment[]; fallback: AgentFinding[] } {
  const changedSet = new Set(changedFiles);
  const inline: InlineComment[] = [];
  const fallback: AgentFinding[] = [];

  for (const finding of findings) {
    const parsed = parseLocation(finding.location);

    if (parsed && changedSet.has(parsed.path)) {
      inline.push({
        path: parsed.path,
        line: parsed.line,
        body: formatInlineComment(finding),
        severity: finding.severity,
      });
    } else {
      fallback.push(finding);
    }
  }

  return { inline, fallback };
}
