import type { AgentFinding } from '../../types/index.js';
import { createDeterministicFinding, type Scanner, type ScannerOptions } from './types.js';

const SCANNER_ID = 'select-star';

// PHI-related table names (case-insensitive matching)
const PHI_TABLES = new Set([
  'patient', 'patients',
  'encounter', 'encounters',
  'diagnosis',
  'medication',
  'observation',
  'condition',
  'allergy',
  'immunization',
  'procedure',
  'claim', 'claims', 'claim_line',
  'coverage',
  'person',
  'member',
  'explanation_of_benefits',
  'consent',
  'care_team',
  'practitioner',
]);

// ORM model names (PascalCase) that map to PHI tables
const PHI_ORM_MODELS = new Set([
  'Patient', 'Patients',
  'Encounter', 'Encounters',
  'Diagnosis',
  'Medication',
  'Observation',
  'Condition',
  'Allergy',
  'Immunization',
  'Procedure',
  'Claim', 'Claims',
  'Coverage',
  'Person',
  'Member',
  'Consent',
  'CareTeam',
  'Practitioner',
]);

// SELECT * FROM <table> — allow whitespace/newlines between tokens (up to 30 chars gaps)
const SELECT_STAR_PATTERN =
  /SELECT[\s\S]{0,30}\*[\s\S]{0,30}FROM[\s\S]{0,30}?\b(\w+)\b/gi;

// ORM findAll/find patterns: Model.findAll() or Model.find() without explicit attributes
const ORM_FIND_PATTERN =
  /\b([A-Z]\w+)\.(findAll|find)\s*\(/g;

function hasExplicitAttributes(content: string, matchIndex: number): boolean {
  // Look ahead from the match for `attributes:` within the next ~100 chars (inside the call)
  const slice = content.slice(matchIndex, matchIndex + 200);
  // Check if there's an `attributes` key before the closing paren
  const parenClose = slice.indexOf(')');
  const relevant = parenClose >= 0 ? slice.slice(0, parenClose) : slice;
  return /\battributes\s*:/.test(relevant);
}

export const selectStarScanner: Scanner = {
  id: SCANNER_ID,
  name: 'SELECT * from PHI Tables',

  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[] {
    const findings: AgentFinding[] = [];

    for (const [filePath, content] of files) {
      // Only scan TS/JS/SQL files
      if (!/\.[tj]sx?$|\.sql$/i.test(filePath)) continue;

      // ── SELECT * FROM ──
      let match: RegExpExecArray | null;
      const selectStarRe = new RegExp(SELECT_STAR_PATTERN.source, SELECT_STAR_PATTERN.flags);
      while ((match = selectStarRe.exec(content)) !== null) {
        const tableName = match[1].toLowerCase();
        if (!PHI_TABLES.has(tableName)) continue;

        // Find line number
        const lineNum = content.slice(0, match.index).split('\n').length;

        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Overly Broad PHI Query',
            location: `${filePath}:${lineNum}`,
            summary: `SELECT * from PHI table "${match[1]}"`,
            detail: `Query uses SELECT * against PHI table "${match[1]}", which retrieves all columns including potentially sensitive health information. This violates the HIPAA Minimum Necessary standard.`,
            suggestion: `Specify only the required columns instead of SELECT *. Example: SELECT id, status FROM ${match[1]}`,
            regulation: '45 CFR §164.502(b)',
          }),
        );
      }

      // ── ORM findAll/find ──
      const ormRe = new RegExp(ORM_FIND_PATTERN.source, ORM_FIND_PATTERN.flags);
      while ((match = ormRe.exec(content)) !== null) {
        const modelName = match[1];
        if (!PHI_ORM_MODELS.has(modelName)) continue;

        // Check if explicit attributes are provided
        if (hasExplicitAttributes(content, match.index)) continue;

        const lineNum = content.slice(0, match.index).split('\n').length;

        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'MEDIUM',
            category: 'Overly Broad PHI Query',
            location: `${filePath}:${lineNum}`,
            summary: `${modelName}.${match[2]}() without explicit attribute selection`,
            detail: `ORM call ${modelName}.${match[2]}() retrieves all columns from a PHI model without specifying attributes, potentially exposing more PHI than necessary.`,
            suggestion: `Add explicit attribute selection: ${modelName}.${match[2]}({ attributes: ['id', 'status'] })`,
            regulation: '45 CFR §164.502(b)',
          }),
        );
      }
    }

    return findings;
  },
};
