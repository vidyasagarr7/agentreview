import type { AgentFinding } from '../../types/index.js';
import { createDeterministicFinding, type Scanner, type ScannerOptions } from './types.js';

const SCANNER_ID = 'audit-trail';

// Test-file patterns to skip
const TEST_FILE_PATTERN = /(?:\.test\.[tj]sx?|\.spec\.[tj]sx?|__tests__\/)/;

// JS/TS file extensions
const JS_TS_PATTERN = /\.[tj]sx?$/;

// PHI route path keywords — route paths suggesting PHI handling
const PHI_ROUTE_KEYWORDS = [
  'patient', 'fhir', 'clinical', 'encounter', 'claim',
  'medication', 'observation', 'diagnosis', 'condition',
  'allergy', 'immunization', 'procedure', 'coverage',
];

// PHI tables for DB operations (matches select-star scanner)
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

// ORM model names that map to PHI tables
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

// Audit indicator patterns — function/variable names indicating audit logging
const AUDIT_INDICATORS_RE = /\b(?:audit|auditLog|auditEvent|createAuditEvent|recordAudit|logAccess|accessLog|auditMiddleware|withAudit)\b/i;

// Decorator patterns for audit (@Audited, @Audit, @LogAccess)
const AUDIT_DECORATOR_RE = /@(?:Audited|Audit|LogAccess)\b/;

// Event-based audit patterns (emit('audit'), eventBus)
const AUDIT_EVENT_RE = /(?:emit\s*\(\s*['"]audit|eventBus\b)/i;

// Route definition patterns: router.get, app.post, fastify.get, server.put, etc.
const ROUTE_DEF_RE = /\b(?:router|app|fastify|server)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i;

// FHIR client operation patterns
const FHIR_OP_RE = /fhirClient\.(read|search|create|update|delete|vread|history)\s*\(\s*['"]([^'"]+)['"]/;

// FHIR write operations (CRITICAL if unaudited)
const FHIR_WRITE_OPS = new Set(['create', 'update', 'delete']);

// SQL query patterns for PHI tables — separate patterns per operation
const SQL_SELECT_RE = /db\.query\s*\(\s*['"`]SELECT\s+.*?\bFROM\s+(\w+)/i;
const SQL_INSERT_RE = /db\.query\s*\(\s*['"`]INSERT\s+INTO\s+(\w+)/i;
const SQL_UPDATE_RE = /db\.query\s*\(\s*['"`]UPDATE\s+(\w+)/i;
const SQL_DELETE_RE = /db\.query\s*\(\s*['"`]DELETE\s+FROM\s+(\w+)/i;

// ORM operation patterns
const ORM_OP_RE = /\b(\w+)\.(findById|findOne|findAll|find|create|update|destroy|save|deleteOne|deleteMany|updateOne|updateMany)\b/;

// ORM write operations (CRITICAL if unaudited)
const ORM_WRITE_OPS = new Set(['create', 'update', 'destroy', 'save', 'deleteOne', 'deleteMany', 'updateOne', 'updateMany']);

// SQL write keywords
const SQL_WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE']);

// Audit log call pattern for incomplete audit detection
const AUDIT_CALL_RE = /\b(?:auditLog|audit|accessLog)\.(?:record|log|create|write|emit)\s*\(/i;

// Required audit field categories
const AUDIT_FIELD_WHO = /\b(?:userId|user_id|actor|principal|subject|performedBy|agent)\b/;
const AUDIT_FIELD_WHAT = /\b(?:resource|entity|target|object|resourceType|action)\b/;
const AUDIT_FIELD_WHEN = /\b(?:timestamp|time|date|when|occurredAt|recorded)\b/;
const AUDIT_FIELD_WHERE = /\b(?:ip\b|ipAddress|source|origin|sourceIp|address)\b/;

// File-level audit middleware pattern
const FILE_LEVEL_AUDIT_RE = /\b(?:app|router|server)\.use\s*\(\s*(?:audit|auditMiddleware)/i;

// Service layer call heuristic: someService.someMethod()
const SERVICE_CALL_RE = /\b\w+Service\.\w+\s*\(/;

function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERN.test(path);
}

function hasNearbyAudit(lines: string[], lineIdx: number, window: number): boolean {
  const start = Math.max(0, lineIdx - window);
  const end = Math.min(lines.length - 1, lineIdx + window);
  for (let i = start; i <= end; i++) {
    if (AUDIT_INDICATORS_RE.test(lines[i])) return true;
    if (AUDIT_DECORATOR_RE.test(lines[i])) return true;
    if (AUDIT_EVENT_RE.test(lines[i])) return true;
  }
  return false;
}

function hasNearbyAuditEvent(lines: string[], lineIdx: number, window: number): boolean {
  const start = Math.max(0, lineIdx - window);
  const end = Math.min(lines.length - 1, lineIdx + window);
  for (let i = start; i <= end; i++) {
    if (/AuditEvent/.test(lines[i])) return true;
    if (AUDIT_INDICATORS_RE.test(lines[i])) return true;
    if (AUDIT_EVENT_RE.test(lines[i])) return true;
  }
  return false;
}

function hasRoutePhiKeyword(routePath: string): boolean {
  const lower = routePath.toLowerCase();
  return PHI_ROUTE_KEYWORDS.some((kw) => lower.includes(kw));
}

function hasFileLevelAudit(content: string): boolean {
  return FILE_LEVEL_AUDIT_RE.test(content);
}

// Check if there's an audit decorator within a few lines before the route
function hasNearbyDecorator(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 3);
  for (let i = start; i < lineIdx; i++) {
    if (AUDIT_DECORATOR_RE.test(lines[i])) return true;
  }
  return false;
}

// Check if the route handler has a service-layer call (heuristic for delegated audit)
function hasServiceCall(lines: string[], startLine: number, endLine: number): boolean {
  for (let i = startLine; i <= endLine; i++) {
    if (SERVICE_CALL_RE.test(lines[i])) return true;
  }
  return false;
}

// ── Sub-detectors ───────────────────────────────────────────────────

function detectRoutesWithoutAudit(
  filePath: string,
  content: string,
  lines: string[],
  _options: ScannerOptions,
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  // If file-level audit middleware exists, skip route-level checks
  if (hasFileLevelAudit(content)) return findings;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const routeMatch = ROUTE_DEF_RE.exec(line);
    if (!routeMatch) continue;

    const routePath = routeMatch[2];

    // Only check routes with PHI-relevant paths
    if (!hasRoutePhiKeyword(routePath)) continue;

    // Check if route line itself has audit middleware (inline middleware arg)
    if (AUDIT_INDICATORS_RE.test(line)) continue;

    // Check for audit decorator above route
    if (hasNearbyDecorator(lines, i)) continue;

    // Find the handler body — scan from route line to a reasonable window
    // Use ±15 line window as v1 approach
    const windowEnd = Math.min(lines.length - 1, i + 20);

    if (hasNearbyAudit(lines, i, 20)) continue;

    // Determine if this is a service-layer delegation
    const usesService = hasServiceCall(lines, i, windowEnd);

    findings.push(
      createDeterministicFinding({
        scannerId: SCANNER_ID,
        severity: usesService ? 'MEDIUM' : 'HIGH',
        category: 'Route Without Audit Trail',
        location: `${filePath}:${i + 1}`,
        summary: `PHI route ${routePath} without audit logging`,
        detail: `Route handler for "${routePath}" accesses PHI but has no visible audit logging.${usesService ? ' Route delegates to a service layer which may handle audit internally.' : ''} HIPAA §164.312(b) requires audit controls for all PHI access.`,
        suggestion: usesService
          ? 'Verify that the service layer includes audit logging, or add explicit audit middleware to this route.'
          : 'Add audit middleware or inline audit logging (auditLog.record) to track who accessed what PHI and when.',
        regulation: '45 CFR §164.312(b)',
      }),
    );
  }

  return findings;
}

function detectFhirWithoutAudit(
  filePath: string,
  _content: string,
  lines: string[],
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fhirMatch = FHIR_OP_RE.exec(line);
    if (!fhirMatch) continue;

    const operation = fhirMatch[1];
    const resourceType = fhirMatch[2];

    // Skip AuditEvent operations themselves — they're the audit, not a PHI op
    if (resourceType === 'AuditEvent') continue;

    // Check for AuditEvent or audit indicators nearby (±15 lines)
    if (hasNearbyAuditEvent(lines, i, 15)) continue;

    const isWriteOp = FHIR_WRITE_OPS.has(operation);

    findings.push(
      createDeterministicFinding({
        scannerId: SCANNER_ID,
        severity: isWriteOp ? 'CRITICAL' : 'HIGH',
        category: 'FHIR Operation Without Audit',
        location: `${filePath}:${i + 1}`,
        summary: `FHIR ${operation}('${resourceType}') without AuditEvent`,
        detail: `FHIR ${operation} operation on ${resourceType} resource without nearby AuditEvent creation. ${isWriteOp ? 'Write operations on PHI require CRITICAL-level audit tracking.' : 'Read operations on PHI should generate audit trails.'}`,
        suggestion: `Create a FHIR AuditEvent resource after this ${operation} operation to maintain a complete audit trail.`,
        regulation: '45 CFR §164.312(b)',
      }),
    );
  }

  return findings;
}

function detectDbWithoutAudit(
  filePath: string,
  _content: string,
  lines: string[],
  _options: ScannerOptions,
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check SQL query patterns — try each pattern
    let sqlOp: string | null = null;
    let tableName: string | null = null;

    const selectMatch = SQL_SELECT_RE.exec(line);
    const insertMatch = SQL_INSERT_RE.exec(line);
    const updateMatch = SQL_UPDATE_RE.exec(line);
    const deleteMatch = SQL_DELETE_RE.exec(line);

    if (selectMatch) { sqlOp = 'SELECT'; tableName = selectMatch[1]; }
    else if (insertMatch) { sqlOp = 'INSERT'; tableName = insertMatch[1]; }
    else if (updateMatch) { sqlOp = 'UPDATE'; tableName = updateMatch[1]; }
    else if (deleteMatch) { sqlOp = 'DELETE'; tableName = deleteMatch[1]; }

    if (sqlOp && tableName) {
      tableName = tableName.toLowerCase();

      // Only flag PHI tables
      if (PHI_TABLES.has(tableName) && !hasNearbyAudit(lines, i, 15)) {
        const isWrite = SQL_WRITE_KEYWORDS.has(sqlOp);

        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: isWrite ? 'CRITICAL' : 'HIGH',
            category: 'Database PHI Access Without Audit',
            location: `${filePath}:${i + 1}`,
            summary: `${sqlOp} on PHI table "${tableName}" without audit trail`,
            detail: `Database ${sqlOp} operation on PHI table "${tableName}" without nearby audit logging. ${isWrite ? 'Write operations on PHI require CRITICAL-level audit tracking.' : 'PHI read operations should generate audit trails.'}`,
            suggestion: 'Add audit logging (auditLog.record) before or after this database operation to track who accessed what PHI.',
            regulation: '45 CFR §164.312(b)',
          }),
        );
        continue;
      }
    }

    // Check ORM patterns
    const ormMatch = ORM_OP_RE.exec(line);
    if (ormMatch) {
      const modelName = ormMatch[1];
      const operation = ormMatch[2];

      // Only flag PHI models
      if (!PHI_ORM_MODELS.has(modelName)) continue;

      // Check for audit nearby
      if (hasNearbyAudit(lines, i, 15)) continue;

      const isWrite = ORM_WRITE_OPS.has(operation);

      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: isWrite ? 'CRITICAL' : 'HIGH',
          category: 'Database PHI Access Without Audit',
          location: `${filePath}:${i + 1}`,
          summary: `${modelName}.${operation}() without audit trail`,
          detail: `ORM ${operation} operation on PHI model "${modelName}" without nearby audit logging. ${isWrite ? 'Write operations on PHI require CRITICAL-level audit tracking.' : 'PHI read operations should generate audit trails.'}`,
          suggestion: 'Add audit logging (auditLog.record) before or after this ORM operation to track who accessed what PHI.',
          regulation: '45 CFR §164.312(b)',
        }),
      );
    }
  }

  return findings;
}

function detectIncompleteAudit(
  filePath: string,
  _content: string,
  lines: string[],
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!AUDIT_CALL_RE.test(line)) continue;

    // Gather the audit call content — scan from this line forward until we
    // find balanced parens or hit 15 lines max
    let block = '';
    let depth = 0;
    let started = false;
    const blockEnd = Math.min(lines.length, i + 15);

    for (let j = i; j < blockEnd; j++) {
      block += lines[j] + '\n';
      for (const ch of lines[j]) {
        if (ch === '(') { depth++; started = true; }
        if (ch === ')') depth--;
      }
      if (started && depth <= 0) break;
    }

    // Check for presence of required field categories
    let missing = 0;
    if (!AUDIT_FIELD_WHO.test(block)) missing++;
    if (!AUDIT_FIELD_WHAT.test(block)) missing++;
    if (!AUDIT_FIELD_WHEN.test(block)) missing++;
    if (!AUDIT_FIELD_WHERE.test(block)) missing++;

    // Flag if 2+ categories are missing
    if (missing >= 2) {
      const missingCategories: string[] = [];
      if (!AUDIT_FIELD_WHO.test(block)) missingCategories.push('who (userId/actor)');
      if (!AUDIT_FIELD_WHAT.test(block)) missingCategories.push('what (resource/action)');
      if (!AUDIT_FIELD_WHEN.test(block)) missingCategories.push('when (timestamp)');
      if (!AUDIT_FIELD_WHERE.test(block)) missingCategories.push('where (ip/source)');

      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'MEDIUM',
          category: 'Incomplete Audit Log Entry',
          location: `${filePath}:${i + 1}`,
          summary: `Audit log entry missing ${missing} required field categories`,
          detail: `Audit log call is missing: ${missingCategories.join(', ')}. HIPAA audit trails must capture who, what, when, and where.`,
          suggestion: `Add the missing fields to the audit entry: ${missingCategories.join(', ')}.`,
          regulation: '45 CFR §164.312(b), §164.530(j)',
        }),
      );
    }
  }

  return findings;
}

// ── Main Scanner ────────────────────────────────────────────────────

export const auditTrailScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Audit Trail Completeness',

  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[] {
    const findings: AgentFinding[] = [];

    for (const [filePath, content] of files) {
      // Skip test files
      if (options.skipTests !== false && isTestFile(filePath)) continue;
      // Only scan JS/TS files
      if (!JS_TS_PATTERN.test(filePath)) continue;

      const lines = content.split('\n');

      findings.push(...detectRoutesWithoutAudit(filePath, content, lines, options));
      findings.push(...detectFhirWithoutAudit(filePath, content, lines));
      findings.push(...detectDbWithoutAudit(filePath, content, lines, options));
      findings.push(...detectIncompleteAudit(filePath, content, lines));
    }

    return findings;
  },
};
