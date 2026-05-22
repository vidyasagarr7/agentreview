import type { AgentFinding, FindingSeverity } from '../../types/index.js';

export interface ScannerOptions {
  phiFields: Set<string>;
  phiSourcePatterns?: string[];
  skipTests?: boolean;
}

export interface Scanner {
  id: string;
  name: string;
  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[];
}

export function createDeterministicFinding(opts: {
  scannerId: string;
  severity: FindingSeverity;
  category: string;
  location: string;
  summary: string;
  detail: string;
  suggestion: string;
  regulation: string;
}): AgentFinding {
  // Deterministic ID from scanner + location (stable across runs, no global counter)
  const locHash = opts.location.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
  return {
    id: `${opts.scannerId}-${locHash}`,
    severity: opts.severity,
    category: opts.category,
    location: opts.location,
    summary: opts.summary,
    detail: opts.detail,
    suggestion: opts.suggestion,
    lenses: ['hipaa'],
    confidenceScore: 100,
    deterministic: true,
    scannerId: opts.scannerId,
    regulation: opts.regulation,
  };
}

