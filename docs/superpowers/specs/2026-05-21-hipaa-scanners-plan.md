# Implementation Plan: HIPAA Deterministic Scanners

**Date:** 2026-05-21
**Spec:** `2026-05-21-hipaa-deterministic-scanners-design.md`
**Branch:** `feat/hipaa-deterministic-scanners`

---

## Task Breakdown

### Task 1: Extend AgentFinding type + scanner interface
**Files:** `src/types/index.ts`, `src/hipaa/scanners/types.ts`
**Intent:** Add optional fields to AgentFinding and define scanner interface.
**Implementation:**
- Add to AgentFinding: `scannerId?: string`, `regulation?: string`, `deterministic?: boolean`
- Create `src/hipaa/scanners/types.ts` with Scanner interface
- `Scanner { id, name, scan(files: Map<string, string>, config?: HipaaConfig): AgentFinding[] }`
**Verification:** `npx tsc --noEmit`, existing tests still pass

---

### Task 2: PHI-in-Logs scanner (`src/hipaa/scanners/phi-in-logs.ts`)
**Files:** `src/hipaa/scanners/phi-in-logs.ts`, `src/hipaa/scanners/phi-in-logs.test.ts`
**Tests first:**
- `console.log(patient.ssn)` → CRITICAL finding
- `logger.info({ mrn: record.mrn })` → CRITICAL
- `debug(\`Patient: ${name}\`)` → HIGH
- Multiline log with PHI on next line → caught
- `console.log("server started")` → no finding
- `console.log(count)` → no finding (no PHI field)
- Import of FHIR type (not in log) → no finding
- Test file skipped when configured
**Implementation:**
- Line-range approach: find log call lines, check ±2 lines for PHI fields
- Use PHI field set from phi-patterns.ts
- Skip test files by default
- Regulation: 45 CFR §164.312(b), §164.530(c)
**Verification:** All tests pass

---

### Task 3: SELECT * scanner (`src/hipaa/scanners/select-star.ts`)
**Files:** `src/hipaa/scanners/select-star.ts`, `src/hipaa/scanners/select-star.test.ts`
**Tests first:**
- `SELECT * FROM patients` → HIGH
- `SELECT * FROM encounters WHERE id = ?` → HIGH
- Multiline SQL with SELECT * and FROM on different lines → caught
- `SELECT id, name FROM patients` → no finding (specific columns)
- `SELECT * FROM audit_logs` → no finding (not a PHI table)
- ORM: `Patient.findAll()` → MEDIUM
- ORM: `Patient.findAll({ attributes: ['id'] })` → no finding (projected)
**Implementation:**
- Regex with [\s\S]{0,20} for multiline gap
- PHI table name matching (case-insensitive, expanded list)
- ORM pattern matching for findAll/find/getAll without projection
- Regulation: 45 CFR §164.502(b)
**Verification:** All tests pass

---

### Task 4: HTTP URL scanner (`src/hipaa/scanners/http-phi.ts`)
**Files:** `src/hipaa/scanners/http-phi.ts`, `src/hipaa/scanners/http-phi.test.ts`
**Tests first:**
- `fetch('http://api.internal/patients')` → CRITICAL
- `axios.get('http://ehr.local/fhir/Patient')` → CRITICAL
- `fetch('https://api.internal/patients')` → no finding (HTTPS)
- `http://localhost:3000/api` → no finding (allowlisted)
- `http://127.0.0.1:8080` → no finding (allowlisted)
- HTTP URL in test file → no finding when test files skipped
- `http://example.com` in a comment/string not in fetch/axios → no finding
**Implementation:**
- Match http:// URLs in fetch/axios/request contexts
- Allowlist: localhost, 127.0.0.1, 0.0.0.0, [::1]
- Only flag in PHI-relevant files or files with API calls
- Regulation: 45 CFR §164.312(e)
**Verification:** All tests pass

---

### Task 5: FHIR rules scanner (`src/hipaa/scanners/fhir-rules.ts`)
**Files:** `src/hipaa/scanners/fhir-rules.ts`, `src/hipaa/scanners/fhir-rules.test.ts`
**Tests first:**
- `/Patient?name=Smith` without _elements → HIGH
- `/Patient?name=Smith&_elements=id,name` → no finding
- `scope: 'user/*.*'` → HIGH
- `scope: 'patient/*.read'` → no finding (properly scoped)
- `$export` without _type → HIGH
- `$export?_type=Patient` → no finding
- `/DiagnosticReport?` without _elements → HIGH
- URL in route definition (not API call) → handle carefully
**Implementation:**
- FHIR search: check for resource query without _elements within ±3 lines
- SMART scopes: flag user/*.* and user/*.read, allow patient/*
- Bulk Data: flag $export without _type restriction
- Expanded resource list per review
- Regulation: 45 CFR §164.502(b), §164.312(a)
**Verification:** All tests pass

---

### Task 6: HL7v2 scanner (`src/hipaa/scanners/hl7-phi.ts`)
**Files:** `src/hipaa/scanners/hl7-phi.ts`, `src/hipaa/scanners/hl7-phi.test.ts`
**Tests first:**
- `console.log(hl7Message)` → CRITICAL
- `logger.info(pid.toString())` → HIGH
- `console.log(msh.sendingApp)` → MEDIUM (MSH alone)
- Raw `MSH|^~\&|` in log context → CRITICAL
- Raw `PID|1||MRN123` in code → HIGH
- HL7 parsed but not logged → no finding
- IN1, DG1, GT1 segments logged → HIGH
**Implementation:**
- HL7 variable names in log calls (same line-range as phi-in-logs)
- Raw HL7 pipe-delimited patterns (MSH|, PID|, IN1|, DG1|, GT1|, NK1|)
- Regulation: 45 CFR §164.312(b), §164.530(c)
**Verification:** All tests pass

---

### Task 7: Scanner orchestrator + merge (`src/hipaa/scanners/index.ts`)
**Files:** `src/hipaa/scanners/index.ts`, `src/hipaa/scanners/index.test.ts`
**Tests first:**
- All scanners run when enabled
- Disabled scanner (via config) skipped
- Results merged into flat AgentFinding array
- Deterministic findings have correct fields (scannerId, regulation, deterministic: true)
- Empty input → empty results
**Implementation:**
- `runDeterministicScan(files: Map<string, string>, config?: HipaaConfig): AgentFinding[]`
- Instantiate all 5 scanners, filter by config, run each, flatten results
- Set confidenceScore: 100 on all deterministic findings
**Verification:** All tests pass

---

### Task 8: Wire into scan pipeline
**Files:** `src/scan/orchestrator.ts`
**Intent:** Run deterministic scanners during codebase scan, merge with LLM findings.
**Implementation:**
- After LLM chunk dispatch, before dedup
- Read file contents for all discovered files (already available via reader)
- Run `runDeterministicScan(fileContents, hipaaConfig)`
- Merge deterministic findings with LLM findings
- Dedup: existing proximity logic handles merge
- Deterministic findings skip validation (confidence 100)
**Verification:** Scan integration test, existing scan tests pass

---

### Task 9: Wire into PR review pipeline
**Files:** `src/cli/index.ts`, `src/github/client.ts`
**Intent:** Run deterministic scanners on PR changed files.
**Implementation:**
- When HIPAA lens active, fetch full file content for each changed file
- GitHubClient already has getFileContent — use it to get file contents from PR head
- Run scanners on the file contents map
- Merge findings with LLM review findings
**Verification:** TSC clean, existing tests pass

---

### Task 10: Scanner config in .agentreview.yml
**Files:** `src/config/repo-config.ts`
**Intent:** Allow enabling/disabling individual scanners.
**Implementation:**
- Add `scanners?: Record<string, boolean>` to HipaaConfig
- Default: all true
- Parsed from YAML hipaa.scanners section
**Verification:** Config tests pass

---

### Task 11: HIPAA test fixture + integration test
**Files:** `test/fixtures/hipaa-app/`, `src/hipaa/scanners/integration.test.ts`
**Intent:** Healthcare-specific test fixture + end-to-end scanner test.
**Content:**
- `src/services/patient.ts`: PHI in logs, SELECT *, HTTP URL
- `src/fhir/search.ts`: FHIR search without _elements, broad SMART scope, $export
- `src/hl7/parser.ts`: HL7 message logging, raw PID segment
**Tests:**
- Run all scanners on fixture → gets findings from each scanner
- Correct regulation citations
- Deterministic: true on all findings
**Verification:** Integration test passes

---

### Task 12: README + CHANGELOG + build verification
**Files:** README.md, CHANGELOG.md
**Implementation:**
- Add "Deterministic HIPAA Scanners" section to README
- Document scanner config
- CHANGELOG entry
- Full test suite pass
- TSC clean
- Build clean
**Verification:** All green

---

## Execution Order

- **Group 1:** Task 1 (types — no deps)
- **Group 2:** Tasks 2, 3, 4, 5, 6 (individual scanners — depend only on types, can parallel)
- **Group 3:** Tasks 7, 10 (orchestrator + config — depend on scanners)
- **Group 4:** Tasks 8, 9 (pipeline integration — depend on orchestrator)
- **Group 5:** Tasks 11, 12 (fixtures + docs + verification)

Estimated time: 2-3 hours with parallel execution.
