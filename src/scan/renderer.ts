import type { ScanResult } from './types.js';
import type { FindingSeverity, ReportFormat } from '../types/index.js';
import { SEVERITY_ORDER } from '../types/index.js';

// ─── Hotspot Scoring ──────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  CRITICAL: 5,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

interface Hotspot {
  file: string;
  score: number;
  total: number;
  breakdown: Partial<Record<FindingSeverity, number>>;
}

function computeHotspots(result: ScanResult): Hotspot[] {
  const map = new Map<string, Hotspot>();

  for (const f of result.findings) {
    let entry = map.get(f.location);
    if (!entry) {
      entry = { file: f.location, score: 0, total: 0, breakdown: {} };
      map.set(f.location, entry);
    }
    entry.score += SEVERITY_WEIGHT[f.severity];
    entry.total += 1;
    entry.breakdown[f.severity] = (entry.breakdown[f.severity] ?? 0) + 1;
  }

  return [...map.values()]
    .sort((a, b) => b.score - a.score || b.total - a.total)
    .slice(0, 10);
}

function formatBreakdown(bd: Partial<Record<FindingSeverity, number>>): string {
  return SEVERITY_ORDER
    .filter((s) => bd[s])
    .map((s) => `${bd[s]} ${s}`)
    .join(', ');
}

// ─── Markdown Renderer ───────────────────────────────────────────────────────

function renderMarkdown(result: ScanResult): string {
  const { findings, stats, coverage } = result;

  if (findings.length === 0) {
    const domainCount = coverage.length;
    const suppressedNote = result.suppressedCount
      ? `\n\n> ℹ️ ${result.suppressedCount} pre-existing finding(s) suppressed by baseline.`
      : '';
    return [
      `# 🔒 Security Scan: ${result.target}`,
      '',
      `**Scanned:** ${result.scannedAt} | **Branch:** ${result.branch} | **Files:** ${result.filesScanned}/${result.filesDiscovered}`,
      '',
      `✅ No security issues found — scanned ${result.filesScanned} files across ${domainCount} domains.${suppressedNote}`,
    ].join('\n');
  }

  const lines: string[] = [];

  // Header
  lines.push(`# 🔒 Security Scan: ${result.target}`);
  lines.push('');
  const suppressedHeader = result.suppressedCount
    ? ` | **Suppressed by baseline:** ${result.suppressedCount}`
    : '';
  lines.push(
    `**Scanned:** ${result.scannedAt} | **Branch:** ${result.branch} | **Files:** ${result.filesScanned}/${result.filesDiscovered}${suppressedHeader}`,
  );

  // Risk Posture
  lines.push('');
  lines.push('## Risk Posture');
  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  for (const sev of SEVERITY_ORDER) {
    lines.push(`| ${sev} | ${stats.bySeverity[sev] ?? 0} |`);
  }

  // Coverage
  lines.push('');
  lines.push('## Coverage');
  lines.push('| Domain | Files Scanned | Findings |');
  lines.push('|--------|---------------|----------|');
  for (const c of coverage) {
    lines.push(`| ${c.domain} | ${c.filesScanned} | ${c.findings} |`);
  }

  // Hotspots
  const hotspots = computeHotspots(result);
  if (hotspots.length > 0) {
    lines.push('');
    lines.push('## Hotspots');
    lines.push('> Top files by finding severity and count');
    lines.push('');
    hotspots.forEach((h, i) => {
      lines.push(
        `${i + 1}. \`${h.file}\` — ${h.total} finding${h.total === 1 ? '' : 's'} (${formatBreakdown(h.breakdown)})`,
      );
    });
  }

  // Findings grouped by severity
  lines.push('');
  lines.push('## Findings');

  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;

    lines.push('');
    lines.push(`### ${sev}`);

    for (const f of group) {
      lines.push('');
      lines.push(`#### [${f.id}] ${f.summary}`);
      lines.push(`**File:** \`${f.location}\` | **Category:** ${f.category}`);
      lines.push(`> ${f.detail}`);
      lines.push('');
      lines.push(`**Suggestion:** ${f.suggestion}`);
      lines.push('');
      lines.push('---');
    }
  }

  return lines.join('\n');
}

// ─── SARIF Renderer ───────────────────────────────────────────────────────────

function mapScanSeverity(severity: FindingSeverity): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return 'error';
    case 'MEDIUM':
      return 'warning';
    case 'LOW':
    case 'INFO':
      return 'note';
  }
}

function parseScanLocation(location: string): { file: string; line: number } {
  const match = location.match(/^(.+?)(?::(\d+))?$/);
  if (!match) return { file: location, line: 1 };
  return { file: match[1], line: parseInt(match[2] ?? '1', 10) };
}

export function renderScanSarif(result: ScanResult): string {
  const sarifLog = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'AgentReview Security Scanner',
          version: '1.0.0',
          informationUri: 'https://github.com/vidyasagarr7/agentreview',
          rules: result.findings.map((f) => ({
            id: f.id,
            shortDescription: { text: f.summary },
            fullDescription: { text: f.detail },
            help: { text: f.suggestion, markdown: f.suggestion },
            defaultConfiguration: { level: mapScanSeverity(f.severity) },
            properties: {
              tags: f.lenses,
              category: f.category,
              severity: f.severity,
            },
          })),
        },
      },
      results: result.findings.map((f) => {
        const loc = parseScanLocation(f.location);
        return {
          ruleId: f.id,
          level: mapScanSeverity(f.severity),
          message: { text: `${f.summary}\n\n${f.detail}\n\nSuggestion: ${f.suggestion}` },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: loc.file },
              region: { startLine: loc.line },
            },
          }],
          properties: {
            category: f.category,
            severity: f.severity,
          },
        };
      }),
      invocations: [{
        executionSuccessful: true,
        properties: {
          target: result.target,
          branch: result.branch,
          scannedAt: result.scannedAt,
          filesScanned: result.filesScanned,
        },
      }],
    }],
  };

  return JSON.stringify(sarifLog, null, 2);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function renderScanReport(result: ScanResult, format: ReportFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'sarif':
      return renderScanSarif(result);
    case 'markdown':
    default:
      return renderMarkdown(result);
  }
}
