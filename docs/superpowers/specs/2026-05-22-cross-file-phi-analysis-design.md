# Design Spec: Cross-File PHI Data Flow Analysis

**Date:** 2026-05-22
**Author:** Vex
**Status:** DRAFT — awaiting 2-model review

---

## 1. Problem Statement

AgentReview reviews files in isolated chunks. It cannot trace PHI flowing across files:
```
patientService.ts → logMiddleware.ts → elasticClient.ts
                         ↑ PHI leaks here but tool can't see the connection
```

This is the #1 accuracy gap — we missed IDOR on NodeGoat (86% recall → should be >95%).

**Goal:** Trace PHI data flow across files using the existing import graph + multi-pass LLM analysis.

---

## 2. How It Works

### Pass 1: Source/Sink Identification (per-file, parallel)
For each file, identify:
- **PHI Sources** — functions/methods that return PHI (DB queries on patient tables, FHIR client calls, HL7 parsers)
- **PHI Sinks** — places PHI could leak (log calls, HTTP responses, external API calls, cache writes, queue publishes)
- **PHI Transforms** — functions that receive PHI and pass it along (middleware, transforms, mappers)

Output per file:
```typescript
interface FilePhiProfile {
  path: string;
  sources: Array<{ name: string; line: number; type: 'db' | 'fhir' | 'hl7' | 'api' | 'param' }>;
  sinks: Array<{ name: string; line: number; type: 'log' | 'response' | 'external' | 'cache' | 'queue' }>;
  transforms: Array<{ name: string; line: number; inputParam: string; outputReturn: boolean }>;
  exports: Array<{ name: string; containsPhi: boolean }>;
  imports: Array<{ from: string; names: string[] }>;
}
```

This pass uses a lightweight LLM prompt: "Identify PHI sources, sinks, and transforms in this file. Return structured JSON."

### Pass 2: Flow Graph Construction (deterministic)
Using the import graph (already built by codebase awareness module) + Pass 1 profiles:

1. Build a directed graph: `source → transform → ... → sink`
2. Follow imports: if file A imports `getPatient` from file B, and file B's profile says `getPatient` is a PHI source, then file A has PHI flowing in
3. Trace through transforms: if file C imports from file A and passes data to a log call, that's a PHI leak

This step is pure computation — no LLM needed.

### Pass 3: Leak Verification (targeted LLM)
For each identified potential leak path, send the specific source file + sink file to the LLM with context:
"PHI from `getPatient()` in patient-service.ts flows to `logger.info()` in request-logger.ts via the import chain. Is this a real PHI leak or is the data sanitized along the way?"

This is a targeted, high-confidence prompt — not a broad "find issues" prompt.

---

## 3. Architecture

### New Module: `src/hipaa/flow/`

```
src/hipaa/flow/
  index.ts              # Public API: analyzePhiFlow()
  types.ts              # Flow analysis types
  profiler.ts           # Pass 1: per-file PHI profiling
  graph.ts              # Pass 2: flow graph construction
  verifier.ts           # Pass 3: leak verification
  prompts.ts            # LLM prompts for Pass 1 + Pass 3
```

### Integration

```
Scan Pipeline
  │
  ├── Existing: chunk-based LLM review
  ├── Existing: deterministic scanners
  │
  └── NEW: Cross-file PHI flow analysis
        ├── Pass 1: profile each file (parallel, lightweight LLM)
        ├── Pass 2: build flow graph (deterministic, uses import graph)
        └── Pass 3: verify leaks (targeted LLM, only suspicious paths)
        │
        └── Findings merged with other findings
```

---

## 4. Detailed Design

### 4.1 Pass 1 Profiler (`profiler.ts`)

LLM prompt per file (lightweight — short response):
```
Analyze this file for PHI data handling. Return ONLY JSON:
{
  "sources": [{"name": "functionName", "line": 42, "type": "db|fhir|hl7|api|param"}],
  "sinks": [{"name": "functionName", "line": 55, "type": "log|response|external|cache|queue"}],
  "transforms": [{"name": "functionName", "line": 30, "inputParam": "patientData", "outputReturn": true}],
  "exports": [{"name": "getPatient", "containsPhi": true}]
}
If the file doesn't handle PHI at all, return: {"sources":[],"sinks":[],"transforms":[],"exports":[]}
```

**Optimization:** Only profile files classified as PHI-relevant (P0-P2 priority from discovery.ts) or files that import from PHI-relevant files. Skip test files, config files, static assets.

**Concurrency:** Profile files in parallel (p-limit, concurrency 5). Each profile is a small LLM call (~1K tokens input, ~200 tokens output).

### 4.2 Flow Graph (`graph.ts`)

Pure TypeScript, no LLM:

```typescript
interface PhiFlowEdge {
  from: { file: string; export: string; line: number };
  to: { file: string; import: string; line: number };
  type: 'source-to-transform' | 'transform-to-transform' | 'transform-to-sink' | 'source-to-sink';
}

interface PhiFlowPath {
  source: { file: string; name: string; line: number; type: string };
  intermediates: Array<{ file: string; name: string; line: number }>;
  sink: { file: string; name: string; line: number; type: string };
  confidence: 'high' | 'medium' | 'low';
}

function buildPhiFlowGraph(profiles: Map<string, FilePhiProfile>, importGraph: ImportEdge[]): PhiFlowPath[]
```

Algorithm:
1. For each file with PHI sources, trace exports through import graph
2. At each hop, check if the importing file has transforms that handle the imported function's output
3. Continue following the chain until reaching a sink or dead end
4. Mark paths: source → sink without sanitization = high confidence leak

### 4.3 Leak Verifier (`verifier.ts`)

For each high/medium confidence path, send targeted LLM verification:
```
PHI Data Flow Detected:
Source: getPatient() in src/services/patient.ts:42 (returns patient record from DB)
  → imported by src/middleware/logger.ts:5
  → used in logRequest() at line 18
  → calls console.log(req.body) at line 22

Sink: console.log in src/middleware/logger.ts:22

Question: Is patient PHI actually exposed at the sink, or is it sanitized/filtered before reaching the log call? Consider:
1. Is the data transformed/filtered between source and sink?
2. Are only non-PHI fields used at the sink?
3. Is there any redaction/masking applied?

Return JSON: {"isLeak": true/false, "confidence": "high/medium/low", "explanation": "..."}
```

### 4.4 Token Budget

- Pass 1: ~1K tokens per file × 50 files = ~50K tokens (cheap)
- Pass 2: 0 tokens (deterministic)
- Pass 3: ~2K tokens per suspicious path × ~10 paths = ~20K tokens

Total: ~70K additional tokens per scan (~$0.10-0.20). Reasonable.

---

## 5. Configuration

```yaml
# .agentreview.yml
hipaa:
  flow-analysis: true          # Enable cross-file PHI flow (default: true when hipaa lens active)
  flow-max-depth: 5            # Max import chain depth to follow (default: 5)
  flow-max-paths: 20           # Max suspicious paths to verify (default: 20)
```

---

## 6. What This Catches That We Currently Miss

| Vulnerability | Current | With Flow Analysis |
|--------------|---------|-------------------|
| IDOR (accessing other users' data) | ❌ Missed | ✅ Traces data from auth → query → response |
| PHI in logs via middleware | ❌ Missed (cross-file) | ✅ Traces PHI from service → middleware → log |
| PHI to analytics/monitoring | ❌ Missed (cross-file) | ✅ Traces patient data → analytics SDK |
| Missing sanitization in transform | ❌ Missed | ✅ Identifies unsanitized transform chains |
| FHIR data returned without scoping | Partial | ✅ Traces FHIR client → API response |

Expected accuracy improvement: recall from 86% → 93-95%.

---

## 7. Testing Strategy

- Unit tests for each module (profiler, graph, verifier)
- Flow graph tests with mock import graphs + profiles
- Integration test with hipaa-app fixture (add cross-file PHI flow)
- Production test on NodeGoat (should now catch IDOR)

---

## 8. Success Criteria

1. Catches IDOR on NodeGoat (currently missed)
2. Catches cross-file PHI-in-logs (service → middleware → log)
3. <30% false positive rate on flow findings
4. Total scan time increase <30 seconds (for 50-file codebase)
5. Token cost increase <$0.25 per scan
