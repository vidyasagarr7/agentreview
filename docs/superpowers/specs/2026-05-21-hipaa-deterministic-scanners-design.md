# Design Spec: HIPAA Deterministic Scanners

**Date:** 2026-05-21
**Author:** Vex
**Status:** REVISED — incorporates design review findings

---

## 1. Problem Statement

The current HIPAA lens is entirely LLM-driven. It asks the model to spot issues, but the model can miss obvious patterns buried in large chunks. Healthcare companies need deterministic, 100%-reliable detection for critical HIPAA violations — then the LLM adds contextual analysis on top.

**Goal:** Add a deterministic scanning layer that catches HIPAA violations through pattern matching, regex, and AST-level analysis — independent of the LLM. These findings get merged with LLM findings for a combined report.

---

## 2. What We're Building (5 Scanners)

### Scanner 1: PHI-in-Logs Detector
Catches PHI field names inside logging/console calls.
```
console.log(patient.ssn)         → CRITICAL: PHI logged
logger.info({ mrn: record.mrn }) → CRITICAL: PHI logged  
debug(`Patient: ${name}`)        → HIGH: PHI in template literal log
```

### Scanner 2: SELECT * on PHI Tables
Catches broad queries on healthcare tables.
```
SELECT * FROM patients           → HIGH: Minimum Necessary violation
db.query(`SELECT * FROM encounters`) → HIGH
Patient.findAll()                → MEDIUM: ORM returns all columns
```

### Scanner 3: HTTP URL Detector
Catches unencrypted endpoints in PHI-handling code.
```
fetch('http://api.internal/patients') → CRITICAL: PHI over HTTP
axios.get('http://ehr.local/fhir')    → CRITICAL: Unencrypted FHIR
```

### Scanner 4: FHIR-Specific Rules
Catches FHIR API misuse.
```
/Patient?_count=1000              → HIGH: Unbounded FHIR search (no _elements)
BulkDataClient.export('*')       → HIGH: Overly broad Bulk export
scope: 'user/*.read'             → MEDIUM: SMART scope too broad (vs patient/*.read)
```

### Scanner 5: HL7v2 PHI Detection
Catches PHI exposure in HL7 message handling.
```
console.log(hl7Message)          → CRITICAL: Full HL7 message logged (contains PID)
logger.info(msh.toString())      → HIGH: MSH segment may contain PHI
```

---

## 3. Architecture

### 3.1 New Module: `src/hipaa/scanners/`

```
src/hipaa/scanners/
  index.ts              # Public API: runDeterministicScan()
  types.ts              # Scanner types
  phi-in-logs.ts        # Scanner 1: PHI field names in log calls
  select-star.ts        # Scanner 2: SELECT * on PHI tables
  http-phi.ts           # Scanner 3: HTTP URLs in PHI-handling files
  fhir-rules.ts         # Scanner 4: FHIR _elements, Bulk Data, SMART scopes
  hl7-phi.ts            # Scanner 5: HL7v2 message PHI exposure
```

### 3.2 Scanner Interface

```typescript
// DeterministicFinding extends AgentFinding with extra fields (per review: use option 1 — extend AgentFinding)
// Add optional fields to AgentFinding in types/index.ts:
//   scannerId?: string
//   regulation?: string
//   deterministic?: boolean

interface DeterministicFinding extends AgentFinding {
  scannerId: string;          // e.g., 'phi-in-logs'
  regulation: string;         // e.g., '45 CFR §164.312(b)'
  deterministic: true;        // marks as non-LLM finding, never filtered by validation
}

interface Scanner {
  id: string;
  name: string;
  scan(files: Map<string, string>): DeterministicFinding[];
  // files = Map<filePath, fileContent>
}
```

Each scanner receives file contents and returns findings. No LLM calls — pure regex/pattern matching.

### 3.3 Integration

```
Scan Pipeline (existing)
  │
  ├── LLM-based review (existing HIPAA lens)
  │     ↓
  │   LLM findings
  │
  ├── Deterministic scanners (NEW)
  │     ↓
  │   Deterministic findings (regex/pattern)
  │
  └── Merge + Dedup
        ↓
      Combined findings (deterministic are marked, higher confidence)
```

Deterministic findings merge with LLM findings using existing `dedupScanFindings` location-proximity logic. When both find the same issue (same file, parsed line ± 5 from location string `file.ts:42`), the deterministic finding takes precedence (confidence: 100). This means:
- Deterministic findings are NEVER filtered by validation
- They appear first in the report
- They're tagged with the specific HIPAA regulation

### 3.4 When Scanners Run

- **PR review with `--lenses hipaa`**: scanners run on changed files
- **Codebase scan**: scanners run on all discovered files
- **Always**: scanners run when HIPAA lens/config is active. No extra flag needed.

---

## 4. Detailed Scanner Designs

### Scanner 1: PHI-in-Logs (`phi-in-logs.ts`)

**Pattern matching strategy:**
1. Find all log call sites: `console.log`, `console.error`, `console.warn`, `console.info`, `console.debug`, `logger.info`, `logger.warn`, `logger.error`, `logger.debug`, `log.info`, `log.error`, `log.debug`, `debug(`, `trace(`
2. Within each log call's arguments, check for PHI field names from `phi-patterns.ts`
3. Also check template literals in log calls for PHI interpolation

**Regex approach (revised per review — line-range instead of paren parsing):**

Instead of trying to parse JS with regex (nested parens break), use a **line-range approach:**
1. Find lines containing log calls (`console.log`, `logger.info`, etc.)
2. Scan that line + ±2 lines for PHI field names
3. This is simpler and catches multiline log statements

```typescript
// Step 1: Find log call lines
const LOG_LINE = /(?:console|logger|log)\.[a-z]+\s*\(/i;
// Step 2: Check line + neighbors for PHI fields
// Uses PHI field set from phi-patterns.ts
```

**False positive mitigation (per review):**
- Only runs on files matching `phiSources` config patterns, OR files importing healthcare modules
- Skips test files by default (`*.test.ts`, `*.spec.ts`, `__tests__/`)

**Severity:**
- CRITICAL: Direct PHI field in log call (`console.log(patient.ssn)`)
- HIGH: PHI in template literal log
- MEDIUM: PHI variable name in log (might be sanitized — uncertain)

### Scanner 2: SELECT * (`select-star.ts`)

**Pattern matching:**
```typescript
const SELECT_STAR = /SELECT[\s\S]{0,20}\*[\s\S]{0,20}FROM\s+(\w+)/gi;  // handles multiline SQL
// Match table names against PHI tables
const PHI_TABLES = ['patient', 'patients', 'encounter', 'encounters', 'diagnosis', 'medication', 'observation', 'condition', 'allergy', 'immunization', 'procedure', 'claim', 'claims', 'claim_line', 'coverage', 'person', 'member', 'explanation_of_benefits', 'consent', 'care_team', 'practitioner'];

// ORM patterns
const ORM_FIND_ALL = /(?:Patient|Encounter|Observation|Condition|Medication)\.(findAll|find|getAll|list|query)\s*\(/g;
```

**Severity:**
- HIGH: `SELECT * FROM patients` — clear Minimum Necessary violation
- MEDIUM: ORM findAll on PHI model (might use select/projection — uncertain)

### Scanner 3: HTTP PHI (`http-phi.ts`)

**Pattern matching:**
```typescript
const HTTP_URL = /['"`](http:\/\/[^'"`\s]+)['"`]/g;
// Only flag in files classified as PHI-related by phi-sources or domain
```

**Only runs on files in PHI-relevant paths** (src/services/patient*, src/fhir/*, etc. from config). Otherwise too many false positives.

**Allowlist (per review):** Skip `http://localhost`, `http://127.0.0.1`, `http://0.0.0.0`, and URLs in test files.

**Severity:**
- CRITICAL: HTTP URL in PHI-handling file
- HIGH: HTTP URL in any API/route file

### Scanner 4: FHIR Rules (`fhir-rules.ts`)

**Patterns:**
```typescript
// Missing _elements in FHIR search (expanded per review)
const FHIR_SEARCH = /\/(?:Patient|Observation|Condition|Encounter|MedicationRequest|AllergyIntolerance|DiagnosticReport|Immunization|Claim|ExplanationOfBenefit)\?/g;
// Flag if same line/nearby doesn't contain _elements=

// Overly broad SMART scopes
const BROAD_SCOPE = /scope['":\s]+.*user\/\*\.\*/g;  // user/*.* is admin-level
const BROAD_READ = /scope['":\s]+.*user\/\*\.read/g;  // user/*.read is too broad vs patient/*.read

// Bulk Data without type restrictions
const BULK_EXPORT = /\$export/g;  // Flag if no _type parameter nearby

// Missing FHIR security in CapabilityStatement
const CAPABILITY = /CapabilityStatement/g;  // Check for security block
```

**Severity:**
- HIGH: FHIR search without _elements on sensitive resources
- HIGH: user/*.* SMART scope
- MEDIUM: user/*.read (should be patient-scoped where possible)
- HIGH: Bulk $export without _type restriction

### Scanner 5: HL7v2 PHI (`hl7-phi.ts`)

**Patterns:**
```typescript
// Full HL7 message in logs
const HL7_LOG = /(?:console|logger|log)\.\w+\s*\(.*(?:hl7|adt|oru|adt_a01|message|segment|msh|pid|nk1|pv1)/gi;

// Raw HL7 pipe-delimited message in string
const HL7_RAW = /MSH\|[^|]*\|/g;  // Actual HL7 message content
// If found in log/console context → CRITICAL

// Additional HL7 segments with PHI (per review)
// IN1/IN2 (Insurance), DG1 (Diagnosis), GT1 (Guarantor)
const HL7_PHI_SEGMENTS = /(?:PID|NK1|IN1|IN2|DG1|GT1)\|/g;
```

**Severity:**
- CRITICAL: HL7 message logged (PID segment contains full patient demographics)
- HIGH: Individual HL7 segment in log (MSH, PID, NK1)
- MEDIUM: HL7 segment parsed but not sanitized before storage

---

## 5. Testing Strategy

Each scanner gets its own test file with:
- True positive: known-bad patterns are caught
- True negative: safe patterns are NOT flagged
- Edge cases: minified code, multiline, template literals
- PHI table name matching (case-insensitive, singular/plural)

Integration test: run all scanners on test/fixtures/vulnerable-app + a new HIPAA fixture.

---

## 6. New Test Fixture

`test/fixtures/hipaa-app/` — healthcare-specific vulnerable app:
- `src/services/patient.ts`: PHI in logs, SELECT *, HTTP endpoint
- `src/fhir/search.ts`: FHIR search without _elements, broad SMART scope
- `src/hl7/parser.ts`: HL7 message logging
- `src/config/db.ts`: unencrypted connection

---

## 7. Scanner Configuration

Allow disabling individual scanners via `.agentreview.yml`:
```yaml
hipaa:
  scanners:
    phi-in-logs: true
    select-star: true
    http-phi: false       # disable if too noisy
    fhir-rules: true
    hl7-phi: true
```

All scanners enabled by default. Patterns must avoid catastrophic backtracking (no nested quantifiers).

---

## 8. Integration Points

**PR review:** Fetch full file content for changed files from PR head (not just diffs). Pass to scanners.

**Scan:** Hook between chunk LLM dispatch and dedup:
```
chunks → LLM dispatch → [deterministic scan] → merge → dedup → baseline → result
```

**Action:** Deterministic findings appear in inline annotations with regulation citations.

---

## 9. Success Criteria

1. Each scanner has >90% true positive rate on test fixtures
2. False positive rate <20% on real codebases
3. Deterministic findings are clearly marked in reports
4. All 5 scanners run in <2 seconds for a 500-file codebase
5. HIPAA regulation citations on every deterministic finding
6. 551+ existing tests still pass
