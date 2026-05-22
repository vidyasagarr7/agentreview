# Design Spec: Cross-File PHI Data Flow Analysis

**Date:** 2026-05-22
**Author:** Vex
**Status:** REVIEWED — incorporating findings from Claude (security) + Gemini (healthcare)

---

## 1. Problem Statement

AgentReview reviews files in isolated chunks. It cannot trace PHI flowing across files:
```
patientService.ts → logMiddleware.ts → elasticClient.ts
                         ↑ PHI leaks here but tool can't see the connection
```

This is the #1 accuracy gap — we missed IDOR on NodeGoat (86% recall → should be >95%).

**Goal:** Trace PHI data flow across files using a full-repo import graph, runtime flow detection, and multi-pass LLM analysis.

---

## 2. How It Works

### Pass 1: Source/Sink Identification (per-file, parallel)
For each file, identify:
- **PHI Sources** — functions/methods that return PHI (see §2.1 expanded taxonomy)
- **PHI Sinks** — places PHI could leak (see §2.1 expanded taxonomy)
- **PHI Transforms** — functions that receive PHI and pass it along (middleware, transforms, mappers, event handlers)

Output per file:
```typescript
interface FilePhiProfile {
  path: string;
  sources: Array<{ name: string; line: number; type: PhiSourceType }>;
  sinks: Array<{ name: string; line: number; type: PhiSinkType }>;
  transforms: Array<{
    name: string;
    line: number;
    inputParam: string;
    outputReturn: boolean;
    mechanism: 'direct' | 'event-emit' | 'middleware-next' | 'queue-publish' | 'callback';
  }>;
  exports: Array<{ name: string; containsPhi: boolean }>;
  imports: Array<{ from: string; names: string[] }>;
  runtimeFlows: Array<RuntimeFlowDescriptor>;  // §2.3
}
```

This pass uses a **healthcare-aware LLM prompt** with a preamble covering FHIR client patterns, HL7 libraries, and common healthcare middleware (see §4.1).

**Schema validation:** Output is validated with Zod. On parse failure, retry once with the validation error appended to the prompt (see §4.5).

### Pass 2: Flow Graph Construction (deterministic)
Using the **full-repo import graph** (bidirectional — see §3.1) + Pass 1 profiles + runtime flow edges (§2.3):

1. Build a directed graph: `source → transform → ... → sink`
2. Follow imports (forward) and reverse edges (backward for taint propagation)
3. Include runtime flow edges: event emitters → listeners, middleware chains, queue publish → subscribe
4. Trace through transforms: if file C imports from file A and passes data to a log call, that's a PHI leak

This step is pure computation — no LLM needed.

### Pass 3: Leak Verification (targeted LLM)
For each identified potential leak path, send the specific source file + sink file to the LLM with context. The verifier also queries the **BAA registry** (§4.3) to assess whether external sinks are covered by a Business Associate Agreement.

"PHI from `getPatient()` in patient-service.ts flows to `logger.info()` in request-logger.ts via the import chain. Is this a real PHI leak or is the data sanitized along the way?"

This is a targeted, high-confidence prompt — not a broad "find issues" prompt.

---

## 2.1 Expanded Source and Sink Taxonomy

### PHI Source Types

```typescript
type PhiSourceType =
  // Database
  | 'db-query'          // Direct SQL/ORM queries on patient tables
  | 'db-stored-proc'    // Stored procedure calls returning PHI
  // FHIR (granular)
  | 'fhir-read'         // FHIR resource read (GET /Patient/123)
  | 'fhir-search'       // FHIR search (GET /Patient?name=...)
  | 'fhir-bulk'         // FHIR Bulk Data Export ($export)
  // CDA / HL7
  | 'cda'               // CDA document parsing/generation
  | 'hl7-v2'            // HL7 v2.x message parsing (ADT, ORM, ORU, etc.)
  // CDS Hooks
  | 'cds-hook'          // CDS Hooks request/response (prefetch data contains PHI)
  // Other
  | 'api-response'      // Upstream API returning PHI
  | 'function-param'    // PHI passed as function parameter
  | 'file-read'         // Reading PHI from file (CSV, JSON, etc.)
  | 'env-config';       // PHI from environment/config (rare but possible)
```

### PHI Sink Types

```typescript
type PhiSinkType =
  // Logging & monitoring
  | 'log'               // console.log, logger.info, winston, bunyan, etc.
  | 'error-tracking'    // Sentry, Bugsnag, Rollbar error capture
  | 'apm'               // Application performance monitoring (New Relic, Datadog traces)
  // HTTP/API
  | 'response'          // HTTP response body (API responses, SSR HTML)
  | 'external-api'      // Outbound API call to third-party service
  | 'webhook'           // Outbound webhook call
  // Storage
  | 'cache'             // Redis, Memcached, in-memory cache
  | 'storage'           // S3, GCS, Azure Blob — file storage without BAA check
  | 'search-index'      // Elasticsearch, Algolia, Typesense
  | 'analytics'         // Analytics SDKs (Mixpanel, Segment, GA)
  // Messaging
  | 'queue'             // Message queue publish (Kafka, SQS, RabbitMQ)
  | 'notification'      // Email, SMS, push notification (Twilio, SendGrid, SNS)
  // Document generation
  | 'document-gen'      // PDF generation, report rendering, export files
  | 'template-render';  // Server-side template rendering with PHI
```

---

## 2.2 Known Safe Patterns (False Positive Reduction)

To reduce false positives, a configurable set of **known safe patterns** can suppress findings:

```yaml
# .agentreview.yml
hipaa:
  flow-safe-patterns:
    - pattern: "redact(.*)"           # Known redaction function
      type: "sanitizer"
    - pattern: "maskPhi(.*)"
      type: "sanitizer"
    - pattern: "toPublicProfile(.*)"  # Known safe projection
      type: "projection"
    - pattern: "audit\.log(.*)"       # Audit logging is expected to contain PHI
      type: "expected-sink"
    - pattern: "hipaaLogger\.(.*)"    # HIPAA-compliant logger
      type: "compliant-sink"
```

When a flow path passes through a function matching a `sanitizer` pattern, confidence is downgraded. When a sink matches an `expected-sink` or `compliant-sink` pattern, the finding is suppressed or marked INFO.

---

## 2.3 Runtime Flow Detection (Async Patterns)

Static import analysis misses PHI that flows through runtime mechanisms. The profiler identifies these patterns per-file:

```typescript
interface RuntimeFlowDescriptor {
  type: 'event-emit' | 'event-listen' | 'middleware-chain' | 'queue-publish' | 'queue-subscribe';
  channel: string;        // Event name, queue/topic name, middleware mount path
  functionName: string;   // Function containing the pattern
  line: number;
  dataParam?: string;     // Parameter or argument carrying the data
}
```

### Detected patterns:

| Pattern | Detection | Example |
|---------|-----------|---------|
| **Event emitters** | `emit('eventName', data)` / `on('eventName', handler)` | `eventBus.emit('patient-updated', record)` |
| **Middleware chains** | `app.use()` / `router.use()` / `next(data)` | `app.use('/api/patient', authMiddleware, patientHandler)` |
| **Queue publish/subscribe** | `producer.send()` / `consumer.subscribe()` patterns | `kafka.send({ topic: 'phi-events', messages })` |
| **Redis pub/sub** | `redis.publish()` / `redis.subscribe()` | `redis.publish('patient-channel', JSON.stringify(record))` |
| **Callback chains** | `callback(err, phiData)` patterns | `getPatient(id, (err, patient) => { ... })` |

The Pass 2 graph builder matches `event-emit` descriptors with `event-listen` descriptors by channel name, creating additional edges in the flow graph. Same for queue publish/subscribe pairs.

**Scope note:** Kafka, SQS, Redis pub/sub, and similar message queue patterns are traceable within a single repository when the publisher and subscriber code coexist. Cross-repo flows (e.g., producer service → consumer service in different repos) are out of scope for v1 but flagged as "incomplete trace" in findings.

---

## 3. Architecture

### New Module: `src/hipaa/flow/`

```
src/hipaa/flow/
  index.ts              # Public API: analyzePhiFlow()
  types.ts              # Flow analysis types (source/sink taxonomy, runtime flows)
  profiler.ts           # Pass 1: per-file PHI profiling (with healthcare preamble)
  graph.ts              # Pass 2: flow graph construction (import + runtime edges)
  verifier.ts           # Pass 3: leak verification (with BAA registry integration)
  prompts.ts            # LLM prompts for Pass 1 + Pass 3
  runtime-detector.ts   # Runtime flow pattern detection (events, middleware, queues)
  import-graph-full.ts  # Full-repo import graph builder (bidirectional)
  schema.ts             # Zod schemas for LLM output validation
  safe-patterns.ts      # Known safe pattern matching
```

### 3.1 Full-Repo Import Graph (Bidirectional)

The existing `buildImportGraph()` in `src/codebase/import-graph.ts` is **PR-scoped** — it only builds edges for changed files. For flow analysis, we need a **full-repo graph**.

`import-graph-full.ts` builds:
- **Forward edges (`importsOut`):** File A imports symbol X from file B (existing behavior, extended to all files)
- **Reverse edges (`importsIn`):** File B is imported by files A, C, D (new — enables backward taint tracing)

```typescript
interface FullImportGraph {
  importsOut: Map<string, ImportEdge[]>;   // file → what it imports
  importsIn: Map<string, ImportEdge[]>;    // file → what imports it (reverse)
  filesAnalyzed: number;
  filesFailed: number;
  diagnostics: CodebaseContextDiagnostic[];
}

async function buildFullImportGraph(
  allFiles: string[],
  tree: RepoTree,
  fetcher: CodebaseFetcher,
): Promise<FullImportGraph>
```

**For PR review mode:** The full graph is not rebuilt — we use the existing PR-scoped graph and extend it with 1-hop neighbors from the changed files. This keeps PR reviews fast.

**For scan mode:** Full graph is built from all discovered TS/JS files.

### 3.2 Language Limitations

The import graph builder and runtime flow detector operate on **TypeScript and JavaScript only** (AST-based regex parsing). For codebases with non-TS/JS files that handle PHI:

- Python, Java, C#, Go files are profiled via the **LLM-based Pass 1** (the profiler prompt works for any language)
- Import relationships for non-TS/JS files are inferred by the LLM profiler from `import`/`require`/`from`/`include` statements in the file content
- Runtime flow detection for non-TS/JS files relies on LLM identification of patterns (less precise than regex)
- This limitation is documented and logged as a diagnostic

---

## 3.3 Integration

```
Scan Pipeline (scanCodebase)
  │
  ├── Existing: chunk-based LLM review
  ├── Existing: deterministic scanners
  │
  └── NEW: Cross-file PHI flow analysis
        ├── Build full import graph (all TS/JS files)
        ├── Pass 1: profile each file (parallel, lightweight LLM)
        │     └── Validated with Zod, retry on failure
        ├── Runtime flow detection (event/middleware/queue edges)
        ├── Pass 2: build flow graph (import graph + runtime edges)
        │     └── Path prioritization + file cap applied
        ├── Pass 3: verify leaks (targeted LLM + BAA registry)
        │     └── Known safe patterns filter applied
        └── Findings merged + deduped against deterministic scanners
```

**Integration point in `scanCodebase()`:** After deterministic scanners run (line ~220 of orchestrator.ts), the flow analysis is invoked. Findings are appended to `chunkResults` as a synthetic chunk (similar to deterministic scanners). The existing dedup logic in `dedupScanFindings()` handles overlap.

**PR review integration:** `analyzePhiFlow()` is also callable from the PR review pipeline with a `mode: 'pr'` option that uses the PR-scoped import graph + 1-hop extension instead of the full-repo graph.

---

## 4. Detailed Design

### 4.1 Pass 1 Profiler (`profiler.ts`)

LLM prompt per file with **healthcare-specific preamble**:

```
# Healthcare PHI Data Flow Profiler

You are analyzing source code in a healthcare application for Protected Health Information (PHI) data flows.

## Healthcare Context
Be aware of these common patterns in healthcare codebases:
- **FHIR clients:** Libraries like `fhir.js`, `@asymmetrik/node-fhir-server-core`, `fhirclient`, `@medplum/core` — any FHIR resource read/search/bulk export is a PHI source
- **HL7 libraries:** `hl7`, `node-hl7-complete`, `simple-hl7` — message parsing produces PHI
- **CDA parsers:** `blue-button`, `cda-parser` — CDA document parsing produces PHI
- **CDS Hooks:** `cds-hooks-*` — prefetch data in CDS requests contains PHI
- **PHI fields:** patient name, DOB, SSN, MRN, address, phone, email, diagnosis, medications, lab results, insurance info (18 HIPAA identifiers)
- **Middleware patterns:** Express/Koa middleware that accesses `req.body`, `req.params`, `req.query` in patient-related routes
- **Transform patterns:** Functions that map between internal and external representations (e.g., `toFhirResource()`, `mapPatientToDto()`, `serializeBundle()`)

## Task
Analyze this file for PHI data handling. Return ONLY valid JSON matching this schema:
{
  "sources": [{"name": "functionName", "line": 42, "type": "<source_type>"}],
  "sinks": [{"name": "functionName", "line": 55, "type": "<sink_type>"}],
  "transforms": [{"name": "fn", "line": 30, "inputParam": "patientData", "outputReturn": true, "mechanism": "direct|event-emit|middleware-next|queue-publish|callback"}],
  "exports": [{"name": "getPatient", "containsPhi": true}],
  "runtimeFlows": [{"type": "event-emit|event-listen|middleware-chain|queue-publish|queue-subscribe", "channel": "event-or-topic-name", "functionName": "fn", "line": 10, "dataParam": "optionalParamName"}]
}

Source types: db-query, db-stored-proc, fhir-read, fhir-search, fhir-bulk, cda, hl7-v2, cds-hook, api-response, function-param, file-read, env-config
Sink types: log, error-tracking, apm, response, external-api, webhook, cache, storage, search-index, analytics, queue, notification, document-gen, template-render

If the file doesn't handle PHI at all, return: {"sources":[],"sinks":[],"transforms":[],"exports":[],"runtimeFlows":[]}
```

**Optimization:** Only profile files classified as PHI-relevant (P0-P2 priority from discovery.ts) or files that import from PHI-relevant files. Skip test files, config files, static assets.

**Concurrency:** Profile files in parallel (p-limit, concurrency 5). Each profile is a small LLM call (~1.5K tokens input, ~300 tokens output).

**File cap (`flow-max-files`):** Maximum number of files to profile per scan. Default 100. If exceeded, files are prioritized by: (1) files with known PHI source imports, (2) files in `src/` vs `lib/`, (3) file size descending. This prevents token budget blowout on large codebases.

### 4.2 Flow Graph (`graph.ts`)

Pure TypeScript, no LLM:

```typescript
interface PhiFlowEdge {
  from: { file: string; export: string; line: number };
  to: { file: string; import: string; line: number };
  type: 'import' | 'event' | 'middleware' | 'queue' | 'callback';
}

interface PhiFlowPath {
  source: { file: string; name: string; line: number; type: PhiSourceType };
  intermediates: Array<{ file: string; name: string; line: number; mechanism: string }>;
  sink: { file: string; name: string; line: number; type: PhiSinkType };
  confidence: 'high' | 'medium' | 'low';
  severity: FindingSeverity;  // Mapped from confidence + sink type
}

function buildPhiFlowGraph(
  profiles: Map<string, FilePhiProfile>,
  importGraph: FullImportGraph,
  runtimeFlows: RuntimeFlowEdge[],
): PhiFlowPath[]
```

Algorithm:
1. For each file with PHI sources, trace exports through import graph (forward edges)
2. Use reverse edges (`importsIn`) for backward taint tracking: "which files consume this export?"
3. At each hop, check if the importing file has transforms that handle the imported function's output
4. Match runtime flow edges: event-emit → event-listen, queue-publish → queue-subscribe by channel name
5. Continue following the chain until reaching a sink or dead end (max depth = `flow-max-depth`)
6. Mark paths: source → sink without sanitization = high confidence leak

**Path prioritization heuristic:** When the number of candidate paths exceeds `flow-max-paths`, paths are ranked by:
1. **Sink type severity:** `log` > `external-api` > `analytics` > `cache` (high-risk sinks first)
2. **Path length:** Shorter paths are more likely true positives
3. **Source type specificity:** `fhir-read` > `db-query` > `function-param` (more specific = higher priority)

**Confidence-to-severity mapping:**

| Confidence | Default Severity | Override Conditions |
|-----------|-----------------|-------------------|
| `high` | `HIGH` | → `CRITICAL` if sink is `external-api` without BAA |
| `medium` | `MEDIUM` | → `HIGH` if source is `fhir-bulk` or `hl7-v2` |
| `low` | `LOW` | → `INFO` if sink matches known safe pattern |

### 4.3 Leak Verifier (`verifier.ts`)

For each high/medium confidence path, send targeted LLM verification. The verifier also integrates with the **BAA registry** (`src/hipaa/baa-registry.ts`):

```
PHI Data Flow Detected:
Source: getPatient() in src/services/patient.ts:42 (type: fhir-read — FHIR Patient resource read)
  → imported by src/middleware/logger.ts:5
  → used in logRequest() at line 18
  → calls console.log(req.body) at line 22

Sink: console.log in src/middleware/logger.ts:22 (type: log)

BAA Status: [N/A — sink is local logging, no external service involved]
  OR: [WARNING — sink calls api.sentry.io which has NO signed BAA]
  OR: [OK — sink calls *.amazonaws.com which has BAA coverage]

Question: Is patient PHI actually exposed at the sink, or is it sanitized/filtered before reaching it? Consider:
1. Is the data transformed/filtered between source and sink?
2. Are only non-PHI fields used at the sink?
3. Is there any redaction/masking applied?
4. Does a known safe pattern apply?

Return JSON: {"isLeak": true/false, "confidence": "high/medium/low", "explanation": "...", "baaRelevant": true/false}
```

**BAA registry integration:** When a sink's type is `external-api`, `webhook`, `storage`, `analytics`, `error-tracking`, or `notification`, the verifier extracts the target domain/URL and checks it against the BAA registry. If the target has no BAA, severity is escalated. If the target has a BAA, the finding is contextualized (still reported but with BAA status noted).

### 4.4 Token Budget

- Pass 1: ~1.5K tokens per file × 100 files (capped) = ~150K tokens
- Pass 2: 0 tokens (deterministic)
- Pass 3: ~2K tokens per suspicious path × ~20 paths = ~40K tokens

Total: ~190K tokens per scan (~$0.30-0.60 depending on model). For large codebases with the file cap, this stays bounded.

**File cap rationale:** Without a cap, a 500-file codebase would cost ~750K tokens for Pass 1 alone. The `flow-max-files` config (default: 100) keeps costs predictable. Files are prioritized by PHI relevance.

### 4.5 JSON Schema Validation

All LLM outputs (Pass 1 profiles, Pass 3 verifications) are validated against **Zod schemas** before processing:

```typescript
// schema.ts
const FilePhiProfileSchema = z.object({
  sources: z.array(z.object({
    name: z.string(),
    line: z.number(),
    type: z.enum(['db-query', 'db-stored-proc', 'fhir-read', ...]),
  })),
  sinks: z.array(z.object({ /* ... */ })),
  transforms: z.array(z.object({ /* ... */ })),
  exports: z.array(z.object({ /* ... */ })),
  runtimeFlows: z.array(z.object({ /* ... */ })),
});
```

**Retry strategy:** On Zod validation failure, the LLM is re-prompted once with the validation error appended:
```
Your previous response had validation errors:
- sources[0].type: Invalid enum value. Expected 'db-query' | 'fhir-read' | ..., received 'database'

Please fix and return valid JSON.
```

If the retry also fails, the file is skipped and a diagnostic is logged.

---

## 5. Configuration

```yaml
# .agentreview.yml
hipaa:
  flow-analysis: true           # Enable cross-file PHI flow (default: true when hipaa lens active)
  flow-max-depth: 5             # Max import chain depth to follow (default: 5)
  flow-max-paths: 20            # Max suspicious paths to verify (default: 20)
  flow-max-files: 100           # Max files to profile in Pass 1 (default: 100)
  flow-safe-patterns:           # Known safe patterns to suppress FPs
    - pattern: "redact(.*)"
      type: "sanitizer"
    - pattern: "maskPhi(.*)"
      type: "sanitizer"
  baa-covered:                  # Already exists — used by verifier
    - "*.amazonaws.com"
  baa-not-covered:              # Already exists — used by verifier
    - "*.sentry.io"
```

---

## 6. Finding Deduplication Against Deterministic Scanners

Flow analysis findings may overlap with deterministic scanner findings (e.g., both detect `console.log(patient)` in the same file). Deduplication rules:

1. **Same file + same line + same sink type:** Deterministic finding wins (higher confidence, no LLM uncertainty). Flow finding is suppressed.
2. **Same file + different line:** Both findings kept (different code paths).
3. **Cross-file flow + single-file deterministic:** Both kept — the flow finding adds cross-file context that the deterministic finding lacks. The flow finding references the deterministic finding as corroboration.

This uses the existing `dedupScanFindings()` infrastructure with an additional flow-aware comparison.

---

## 7. What This Catches That We Currently Miss

| Vulnerability | Current | With Flow Analysis |
|--------------|---------|-------------------|
| IDOR (accessing other users' data) | ❌ Missed | ✅ Traces data from auth → query → response |
| PHI in logs via middleware | ❌ Missed (cross-file) | ✅ Traces PHI from service → middleware → log |
| PHI to analytics/monitoring | ❌ Missed (cross-file) | ✅ Traces patient data → analytics SDK |
| Missing sanitization in transform | ❌ Missed | ✅ Identifies unsanitized transform chains |
| FHIR data returned without scoping | Partial | ✅ Traces FHIR client → API response |
| PHI via event bus / middleware chain | ❌ Missed | ✅ Runtime flow detection catches async patterns |
| PHI to non-BAA external service | Partial | ✅ BAA registry integration flags uncovered services |
| PHI in Kafka/SQS messages | ❌ Missed | ✅ Queue pub/sub pattern detection (single-repo) |
| CDS Hooks prefetch data leaks | ❌ Missed | ✅ CDS hook source type recognized |

Expected accuracy improvement: recall from 86% → 93-95%.

---

## 8. Testing Strategy

- Unit tests for each module (profiler, graph, verifier, runtime-detector, schema validation)
- Flow graph tests with mock import graphs + profiles
- Runtime flow detection tests (event emitter, middleware, queue patterns)
- BAA registry integration tests in verifier
- Known safe patterns tests
- Zod schema validation + retry tests
- Integration test with hipaa-app fixture (add cross-file PHI flow scenarios)
- Production test on NodeGoat (should now catch IDOR)

---

## 9. Success Criteria

1. Catches IDOR on NodeGoat (currently missed)
2. Catches cross-file PHI-in-logs (service → middleware → log)
3. Catches PHI flowing through event emitters and middleware chains
4. BAA-uncovered external sinks are flagged with escalated severity
5. <30% false positive rate on flow findings (with safe patterns)
6. Total scan time increase <30 seconds (for 100-file codebase with cap)
7. Token cost increase <$0.60 per scan (with file cap)

---

## Appendix A: Review Findings Incorporated

### Claude (Security Review)
1. ✅ Full-repo import graph builder for scan mode (§3.1)
2. ✅ Reverse edges (`importsIn`) for taint tracking (§3.1)
3. ✅ Language limitation documented — LLM fallback for non-TS/JS (§3.2)
4. ✅ Transform mechanism field with examples in profiler prompt (§4.1)
5. ✅ Zod schema validation with retry on parse failure (§4.5)
6. ✅ Confidence-to-severity mapping table (§4.2)
7. ✅ Known safe patterns config for FP reduction (§2.2)
8. ✅ File cap (`flow-max-files`) for token budget control (§4.1, §5)
9. ✅ Path prioritization heuristic by sink type and path length (§4.2)
10. ✅ Integration point in scanCodebase() clarified (§3.3)
11. ✅ Finding dedup against deterministic scanners (§6)

### Gemini (Healthcare Review)
1. ✅ FHIR source types expanded: fhir-read, fhir-search, fhir-bulk, cda, cds-hook (§2.1)
2. ✅ Sink types expanded: storage, notification, document-gen, template-render, error-tracking, apm, analytics, search-index (§2.1)
3. ✅ Async patterns: event emitters, middleware chains, queue pub/sub (§2.3)
4. ✅ Runtime flow detector with channel-based edge matching (§2.3)
5. ✅ Kafka/SQS/Redis flows traceable within single repo (§2.3 scope note)
6. ✅ Token budget with file cap for large codebases (§4.4)
7. ✅ BAA registry wired into Pass 3 verifier (§4.3)
8. ✅ Healthcare-specific preamble in profiler prompt (§4.1)
9. ✅ Polyglot limitation documented with LLM fallback (§3.2)
