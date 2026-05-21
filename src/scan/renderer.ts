import type { ScanResult } from './types.js';
import type { FindingSeverity } from '../types/index.js';
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
    return [
      `# 🔒 Security Scan: ${result.target}`,
      '',
      `**Scanned:** ${result.scannedAt} | **Branch:** ${result.branch} | **Files:** ${result.filesScanned}/${result.filesDiscovered}`,
      '',
      `✅ No security issues found — scanned ${result.filesScanned} files across ${domainCount} domains.`,
    ].join('\n');
  }

  const lines: string[] = [];

  // Header
  lines.push(`# 🔒 Security Scan: ${result.target}`);
  lines.push('');
  lines.push(
    `**Scanned:** ${result.scannedAt} | **Branch:** ${result.branch} | **Files:** ${result.filesScanned}/${result.filesDiscovered}`,
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

// ─── Public API ───────────────────────────────────────────────────────────────

export function renderScanReport(result: ScanResult, format: 'markdown' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  return renderMarkdown(result);
}
