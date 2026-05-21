import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';

import type { AgentFinding, FindingSeverity } from '../types/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BaselineEntry {
  fingerprint: string;
  severity: FindingSeverity;
  location: string;
  summary: string;
  suppressedAt: string;
}

export interface Baseline {
  version: 1;
  createdAt: string;
  updatedAt: string;
  target: string;
  entries: BaselineEntry[];
}

// ─── Fingerprinting ───────────────────────────────────────────────────────────

/**
 * Generate a stable fingerprint for a finding.
 * Hash of: location file (without line number) + category + first 100 chars of summary (lowercased, trimmed).
 */
export function generateFingerprint(finding: AgentFinding): string {
  // Strip line number from location: "src/auth.ts:42" → "src/auth.ts"
  const file = finding.location.split(':')[0].trim();
  const category = finding.category.toLowerCase().trim();
  const summaryPrefix = finding.summary.toLowerCase().trim().slice(0, 100);

  const input = `${file}||${category}||${summaryPrefix}`;
  return createHash('sha256').update(input).digest('hex');
}

// ─── Load / Save ──────────────────────────────────────────────────────────────

/**
 * Load a baseline from disk. Returns null if the file doesn't exist.
 */
export async function loadBaseline(baselinePath: string): Promise<Baseline | null> {
  try {
    const raw = await readFile(baselinePath, 'utf-8');
    return JSON.parse(raw) as Baseline;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Save a baseline to disk.
 */
export async function saveBaseline(baselinePath: string, baseline: Baseline): Promise<void> {
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/**
 * Compare findings against a baseline.
 * Returns new findings (not in baseline) and suppressed findings (in baseline).
 */
export function filterNewFindings(
  findings: AgentFinding[],
  baseline: Baseline,
): { new: AgentFinding[]; suppressed: AgentFinding[] } {
  const baselineFingerprints = new Set(baseline.entries.map((e) => e.fingerprint));

  const newFindings: AgentFinding[] = [];
  const suppressed: AgentFinding[] = [];

  for (const finding of findings) {
    const fp = generateFingerprint(finding);
    if (baselineFingerprints.has(fp)) {
      suppressed.push(finding);
    } else {
      newFindings.push(finding);
    }
  }

  return { new: newFindings, suppressed };
}

// ─── Creation ─────────────────────────────────────────────────────────────────

/**
 * Create a new baseline from current findings.
 */
export function createBaseline(findings: AgentFinding[], target: string): Baseline {
  const now = new Date().toISOString();

  const entries: BaselineEntry[] = findings.map((f) => ({
    fingerprint: generateFingerprint(f),
    severity: f.severity,
    location: f.location,
    summary: f.summary,
    suppressedAt: now,
  }));

  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    target,
    entries,
  };
}
