import type { AgentFinding } from '../../types/index.js';

export interface ScannerOptions {
  /** PHI field names to check for */
  phiFields: Set<string>;
  /** Only run on files matching these patterns (empty = all files) */
  phiSourcePatterns?: string[];
  /** Skip test files */
  skipTests?: boolean;
}

export interface Scanner {
  id: string;
  name: string;
  /** Run deterministic scan on file contents. Returns findings with deterministic: true */
  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[];
}

/** Helper to create a deterministic finding */
export function createDeterministicFinding(opts: {
  scannerId: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  category: string;
  location: string;
  summary: string;
  detail: string;
  suggestion: string;
  regulation: string;
}): AgentFinding {
  return {
    id: `${opts.scannerId}-${Date.now().toString(36)}`,
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
