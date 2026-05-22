# Implementation Plan: Cross-File PHI Data Flow Analysis

**Date:** 2026-05-22
**Design spec:** [cross-file-phi-analysis-design.md](./2026-05-22-cross-file-phi-analysis-design.md)
**Branch:** `feat/cross-file-phi-analysis`
**Module:** `src/hipaa/flow/`

---

## Overview

11 implementation tasks organized into 5 phases. Tasks within a phase can be parallelized.

**Estimated total effort:** ~3–4 days
**Dependencies:** existing `src/codebase/import-graph.ts`, `src/hipaa/baa-registry.ts`, `src/scan/orchestrator.ts`

---

## Phase 1: Foundation (types, schemas, import graph)

_No inter-task dependencies — all three can be built in parallel._

### Task 1: Flow Types (`src/hipaa/flow/types.ts`)

Define all type interfaces for the flow analysis module.

**Deliverables:**
- `PhiSourceType` union type (13 source types: db-query, db-stored-proc, fhir-read, fhir-search, fhir-bulk, cda, hl7-v2, cds-hook, api-response, function-param, file-read, env-config)
- `PhiSinkType` union type (14 sink types: log, error-tracking, apm, response, external-api, webhook, cache, storage, search-index, analytics, queue, notification, document-gen, template-render)
- `FilePhiProfile` interface (sources, sinks, transforms with mechanism field, exports, imports, runtimeFlows)
- `RuntimeFlowDescriptor` interface (type, channel, functionName, line, dataParam)
- `PhiFlowEdge` interface (from, to, type: import|event|middleware|queue|callback)
- `PhiFlowPath` interface (source, intermediates, sink, confidence, severity)
- `FullImportGraph` interface (importsOut Map, importsIn Map, filesAnalyzed, filesFailed, diagnostics)
- `FlowAnalysisResult` interface (paths, profiles, graph stats, diagnostics)
- `FlowAnalysisOptions` interface (maxDepth, maxPaths, maxFiles, safePatterns, mode: 'scan'|'pr')
- Re-export `FindingSeverity` from main types

**Tests:** Type-only file — no runtime tests needed. Validate with `tsc --noEmit`.

**Estimate:** 1–2 hours

---

### Task 2: Zod Schemas + Validation (`src/hipaa/flow/schema.ts`)

Define Zod schemas for all LLM outputs and a validation-with-retry utility.

**Deliverables:**
- `FilePhiProfileSchema` — Zod schema matching `FilePhiProfile` (with enum validation for source/sink types)
- `VerifierResponseSchema` — Zod schema for Pass 3 output: `{ isLeak: boolean, confidence: string, explanation: string, baaRelevant: boolean }`
- `validateWithRetry(rawJson: string, schema: ZodSchema, retryFn: (error: string) => Promise<string>): Promise<T | null>` — parse JSON, validate against schema, on failure call retryFn with formatted error, validate retry result, return null on second failure
- Helper: `formatZodError(error: ZodError): string` — human-readable error for re-prompting

**Tests (`schema.test.ts`):**
- Valid profile JSON → passes validation
- Invalid source type enum → fails, retry with corrected JSON → passes
- Malformed JSON → fails, retry → passes
- Double failure → returns null
- Edge case: empty arrays (valid)
- Edge case: extra fields (stripped by Zod)

**Estimate:** 2–3 hours

---

### Task 3: Full-Repo Import Graph Builder (`src/hipaa/flow/import-graph-full.ts`)

Extend the existing import graph to support full-repo analysis with reverse edges.

**Deliverables:**
- `buildFullImportGraph(allFiles: string[], tree: RepoTree, fetcher: CodebaseFetcher): Promise<FullImportGraph>` — builds forward + reverse edge maps for all TS/JS files
- `extendPrGraph(prEdges: ImportEdge[], allFiles: string[], tree: RepoTree, fetcher: CodebaseFetcher): Promise<FullImportGraph>` — for PR mode, extends PR-scoped edges with 1-hop neighbors
- Internally reuses `detectLanguage`, `parseImports`, `resolveImport` from `src/codebase/parser.ts` and `src/codebase/resolver.ts`
- Builds `importsIn` map by inverting `importsOut` edges
- Non-TS/JS files are skipped with diagnostic

**Tests (`import-graph-full.test.ts`):**
- Full graph from 5 mock TS files → correct forward + reverse edges
- Reverse edge lookup: "what imports file X?" returns correct files
- PR extension: 3 changed files + 2 neighbor files discovered
- Non-TS file → skipped with diagnostic
- Circular imports → handled (no infinite loop)
- Missing file → diagnostic, not crash

**Estimate:** 3–4 hours

---

## Phase 2: Detectors (profiler, runtime flows, safe patterns)

_Depends on Phase 1 types/schemas. All three tasks in this phase can be parallelized._

### Task 4: Runtime Flow Detector (`src/hipaa/flow/runtime-detector.ts`)

Detect async/runtime PHI flow patterns in source code using regex-based pattern matching.

**Deliverables:**
- `detectRuntimeFlows(filePath: string, source: string): RuntimeFlowDescriptor[]` — scans source for event, middleware, queue, and callback patterns
- Pattern matchers for:
  - **Event emitters:** `\.emit\(` + `\.on\(` / `\.addEventListener\(` / `\.once\(`
  - **Middleware chains:** `app\.use\(` / `router\.(get|post|put|delete|use)\(` / `next\(`
  - **Queue publish:** `\.send\(` / `\.publish\(` / `\.produce\(` / `producer\.send\(`
  - **Queue subscribe:** `\.subscribe\(` / `\.consume\(` / `consumer\.(run|subscribe)\(`
  - **Redis:** `redis\.(publish|subscribe)\(`
- Extract channel/topic name from string literal argument where possible
- Return line numbers from source offset

**Tests (`runtime-detector.test.ts`):**
- EventEmitter emit + on → detected with channel name
- Express middleware chain → detected
- Kafka producer.send + consumer.run → detected with topic
- Redis publish/subscribe → detected
- No patterns in file → empty array
- Nested patterns (emit inside middleware) → both detected
- Dynamic channel names → detected with channel: `<dynamic>`

**Estimate:** 3–4 hours

---

### Task 5: Pass 1 Profiler (`src/hipaa/flow/profiler.ts` + `src/hipaa/flow/prompts.ts`)

LLM-based per-file PHI profiling with healthcare preamble and schema validation.

**Deliverables:**
- `profileFile(filePath: string, source: string, llm: LLMClient): Promise<FilePhiProfile | null>` — sends healthcare-aware prompt, validates response with Zod, retries once on failure
- `profileFiles(files: Array<{path: string, content: string}>, llm: LLMClient, options: { concurrency: number, maxFiles: number }): Promise<Map<string, FilePhiProfile>>` — parallel profiling with p-limit and file cap
- `PROFILER_SYSTEM_PROMPT` in `prompts.ts` — healthcare-specific preamble (FHIR clients, HL7 libs, CDA parsers, CDS hooks, 18 HIPAA identifiers)
- `PROFILER_USER_PROMPT(source: string)` — file content + JSON schema instruction
- `PROFILER_RETRY_PROMPT(source: string, error: string)` — retry with validation error
- File prioritization: sort by (1) known PHI source imports, (2) src/ vs lib/, (3) file size
- Merge profiler results with runtime detector results (Task 4) — `runtimeFlows` field populated by detector, other fields by LLM

**Tests (`profiler.test.ts`):**
- Mock LLM returns valid profile → parsed correctly
- Mock LLM returns invalid type → retry → passes
- Mock LLM returns garbage twice → null result + diagnostic
- File cap: 150 files submitted, maxFiles=100 → only top 100 profiled
- Concurrency: verify p-limit applied (mock timing)
- Empty file → empty profile (no LLM call)
- Non-TS/JS file → still profiled via LLM (language-agnostic prompt)

**Estimate:** 4–5 hours

---

### Task 6: Known Safe Patterns (`src/hipaa/flow/safe-patterns.ts`)

Configurable pattern matching for false positive reduction.

**Deliverables:**
- `SafePatternMatcher` class — loads patterns from config
- `matchSanitizer(functionName: string): boolean` — checks if function matches a sanitizer pattern
- `matchExpectedSink(sinkName: string): boolean` — checks if sink is expected/compliant
- `applySafePatterns(paths: PhiFlowPath[], matcher: SafePatternMatcher): PhiFlowPath[]` — downgrades confidence or suppresses findings based on pattern matches
- Default built-in patterns: `redact*`, `mask*`, `sanitize*`, `toPublic*` as sanitizers

**Tests (`safe-patterns.test.ts`):**
- Sanitizer in path → confidence downgraded from high to low
- Expected sink → finding suppressed (marked INFO)
- No pattern match → finding unchanged
- Custom patterns from config → applied correctly
- Regex edge cases (special characters in pattern)

**Estimate:** 2–3 hours

---

## Phase 3: Graph + Verifier

_Depends on Phase 2 (needs profiler output and runtime detector). Both tasks can be parallelized._

### Task 7: Pass 2 Flow Graph Builder (`src/hipaa/flow/graph.ts`)

Deterministic flow graph construction from profiles + import graph + runtime edges.

**Deliverables:**
- `buildPhiFlowGraph(profiles: Map<string, FilePhiProfile>, importGraph: FullImportGraph, options: FlowAnalysisOptions): PhiFlowPath[]`
- DFS/BFS traversal from each source through import edges + runtime flow edges
- Reverse edge usage for backward taint tracking
- Max depth enforcement (`flow-max-depth`, default 5)
- Path deduplication (same source+sink → keep shortest)
- Path prioritization when exceeding `flow-max-paths`:
  1. Sink type severity (log > external-api > analytics > cache)
  2. Shorter paths preferred
  3. Source type specificity (fhir-read > db-query > function-param)
- Confidence assignment: high (direct source→sink, no sanitizer), medium (through transforms), low (through dynamic channels or long chains)
- Confidence-to-severity mapping per design spec §4.2
- Runtime flow edge matching: event-emit ↔ event-listen by channel, queue-publish ↔ queue-subscribe by topic

**Tests (`graph.test.ts`):**
- Simple 2-file flow: source → import → sink → detected as high confidence
- 3-file chain: source → transform → sink → detected as medium confidence
- Event emitter flow: emit('patient', data) → on('patient', handler) with sink → detected
- Middleware chain flow → detected
- Max depth exceeded → path truncated
- Circular import → no infinite loop
- Path prioritization: 30 paths, maxPaths=20 → top 20 by heuristic
- Reverse edge taint: file exports PHI function → all importers checked
- No PHI sources → empty result

**Estimate:** 5–6 hours

---

### Task 8: Pass 3 Verifier (`src/hipaa/flow/verifier.ts`)

LLM-based leak verification with BAA registry integration.

**Deliverables:**
- `verifyPaths(paths: PhiFlowPath[], fileContents: Map<string, string>, llm: LLMClient, baaRegistry: BaaRegistry): Promise<VerifiedPath[]>`
- For each path, build verification prompt with:
  - Source context (file, function, type, line)
  - Intermediate steps
  - Sink context (file, function, type, line)
  - BAA status for external sinks (looked up via `checkBaaStatus()` from `src/hipaa/baa-registry.ts`)
- Validate LLM response with Zod schema + retry
- Severity escalation: external sink without BAA → +1 severity level
- Filter out verified non-leaks (isLeak=false)
- `VERIFIER_PROMPT(path: PhiFlowPath, sourceCode: string, sinkCode: string, baaStatus: string)` in `prompts.ts`
- Concurrency: p-limit(3) for verification calls

**Tests (`verifier.test.ts`):**
- Real leak → verified, finding generated
- Sanitized path → not a leak, filtered out
- External sink without BAA → severity escalated to CRITICAL
- External sink with BAA → severity unchanged, BAA status noted
- Zod validation failure + retry → works
- BAA registry lookup for known domains

**Estimate:** 4–5 hours

---

## Phase 4: Orchestrator + Integration

_Depends on Phase 3. Both tasks can be parallelized._

### Task 9: Flow Analysis Orchestrator (`src/hipaa/flow/index.ts`)

Public entry point that wires all passes together.

**Deliverables:**
- `analyzePhiFlow(options: FlowAnalysisOptions & { files: Array<{path: string, content: string}>, llm: LLMClient, importGraph?: ImportEdge[], tree?: RepoTree, fetcher?: CodebaseFetcher, baaRegistry?: BaaRegistry }): Promise<FlowAnalysisResult>`
- Orchestration:
  1. Build full import graph (or extend PR graph based on `mode`)
  2. Run Pass 1 profiler (parallel, with file cap)
  3. Run runtime flow detector on each file
  4. Merge runtime flows into profiles
  5. Run Pass 2 graph builder
  6. Apply safe patterns filter
  7. Run Pass 3 verifier on remaining paths
  8. Convert verified paths to `AgentFinding[]`
  9. Return results with diagnostics
- Finding conversion: `PhiFlowPath` → `AgentFinding` with:
  - `id`: `phi-flow-{hash}`
  - `title`: "PHI flows from {source} to {sink} across {n} files"
  - `severity`: from confidence-to-severity mapping
  - `file`: sink file (where the leak occurs)
  - `line`: sink line
  - `details`: full path description with source → intermediates → sink
  - `category`: `'hipaa'`

**Tests (`index.test.ts`):**
- End-to-end with mock LLM + mock files → findings generated
- PR mode vs scan mode → different graph building strategies
- Zero PHI files → empty result, no LLM calls
- File cap applied → limited profiling
- Diagnostics accumulated from all phases

**Estimate:** 3–4 hours

---

### Task 10: Integration into Scan + PR Pipelines

Wire `analyzePhiFlow()` into the existing scan orchestrator and PR review pipeline.

**Deliverables:**

**Scan pipeline (`src/scan/orchestrator.ts`):**
- After deterministic scanner block (~line 220), add flow analysis block:
  ```typescript
  if (repoConfig?.hipaa?.['flow-analysis'] !== false) {
    const flowResult = await analyzePhiFlow({ mode: 'scan', files: classifiedFiles, llm, ... });
    // Append as synthetic chunk
    chunkResults.push({ chunkId: 'phi-flow', domain: 'hipaa', findings: flowResult.findings, durationMs: flowResult.durationMs });
  }
  ```
- Pass BAA registry from loaded config
- Pass file cap and safe patterns from config

**PR review pipeline:**
- Add `analyzePhiFlow({ mode: 'pr', ... })` call where PR review generates findings
- Use existing PR-scoped import graph + 1-hop extension
- Findings appended to PR review results

**Deduplication enhancement (`src/scan/dedup-scan.ts`):**
- Add flow-aware dedup rule: same file + same line + same sink type as deterministic finding → suppress flow finding

**Tests (`integration.test.ts`):**
- Scan with flow analysis enabled → flow findings in output
- Scan with flow analysis disabled → no flow findings
- Dedup: deterministic + flow finding on same line → deterministic wins
- Dedup: flow finding on different file → both kept

**Estimate:** 3–4 hours

---

### Task 11: Configuration (`src/config/repo-config.ts`)

Add flow analysis config fields to the repo config schema.

**Deliverables:**
- Add to `HipaaConfig` interface:
  ```typescript
  'flow-analysis'?: boolean;
  'flow-max-depth'?: number;
  'flow-max-paths'?: number;
  'flow-max-files'?: number;
  'flow-safe-patterns'?: Array<{ pattern: string; type: 'sanitizer' | 'projection' | 'expected-sink' | 'compliant-sink' }>;
  ```
- Default values: flow-analysis=true, flow-max-depth=5, flow-max-paths=20, flow-max-files=100
- Config loading in `loadRepoConfig()` picks up new fields from `.agentreview.yml`

**Tests:** Add to existing `repo-config.test.ts` — validate new fields parsed correctly, defaults applied.

**Estimate:** 1–2 hours

---

## Phase 5: Testing + Documentation

_Depends on Phase 4._

### Task 12: Test Fixtures + Integration Tests

**Deliverables:**
- **Test fixture:** `test/fixtures/hipaa-flow/` — a minimal multi-file healthcare app with:
  - `patient-service.ts` — FHIR read (source)
  - `patient-middleware.ts` — Express middleware (transform)
  - `request-logger.ts` — console.log (sink: log)
  - `analytics-sender.ts` — Mixpanel call (sink: analytics, no BAA)
  - `event-bus.ts` — EventEmitter (runtime flow)
  - `queue-publisher.ts` — Kafka publish (runtime flow)
  - `queue-consumer.ts` — Kafka subscribe + log (sink via queue)
  - `redactor.ts` — PHI redaction utility (safe pattern)
- **Integration test:** `src/hipaa/flow/integration.test.ts`
  - Full pipeline test with mock LLM against fixture files
  - Assert: patient-service → request-logger path detected
  - Assert: patient-service → analytics-sender flagged with no-BAA escalation
  - Assert: event-bus → queue-consumer path detected
  - Assert: redactor in path → confidence downgraded
  - Assert: file cap respected
  - Assert: findings converted to AgentFinding format

**Estimate:** 4–5 hours

---

### Task 13: README + CHANGELOG

**Deliverables:**
- Update `README.md`:
  - Add "Cross-File PHI Flow Analysis" section under HIPAA features
  - Document config options (flow-analysis, flow-max-depth, flow-max-paths, flow-max-files, flow-safe-patterns)
  - Document language limitations (TS/JS import graph, LLM fallback for others)
- Update `CHANGELOG.md`:
  - Add entry under next version for cross-file PHI flow analysis feature
  - List key capabilities: expanded source/sink taxonomy, runtime flow detection, BAA registry integration, safe patterns

**Estimate:** 1–2 hours

---

## Summary

| Phase | Tasks | Can Parallelize | Depends On | Est. Hours |
|-------|-------|----------------|------------|-----------|
| 1 — Foundation | T1 (types), T2 (schemas), T3 (import graph) | ✅ All three | — | 6–9h |
| 2 — Detectors | T4 (runtime), T5 (profiler), T6 (safe patterns) | ✅ All three | Phase 1 | 9–12h |
| 3 — Graph + Verify | T7 (graph), T8 (verifier) | ✅ Both | Phase 2 | 9–11h |
| 4 — Integration | T9 (orchestrator), T10 (pipelines), T11 (config) | ✅ All three | Phase 3 | 7–10h |
| 5 — Testing + Docs | T12 (fixtures/tests), T13 (README/CHANGELOG) | ✅ Both | Phase 4 | 5–7h |
| **Total** | **13 tasks** | | | **36–49h** |

With parallelization within phases: **~3–4 working days** with a coding agent.

---

## Dependency Graph

```
Phase 1 (parallel):
  T1 types.ts ─────┐
  T2 schema.ts ────┤
  T3 import-graph ─┘
                    │
Phase 2 (parallel): ▼
  T4 runtime-detector ─┐
  T5 profiler ─────────┤
  T6 safe-patterns ────┘
                        │
Phase 3 (parallel):     ▼
  T7 graph.ts ──────┐
  T8 verifier.ts ───┘
                     │
Phase 4 (parallel):  ▼
  T9 orchestrator ──────┐
  T10 integration ──────┤
  T11 config ───────────┘
                         │
Phase 5 (parallel):      ▼
  T12 test fixtures ──┐
  T13 docs ───────────┘
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Token budget blowout on large repos | File cap (flow-max-files=100), path cap (flow-max-paths=20) |
| LLM returns invalid JSON | Zod validation + 1 retry with error context |
| False positives from LLM profiling | Known safe patterns config, confidence-based severity |
| Slow scan time from full import graph | PR mode uses 1-hop extension; scan mode builds once |
| Runtime flow false matches | Channel-name matching; dynamic channels logged as low confidence |
| Non-TS/JS coverage gaps | Documented limitation; LLM-based profiling as fallback |
