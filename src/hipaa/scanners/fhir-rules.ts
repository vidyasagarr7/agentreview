import { createDeterministicFinding } from './types.js';
import type { Scanner, ScannerOptions } from './types.js';

const SCANNER_ID = 'fhir-rules';

// Imports that indicate the file uses an HTTP client (not just route definitions)
const HTTP_CLIENT_IMPORTS = [
  /\bimport\b.*\bfetch\b/,
  /\bimport\b.*\baxios\b/,
  /\bimport\b.*\bgot\b/,
  /\bimport\b.*\brequest\b/,
  /\bimport\b.*\bky\b/,
  /\brequire\s*\(\s*['"]axios['"]\s*\)/,
  /\brequire\s*\(\s*['"]got['"]\s*\)/,
  /\brequire\s*\(\s*['"]node-fetch['"]\s*\)/,
  /\brequire\s*\(\s*['"]request['"]\s*\)/,
  /\brequire\s*\(\s*['"]ky['"]\s*\)/,
  /\bimport\b.*['"]https?['"]/,
  /\brequire\s*\(\s*['"]https?['"]\s*\)/,
  /\bfetch\s*\(/,
];

// Sensitive FHIR resources that should always use _elements
const SENSITIVE_RESOURCES = [
  'Patient', 'Person', 'RelatedPerson', 'Practitioner',
  'Condition', 'Observation', 'DiagnosticReport',
  'MedicationRequest', 'AllergyIntolerance', 'Encounter',
  'Immunization', 'Procedure', 'CarePlan', 'Coverage',
];

const FHIR_SEARCH_RE = new RegExp(
  `/(${SENSITIVE_RESOURCES.join('|')})\\?[^\\s"'\`]*`,
  'g',
);

const ELEMENTS_RE = /_elements/;

const BROAD_SCOPE_RE = /['"`]user\/\*\.\*['"`]/;
const MODERATE_SCOPE_RE = /['"`]user\/\*\.read['"`]/;

const EXPORT_RE = /\$export/;
const EXPORT_TYPE_RE = /\$export[^'"`\s]*_type/;

function hasHttpClientImport(content: string): boolean {
  return HTTP_CLIENT_IMPORTS.some((re) => re.test(content));
}

export const fhirRulesScanner: Scanner = {
  id: SCANNER_ID,
  name: 'FHIR API safety rules',

  scan(files, _options) {
    const findings: ReturnType<typeof createDeterministicFinding>[] = [];

    for (const [filePath, content] of files) {
      // Only check files that contain HTTP client usage
      if (!hasHttpClientImport(content)) continue;

      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ── Check 1: FHIR search without _elements ─────────────────────
        FHIR_SEARCH_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = FHIR_SEARCH_RE.exec(line)) !== null) {
          // Check current line and ±3 lines for _elements
          const windowStart = Math.max(0, i - 3);
          const windowEnd = Math.min(lines.length - 1, i + 3);
          let hasElements = false;
          for (let j = windowStart; j <= windowEnd; j++) {
            if (ELEMENTS_RE.test(lines[j])) {
              hasElements = true;
              break;
            }
          }
          if (!hasElements) {
            const resource = match[1];
            findings.push(
              createDeterministicFinding({
                scannerId: SCANNER_ID,
                severity: 'HIGH',
                category: 'FHIR Minimum Necessary',
                location: `${filePath}:${i + 1}`,
                summary: `FHIR ${resource} search without \`_elements\` restriction`,
                detail: `Querying \`/${resource}?...\` without \`_elements\` returns the full resource, potentially including more PHI than needed (Minimum Necessary Rule).`,
                suggestion: `Add \`_elements=id,name,...\` to limit returned fields to only what is needed.`,
                regulation: '45 CFR §164.502(b)',
              }),
            );
          }
        }

        // ── Check 2: Broad SMART scopes ─────────────────────────────────
        if (BROAD_SCOPE_RE.test(line)) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'HIGH',
              category: 'FHIR Scope Overprivilege',
              location: `${filePath}:${i + 1}`,
              summary: `Overly broad SMART scope \`user/*.*\``,
              detail: `The scope \`user/*.*\` grants read+write to all resource types for all patients. Use patient-scoped access (\`patient/*.read\`) to limit exposure.`,
              suggestion: `Replace with the narrowest scope needed, e.g. \`patient/Patient.read patient/Observation.read\`.`,
              regulation: '45 CFR §164.312(a)',
            }),
          );
        }

        if (MODERATE_SCOPE_RE.test(line)) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'MEDIUM',
              category: 'FHIR Scope Overprivilege',
              location: `${filePath}:${i + 1}`,
              summary: `Broad SMART scope \`user/*.read\``,
              detail: `The scope \`user/*.read\` grants read access to all resource types for all patients. Prefer patient-scoped access to follow the Minimum Necessary Rule.`,
              suggestion: `Replace with patient-scoped alternatives, e.g. \`patient/Patient.read\`.`,
              regulation: '45 CFR §164.312(a)',
            }),
          );
        }

        // ── Check 3: Bulk $export without _type ─────────────────────────
        if (EXPORT_RE.test(line) && !EXPORT_TYPE_RE.test(line)) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'HIGH',
              category: 'FHIR Bulk Export',
              location: `${filePath}:${i + 1}`,
              summary: `Bulk \`$export\` without \`_type\` restriction`,
              detail: `Calling \`$export\` without \`_type\` exports all resource types, which may include far more PHI than necessary.`,
              suggestion: `Add \`_type=Patient,Observation,...\` to limit the export to only the needed resource types.`,
              regulation: '45 CFR §164.502(b)',
            }),
          );
        }
      }
    }

    return findings;
  },
};
