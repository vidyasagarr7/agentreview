# Implementation Plan: Encryption & Audit Trail Scanners

**Date:** 2026-05-23
**Specs:**
- `2026-05-23-encryption-scanner-design.md`
- `2026-05-23-audit-trail-scanner-design.md`
**Branch:** `feat/encryption-audit-scanners`

---

## Task Breakdown

### Task 1: Encryption Scanner — Tests (RED)
**File:** `src/hipaa/scanners/encryption.test.ts`
**Intent:** Write comprehensive failing tests for all encryption detection categories.

**Tests:**
```
Unencrypted Database Connections:
- mongodb:// without ?tls=true → CRITICAL finding
- mongodb:// with ?tls=true → no finding
- mongodb:// with ?ssl=true → no finding
- postgres:// without ?sslmode=require → CRITICAL
- postgres:// with ?sslmode=require → no finding
- pg.connect({}) without ssl → CRITICAL (in PHI file)
- pg.connect({ ssl: true }) → no finding
- mysql.createConnection({}) without ssl → CRITICAL (in PHI file)
- mysql.createConnection({ ssl: {...} }) → no finding
- localhost/127.0.0.1 connections → no finding (allowlisted)
- Connection in non-PHI file → no finding
- Connection in test file → no finding (skipTests default)

Unencrypted Cloud Storage:
- s3.putObject without ServerSideEncryption in PHI-named bucket → HIGH
- s3.putObject with ServerSideEncryption → no finding
- s3.upload with SSECustomerAlgorithm → no finding
- PutObjectCommand without encryption → HIGH
- Generic bucket name without PHI keywords → no finding
- Azure blob upload without encryption context in PHI file → HIGH
- GCS upload without encryption in PHI file → HIGH

Weak Crypto:
- crypto.createCipher('des', key) → HIGH
- crypto.createCipheriv('rc4', key, iv) → HIGH
- crypto.createCipheriv('aes-128-ecb', key, iv) → HIGH
- crypto.createCipheriv('aes-256-cbc', key, iv) → no finding (safe)
- crypto.createHash('md5') → HIGH
- crypto.createHash('sha1') → HIGH
- crypto.createHash('sha256') → no finding (safe)
- CryptoJS.DES.encrypt(...) → HIGH
- CryptoJS.MD5(...) → HIGH
- CryptoJS.AES.encrypt(...) → no finding
- Weak crypto in ANY file (not just PHI) → still flagged

Unencrypted Cache:
- redis:// scheme → HIGH (in PHI file)
- rediss:// scheme → no finding
- new Redis({ host }) without tls → HIGH (in PHI file)
- new Redis({ host, tls: {} }) → no finding
- Redis in non-PHI file → no finding
- Memcached connection in PHI file → MEDIUM

API Clients:
- axios.create({ baseURL: 'http://...' }) in PHI file → HIGH
- axios.create({ baseURL: 'https://...' }) → no finding
- axios.create({ baseURL: 'http://localhost' }) → no finding
- got.extend({ prefixUrl: 'http://...' }) in PHI file → HIGH
```

**Verification:** All tests fail (RED phase)

---

### Task 2: Encryption Scanner — Implementation (GREEN)
**File:** `src/hipaa/scanners/encryption.ts`
**Intent:** Implement the encryption scanner to make all tests pass.

**Implementation:**
1. Export `encryptionScanner: Scanner` with `id: 'encryption'`
2. Implement sub-detectors:
   - `detectUnencryptedDatabases` — regex for connection URIs + config objects, check for ssl/tls params
   - `detectUnencryptedStorage` — match S3/Azure/GCS calls, check for encryption config nearby (±5 lines)
   - `detectWeakCrypto` — regex for createCipher/createHash/CryptoJS with weak algorithm names
   - `detectUnencryptedCache` — match redis:// vs rediss://, check Redis constructor for tls option
   - `detectInsecureApiClients` — match baseURL/prefixUrl with http:// (excluding allowlist)
3. PHI-relevance gating using same heuristic as `http-phi` (path keywords + phiSourcePatterns)
4. Weak crypto sub-detector runs on ALL files (no PHI gating)
5. Skip test files by default
6. Use `createDeterministicFinding` for all findings

**Verification:** All Task 1 tests pass, `npx tsc --noEmit` clean

---

### Task 3: Audit Trail Scanner — Tests (RED)
**File:** `src/hipaa/scanners/audit-trail.test.ts`
**Intent:** Write comprehensive failing tests for all audit trail detection categories.

**Tests:**
```
Routes Without Audit:
- Express GET /patients/:id with DB call, no audit → HIGH
- Express POST /patients with DB write, no audit → HIGH
- Express GET /patients/:id with auditLog.record nearby → no finding
- Express GET /patients/:id with auditMiddleware in args → no finding
- Fastify GET /fhir/Patient/:id without audit → HIGH
- Route with non-PHI path (/config, /health) → no finding
- Route handler with app.use(auditMiddleware) earlier in file → no finding
- Route in test file → no finding

FHIR Without Audit:
- fhirClient.read('Patient', id) without AuditEvent nearby → HIGH
- fhirClient.create('Patient', data) without AuditEvent → CRITICAL
- fhirClient.update('Patient', id, data) without AuditEvent → CRITICAL
- fhirClient.delete('Patient', id) without AuditEvent → CRITICAL
- fhirClient.search('Observation', params) without AuditEvent → HIGH
- fhirClient.read followed by fhirClient.create('AuditEvent', ...) → no finding
- fhirClient.create('AuditEvent', ...) itself → no finding (not PHI operation)

DB Without Audit:
- db.query('SELECT ... FROM patients') without audit nearby → HIGH
- db.query('INSERT INTO patients') without audit → CRITICAL
- db.query('UPDATE encounters') without audit → CRITICAL
- db.query('DELETE FROM patients') without audit → CRITICAL
- Patient.findById(id) without audit → HIGH
- Patient.create({...}) without audit → CRITICAL
- Patient.findById with auditLog.record within 15 lines → no finding
- db.query on non-PHI table ('SELECT FROM audit_logs') → no finding

Incomplete Audit:
- auditLog.record({ action: 'read' }) — missing who/what/when/where → MEDIUM
- auditLog.record({ action: 'read', userId, resource, timestamp }) — missing where only (1 missing) → no finding
- auditLog.record({ action: 'read', userId, resource, timestamp, ip }) — complete → no finding
- Multiline audit call with all fields → no finding
```

**Verification:** All tests fail (RED phase)

---

### Task 4: Audit Trail Scanner — Implementation (GREEN)
**File:** `src/hipaa/scanners/audit-trail.ts`
**Intent:** Implement the audit trail scanner to make all tests pass.

**Implementation:**
1. Export `auditTrailScanner: Scanner` with `id: 'audit-trail'`
2. Constants:
   - `PHI_ROUTE_KEYWORDS` — path segments indicating PHI routes
   - `AUDIT_INDICATORS` — regex for audit function names/variables
   - `FHIR_WRITE_OPS` / `FHIR_READ_OPS` — classify FHIR operations
   - `PHI_TABLES` — import or duplicate from select-star
   - `AUDIT_FIELDS` — who/what/when/where field name sets
   - `ROUTE_PATTERNS` — regex for Express/Fastify/Koa route defs
3. Implement sub-detectors:
   - `detectRoutesWithoutAudit` — match route defs with PHI paths, scan handler body for audit indicators using brace-depth tracking
   - `detectFhirWithoutAudit` — match FHIR client calls, scan ±15 lines for AuditEvent
   - `detectDbWithoutAudit` — match DB ops on PHI tables, scan ±15 lines for audit indicators
   - `detectIncompleteAudit` — match audit calls, parse object literal for required field categories
4. Check for file-level audit middleware (`app.use(audit...)`) — if found, skip route-level checks
5. Use `createDeterministicFinding` for all findings

**Verification:** All Task 3 tests pass, `npx tsc --noEmit` clean

---

### Task 5: Register Both Scanners in Orchestrator
**File:** `src/hipaa/scanners/index.ts`
**Intent:** Wire both new scanners into the orchestrator.

**Implementation:**
1. Import `encryptionScanner` from `./encryption.js`
2. Import `auditTrailScanner` from `./audit-trail.js`
3. Add both to `ALL_SCANNERS` array
4. Verify config toggle works (scanners can be disabled via `hipaaConfig.scanners.encryption` / `hipaaConfig.scanners['audit-trail']`)

**Tests:**
- Orchestrator test: run with all scanners enabled → new scanners produce findings
- Orchestrator test: disable `encryption` → encryption scanner skipped
- Orchestrator test: disable `audit-trail` → audit trail scanner skipped

**Verification:** All existing + new orchestrator tests pass

---

### Task 6: Refactor & Edge Cases (REFACTOR)
**Intent:** Clean up, handle edge cases, reduce false positives.

**Implementation:**
1. Extract shared utilities if needed (PHI-relevance check, allowlisted hosts, comment detection)
2. Add comment-line detection to encryption scanner (skip `//` and `/* */` block contents)
3. Verify no regression in existing scanners (`npm test`)
4. Run full test suite, ensure TypeScript compiles clean
5. Update any docs if needed

**Verification:** Full `npm test` passes, `npx tsc --noEmit` clean, no regressions

---

## Execution Order

```
Task 1 (Encryption tests - RED)
  → Task 2 (Encryption impl - GREEN)
    → Task 3 (Audit trail tests - RED)
      → Task 4 (Audit trail impl - GREEN)
        → Task 5 (Register in orchestrator)
          → Task 6 (Refactor & edge cases)
```

Each task follows TDD: write failing tests first, then implement to make them pass.

---

## Risk Notes

1. **Audit trail scope tracking:** The ±15 line window is a pragmatic v1 approach. It will miss audit logging done in called functions (e.g., `await patientService.get(id)` where audit is inside `patientService`). This is acceptable for v1 and noted in findings suggestions.

2. **Encryption config object detection:** Checking ±5 lines for SSL options in config objects may produce false positives if two unrelated config objects are close together. Brace-depth tracking within the same object literal is the mitigation.

3. **Cross-file audit middleware:** A common pattern is `app.use(auditMiddleware)` in `app.ts` while routes are in separate files. The v1 scanner can only detect file-local middleware. Cross-file analysis is a v2 enhancement using the existing cross-file PHI flow infrastructure.
