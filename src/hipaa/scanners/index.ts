import type { AgentFinding } from '../../types/index.js';
import type { HipaaConfig } from '../../config/repo-config.js';
import type { ScannerOptions, Scanner } from './types.js';
import { buildPhiFieldSet } from '../phi-patterns.js';
import { phiInLogsScanner } from './phi-in-logs.js';
import { selectStarScanner } from './select-star.js';
import { httpPhiScanner } from './http-phi.js';
import { fhirRulesScanner } from './fhir-rules.js';
import { hl7PhiScanner } from './hl7-phi.js';

const ALL_SCANNERS: Scanner[] = [
  phiInLogsScanner,
  selectStarScanner,
  httpPhiScanner,
  fhirRulesScanner,
  hl7PhiScanner,
];

/**
 * Run all enabled deterministic HIPAA scanners against the given file contents.
 * Returns a flat array of findings with confidenceScore: 100 and deterministic: true.
 */
export function runDeterministicScan(
  files: Map<string, string>,
  config?: HipaaConfig,
): AgentFinding[] {
  const phiFields = buildPhiFieldSet(config);
  const options: ScannerOptions = {
    phiFields,
    phiSourcePatterns: config?.phiSources,
    skipTests: true,
  };

  const enabledScanners = ALL_SCANNERS.filter((scanner) => {
    if (!config?.scanners) return true; // default: all enabled
    const enabled = config.scanners[scanner.id];
    return enabled !== false; // default to true if not explicitly disabled
  });

  const findings: AgentFinding[] = [];

  for (const scanner of enabledScanners) {
    const results = scanner.scan(files, options);
    for (const finding of results) {
      // Ensure deterministic metadata is set (should already be from createDeterministicFinding)
      finding.confidenceScore = 100;
      finding.deterministic = true;
      findings.push(finding);
    }
  }

  return findings;
}
