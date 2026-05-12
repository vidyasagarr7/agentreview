import type { AgentFinding, ModelFinding } from '../types/index.js';

export function normalizeFindings(findings: AgentFinding[], modelLabel: string): ModelFinding[] {
  return findings.map((finding) => ({
    ...finding,
    modelSource: modelLabel,
    modelSources: [modelLabel],
    agreementCount: 1,
  }));
}

export function normalizeLocation(location: string): string {
  return location
    .toLowerCase()
    .trim()
    .replace(/:\d+$/, '')           // strip trailing line numbers (e.g. ":42")
    .replace(/\\/g, '/');           // normalize path separators
}

export function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')        // remove punctuation
    .replace(/\s+/g, ' ');         // collapse whitespace
}
