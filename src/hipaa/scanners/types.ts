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

let counter = 0;

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
  return {
    id: `${opts.scannerId}-${(++counter).toString().padStart(3, '0')}`,
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

export function resetCounter(): void { counter = 0; }
