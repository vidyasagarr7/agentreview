# Design Spec: Audit Trail Scanner

**Date:** 2026-05-23
**Author:** Vex (subagent)
**Status:** DRAFT
**Regulation:** HIPAA §164.312(b) — Audit Controls

---

## 1. Problem Statement

HIPAA §164.312(b) requires covered entities to implement audit controls — mechanisms to record and examine activity in systems containing PHI. This means every read, write, update, or delete of PHI must produce an audit trail capturing who, what, when, and where.

Codebases frequently have routes that handle PHI (patient records, FHIR resources, claims data) without any audit logging. Even when audit logging exists, it often lacks required fields (user identity, timestamp, resource affected, action taken).

**Goal:** Detect PHI access operations (database reads/writes, FHIR operations, API routes) that lack nearby audit logging, and flag incomplete audit log entries missing required fields.

---

## 2. Detection Categories

### 2.1 Express/Fastify/Koa Routes Handling PHI Without Audit Middleware

Detect HTTP route handlers in PHI-relevant files that don't reference audit logging:

```typescript
// Express route with PHI access, no audit — HIGH
router.get('/patients/:id', async (req, res) => {
  const patient = await Patient.findById(req.params.id);
  res.json(patient);
  // No audit log! Who accessed this patient record?
});

// Fastify route — same issue
fastify.get('/fhir/Patient/:id', async (request, reply) => {
  const resource = await fhirClient.read('Patient', request.params.id);
  return resource;
});

// Good — has audit middleware or inline audit
router.get('/patients/:id', auditMiddleware, async (req, res) => { ... });
router.get('/patients/:id', async (req, res) => {
  await auditLog.record({ action: 'read', resource: 'Patient', ... });
  ...
});
```

**Pattern strategy:**
- Match route definitions: `router.(get|post|put|patch|delete)`, `app.(get|post|put|...)`, `fastify.(get|post|...)`, `server.(get|post|...)`
- Filter to routes with PHI-relevant paths (containing `patient`, `fhir`, `clinical`, `encounter`, `claim`, `medication`, `observation`, etc.)
- Within the route handler body (scan from route line to the next route definition or end of block — use brace depth tracking), look for audit indicators:
  - Function names: `audit`, `auditLog`, `auditEvent`, `createAuditEvent`, `recordAudit`, `logAccess`, `accessLog`
  - Middleware references: `auditMiddleware`, `audit(`, `withAudit`
  - FHIR AuditEvent: `AuditEvent`, `audit_event`
- If no audit indicator found within the handler scope → flag

**Severity:** HIGH — PHI accessed without audit trail

### 2.2 FHIR Operations Without AuditEvent Generation

Detect FHIR read/write/search operations without corresponding AuditEvent creation:

```typescript
// FHIR read without audit — HIGH
const patient = await fhirClient.read('Patient', id);
// No AuditEvent created

// FHIR search without audit — HIGH
const results = await fhirClient.search('Observation', { patient: id });

// FHIR create/update without audit — CRITICAL
await fhirClient.create('Patient', resource);
await fhirClient.update('Patient', id, resource);

// Good — AuditEvent generated
await fhirClient.read('Patient', id);
await fhirClient.create('AuditEvent', { ... });
```

**Pattern strategy:**
- Match FHIR client calls: `fhirClient.(read|search|create|update|delete|vread|history)`, `client.request`, `fetch('...fhir/Patient...')`
- Also match HAPI FHIR Java patterns: `client.read().resource(Patient.class)`, `dao.search(...)`
- Scan surrounding context (±15 lines or same function scope) for `AuditEvent` reference
- Write operations (create/update/delete) without audit → CRITICAL
- Read operations without audit → HIGH

**Severity:** CRITICAL (write ops), HIGH (read ops)

### 2.3 Database PHI Operations Without Audit Trail

Detect database operations on PHI tables without nearby audit logging:

```typescript
// Direct query without audit — HIGH
const result = await db.query('SELECT * FROM patients WHERE id = $1', [id]);
// No audit log of who queried this patient

// ORM without audit — HIGH
const patient = await Patient.findById(id);
await Patient.update({ ssn: newSsn }, { where: { id } });
// No audit trail for SSN modification — CRITICAL

// Good — audit present
const patient = await Patient.findById(id);
await auditLog.record({ action: 'read', table: 'patients', recordId: id, userId: ctx.user.id });
```

**Pattern strategy:**
- Match database operations: SQL queries mentioning PHI tables (reuse `select-star` scanner's PHI table list), ORM calls on PHI models (`Patient.find*`, `Encounter.create`, etc.)
- Scan surrounding context (±15 lines) for audit indicators (same set as 2.1)
- Write operations (INSERT, UPDATE, DELETE, `.create`, `.update`, `.destroy`, `.save`) → CRITICAL if no audit
- Read operations → HIGH if no audit

**Severity:** CRITICAL (writes), HIGH (reads)

### 2.4 Incomplete Audit Log Entries

Detect audit log calls that are missing required HIPAA audit fields:

```typescript
// Missing required fields — MEDIUM
auditLog.record({ action: 'read' });
// Missing: who (userId), what (resource), when (timestamp)

// Good — complete audit entry
auditLog.record({
  action: 'read',
  userId: req.user.id,       // who
  resource: 'Patient',       // what
  resourceId: id,            // what (specific)
  timestamp: new Date(),     // when
  ipAddress: req.ip,         // where
});
```

**Pattern strategy:**
- Match audit log calls (same indicators as 2.1)
- Within the audit call's object literal (parse brace-delimited block), check for presence of required fields:
  - **Who:** `userId`, `user_id`, `actor`, `principal`, `subject`, `performedBy`, `agent`
  - **What:** `resource`, `entity`, `target`, `object`, `resourceType`, `action`
  - **When:** `timestamp`, `time`, `date`, `when`, `occurredAt`, `recorded`
  - **Where:** `ip`, `ipAddress`, `source`, `origin`, `sourceIp`, `address`
- If the audit call object is missing 2+ of the 4 required categories → flag

**Severity:** MEDIUM — audit exists but is incomplete

---

## 3. Architecture

### Scanner Interface

```typescript
export const auditTrailScanner: Scanner = {
  id: 'audit-trail',
  name: 'Audit Trail Completeness',
  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[]
};
```

### Internal Structure

```
src/hipaa/scanners/audit-trail.ts
├── SCANNER_ID = 'audit-trail'
├── Constants:
│   ├── PHI_ROUTE_KEYWORDS — route paths indicating PHI handling
│   ├── AUDIT_INDICATORS — function/variable names indicating audit logging
│   ├── FHIR_CLIENT_PATTERNS — regex for FHIR client operations
│   ├── PHI_TABLES — reused from select-star (imported or duplicated)
│   ├── AUDIT_FIELD_WHO / WHAT / WHEN / WHERE — field name sets
│   └── ROUTE_PATTERNS — regex for Express/Fastify/Koa route definitions
├── Sub-detectors (private functions):
│   ├── detectRoutesWithoutAudit(filePath, content, lines, options) → findings
│   ├── detectFhirWithoutAudit(filePath, content, lines) → findings
│   ├── detectDbWithoutAudit(filePath, content, lines, options) → findings
│   └── detectIncompleteAudit(filePath, content, lines) → findings
└── scan() orchestrates all sub-detectors
```

### Scope Tracking

The key challenge for this scanner is determining "nearby" context. Strategy:

1. **Line-window approach (v1):** For each PHI operation, scan ±15 lines for audit indicators. Simple, fast, catches most cases.
2. **Brace-depth tracking (v1 enhancement):** For route handlers, track `{` and `}` to find the handler body boundaries, then search within those boundaries.
3. **Future (v2):** Cross-function analysis using the existing cross-file PHI flow infrastructure.

### PHI-Relevance

All categories require PHI-relevant context:
- 2.1: Route path contains PHI keywords
- 2.2: FHIR operations are inherently PHI-relevant
- 2.3: Operations on PHI tables/models
- 2.4: Audit calls are only checked when found (no file filtering needed)

### File Types

- Primary: `.ts`, `.js`, `.tsx`, `.jsx`, `.mjs`, `.cjs`
- Extended: `.java` (HAPI FHIR patterns)
- Skip: test files (default), `node_modules`, generated files

---

## 4. False Positive Mitigation

| Risk | Mitigation |
|------|-----------|
| Audit middleware applied at app level, not visible per-route | Check for `app.use(audit...)` or `router.use(audit...)` at file level; if found, skip route-level checks for that router |
| Generic route names matching PHI keywords (e.g., `/api/patients-ui-config`) | Require route to also contain a PHI operation (DB/FHIR call) inside the handler, not just a matching path |
| Audit logging in a separate middleware file | v1 limitation — flag with suggestion noting middleware may handle it; cross-file analysis in v2 |
| `timestamp` auto-set by audit framework | Still require it in the call — explicit is better, and we can't verify framework defaults |
| Routes that delegate to service layer with audit | v1 limitation — line-window may miss service-layer audit; acceptable since deep call chain analysis is v2 |

---

## 5. Configuration

The scanner respects the standard `hipaaConfig.scanners['audit-trail']` toggle (boolean, default `true`).

Future configuration options:
- Custom audit indicator function names
- Custom PHI route path keywords
- Scope window size (default ±15 lines)

---

## 6. Regulation Mapping

| Detection | HIPAA Regulation | Requirement |
|-----------|-----------------|-------------|
| Routes without audit | §164.312(b) | Audit controls for PHI access |
| FHIR ops without AuditEvent | §164.312(b) | Record and examine PHI activity |
| DB ops without audit | §164.312(b) | Audit controls for PHI access |
| Incomplete audit entries | §164.312(b), §164.530(j) | Audit must capture who/what/when/where |

---

## 7. Interaction with Other Scanners

- **phi-in-logs:** Complementary — `phi-in-logs` catches PHI *in* logs, `audit-trail` catches *missing* logs
- **select-star:** Shares PHI table list; `audit-trail` checks if SELECT operations have audit, `select-star` checks if they're overly broad
- **http-phi:** Complementary — `http-phi` checks transport encryption, `audit-trail` checks if the route is audited
- **fhir-rules:** Complementary — `fhir-rules` checks FHIR API misuse, `audit-trail` checks if FHIR ops are audited
