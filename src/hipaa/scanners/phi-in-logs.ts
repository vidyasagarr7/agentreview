import type { AgentFinding } from '../../types/index.js';
import { createDeterministicFinding, type Scanner, type ScannerOptions } from './types.js';

const SCANNER_ID = 'phi-in-logs';

// Log call patterns — match the function name portion
const LOG_CALL_PATTERN =
  /\b(?:console\.(?:log|error|warn|info|debug)|logger\.(?:info|warn|error|debug)|log\.(?:info|error|debug)|debug\(|trace\()/;

// Test-file patterns to skip
const TEST_FILE_PATTERN = /(?:\.test\.[tj]sx?|\.spec\.[tj]sx?|__tests__\/)/;

// Detect if a line is the start/continuation of a multiline template literal or object literal
function isMultilineContext(line: string): boolean {
  const trimmed = line.trim();
  // Count parens and braces (not backticks — they're symmetric)
  const openCount = (trimmed.match(/[{(]/g) || []).length;
  const closeCount = (trimmed.match(/[})]/g) || []).length;
  // Also check for trailing comma, unclosed template literal
  const hasTrailingComma = /,\s*$/.test(trimmed);
  const oddBackticks = ((trimmed.match(/`/g) || []).length % 2) !== 0;
  return openCount > closeCount || hasTrailingComma || oddBackticks;
}

// Short common words that need access-pattern context to avoid FPs
const BROAD_FIELDS = new Set(['email', 'phone', 'address', 'name', 'condition', 'procedure', 'medication', 'treatment', 'status', 'type', 'code']);

function containsPhiField(line: string, phiFields: Set<string>): string | undefined {
  for (const field of phiFields) {
    if (BROAD_FIELDS.has(field.toLowerCase())) {
      // Require access pattern: obj.field, obj['field'], { field: val }, field=val
      const accessRe = new RegExp(`\\.${escapeRegex(field)}\\b|\\['${escapeRegex(field)}'\\]|\\b${escapeRegex(field)}\\s*[:=]`);
      if (accessRe.test(line)) return field;
    } else {
      // Specific fields (ssn, mrn, dateOfBirth, etc.) — word boundary match is safe
      const re = new RegExp(`\\b${escapeRegex(field)}\\b`);
      if (re.test(line)) return field;
    }
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const phiInLogsScanner: Scanner = {
  id: SCANNER_ID,
  name: 'PHI in Log Statements',

  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[] {
    const findings: AgentFinding[] = [];
    const { phiFields, skipTests = true } = options;

    for (const [filePath, content] of files) {
      // Skip test files
      if (skipTests && TEST_FILE_PATTERN.test(filePath)) continue;
      // Only scan TS/JS files
      if (!/\.[tj]sx?$/.test(filePath)) continue;

      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if this line contains a log call
        if (!LOG_CALL_PATTERN.test(line)) continue;

        // SAME-LINE: check if PHI field is on the same line as the log call
        const sameLineField = containsPhiField(line, phiFields);
        if (sameLineField) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'CRITICAL',
              category: 'PHI Exposure in Logs',
              location: `${filePath}:${i + 1}`,
              summary: `PHI field "${sameLineField}" logged directly`,
              detail: `Log statement contains PHI field "${sameLineField}" on the same line. This can expose protected health information in log output, violating HIPAA audit and confidentiality requirements.`,
              suggestion: `Remove "${sameLineField}" from the log statement, or redact/mask it before logging.`,
              regulation: '45 CFR §164.312(b), §164.530(c)',
            }),
          );
          continue; // Already found on this line, move on
        }

        // MULTILINE FALLBACK: if the log line opens a multiline context, check ±1 lines
        if (isMultilineContext(line)) {
          const nearbyLines = [
            i + 1 < lines.length ? lines[i + 1] : '',
          ];
          // Also check previous line if it's a continuation
          if (i > 0) {
            nearbyLines.push(lines[i - 1]);
          }

          for (const nearbyLine of nearbyLines) {
            const nearbyField = containsPhiField(nearbyLine, phiFields);
            if (nearbyField) {
              findings.push(
                createDeterministicFinding({
                  scannerId: SCANNER_ID,
                  severity: 'HIGH',
                  category: 'PHI Exposure in Logs',
                  location: `${filePath}:${i + 1}`,
                  summary: `PHI field "${nearbyField}" in multiline log context`,
                  detail: `Log statement spans multiple lines and PHI field "${nearbyField}" appears in the multiline context. This can expose protected health information in log output.`,
                  suggestion: `Remove "${nearbyField}" from the log statement, or redact/mask it before logging.`,
                  regulation: '45 CFR §164.312(b), §164.530(c)',
                }),
              );
              break; // One finding per log call for multiline
            }
          }
        }
      }
    }

    return findings;
  },
};
