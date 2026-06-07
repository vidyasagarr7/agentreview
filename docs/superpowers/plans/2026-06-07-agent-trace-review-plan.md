# Implementation Plan: Agent Trace Review

**Spec:** `docs/superpowers/specs/2026-06-07-agent-trace-review-design.md` (v2)
**Method:** TDD (RED → GREEN → REFACTOR per task)
**Branch:** `feat/agent-trace-review`

## Task Breakdown

### Task 1: Trace Types (src/trace/types.ts)
**Files:** `src/trace/types.ts` (new)
**Intent:** Define TypeScript types for parsed trace events and sessions.
**Types to define:**
- `TraceEventType` union: `'user' | 'assistant' | 'tool_use' | 'system' | 'unknown'`
- `TraceToolCall`: `{ name: string; input: Record<string, unknown>; result?: { content: string; isError: boolean } }`
- `TraceEvent`: `{ type: TraceEventType; timestamp: string; uuid: string; text?: string; toolCalls?: TraceToolCall[]; thinking?: string }`
- `TraceStats`: `{ totalEvents, userPrompts, toolCalls, toolCallsByName, errorCount, durationMs }`
- `TraceSession`: `{ sessionId, model, startedAt, endedAt, events, stats }`
- `ProcessFinding`: `{ signal, severity, description, evidence, eventIndex }`
**Verification:** `tsc --noEmit` passes. Types are importable from other modules.
**Estimate:** 2 min

### Task 2: Trace Parser — Core (src/trace/parser.ts + test)
**Files:** `src/trace/parser.ts` (new), `src/trace/parser.test.ts` (new)
**Intent:** Parse Claude Code JSONL into `TraceSession`. Line-by-line, memory-efficient.
**Tests (write FIRST):**
- Parses minimal valid JSONL (1 user event + 1 assistant event) → correct TraceSession
- Skips malformed JSON lines, increments warning counter
- Drops noise event types (permission-mode, file-history-snapshot, etc.)
- Extracts user prompt text from string and array content formats
- Extracts assistant text blocks and tool_use blocks
- Extracts tool results (content, isError) from subsequent user messages
- Computes TraceStats correctly (counts, duration)
- Handles empty input → empty TraceSession
- Handles very large input (10K+ lines) without OOM (memory test)
**Implementation:**
- `parseTrace(input: string): TraceSession` — main entry
- Line-by-line split + JSON.parse with try/catch per line
- Event classifier: type → keep/drop decision
- Stats accumulator: counts tool calls, errors, timestamps for duration
**Verification:** `vitest run src/trace/parser.test.ts` — all tests pass
**Estimate:** 5 min

### Task 3: Trace Parser — Tool Result Linking (within parser.ts)
**Files:** `src/trace/parser.ts`, `src/trace/parser.test.ts`
**Intent:** Link tool results (in user messages) back to their tool_use events.
**Tests (write FIRST):**
- Tool result with matching tool_use_id gets attached to correct ToolCall
- Tool result with is_error=true sets isError flag
- Tool result content is truncated (80 chars OK, 400 chars error)
- Orphaned tool results (no matching tool_use) are kept but flagged
**Implementation:**
- After parsing assistant tool_use, store pending tool_use IDs
- When parsing user message with tool_result blocks, match by tool_use_id
- Truncate content per spec limits
**Verification:** `vitest run src/trace/parser.test.ts` — all pass
**Estimate:** 3 min

### Task 4: Enhanced Redaction (src/scan/redact.ts + test)
**Files:** `src/scan/redact.ts` (edit), `src/scan/redact.test.ts` (edit)
**Intent:** Add JWT, env assignment, AWS secret, and Shannon entropy detection.
**Tests (write FIRST):**
- JWT `eyJhbGci...` is redacted to `[REDACTED_JWT]`
- Env assignment `SECRET_KEY=abc123...` → `SECRET_KEY=[REDACTED_ENV]`
- AWS secret key (40-char base64 at word boundary) → `[REDACTED_AWS_SECRET]`
- Shannon entropy: quoted string ≥32 chars with entropy ≥4.0 → `[REDACTED_HIGH_ENTROPY]`
- Shannon entropy: quoted string ≥32 chars with LOW entropy (e.g., repeated chars) → NOT redacted
- Existing patterns still work (regression)
- `shannonEntropy` function: known inputs produce expected values
**Implementation:**
- Add 3 new named patterns to REDACT_PATTERNS array
- Add `shannonEntropy(s: string): number` function
- Add entropy-based pass after named patterns (regex for quoted strings ≥32 chars)
**Verification:** `vitest run src/scan/redact.test.ts` — all pass
**Estimate:** 4 min

### Task 5: Trace Distiller (src/trace/distiller.ts + test)
**Files:** `src/trace/distiller.ts` (new), `src/trace/distiller.test.ts` (new)
**Intent:** Compress TraceSession into compact text for analysis/display.
**Tests (write FIRST):**
- User events rendered as `USER: <text>`
- Assistant text rendered as `ASSISTANT: <text>`
- Bash tool calls rendered as `Bash: <command>` (truncated at 120 chars)
- Write/Edit calls rendered as `Write src/foo.ts (2.4KB)` (no content)
- Read calls rendered as `Read src/foo.ts`
- Grep calls rendered as `Grep "pattern" in path`
- Failed tool calls are NEVER collapsed (key design fix)
- Successful exploration runs ≥6 consecutive tools → `[exploration: N tools]`
- Over target budget → exploration collapse applied
- Over hard cap → head/tail truncation with `[… elided N events …]`
- Empty session → empty string
- Token estimation function: known inputs produce expected values
**Implementation:**
- `distillTrace(session: TraceSession): string` — main entry
- `renderEvent(event: TraceEvent): string | null` — per-event rendering
- `collapseExploration(lines: string[]): string[]` — collapse long successful runs
- `truncateMiddle(lines: string[], budget: number): string[]` — head/tail with marker
- `estimateTokens(text: string): number` — chars × 0.4
**Verification:** `vitest run src/trace/distiller.test.ts` — all pass
**Estimate:** 5 min

### Task 6: Trace Analyzer (src/trace/analyzer.ts + test)
**Files:** `src/trace/analyzer.ts` (new), `src/trace/analyzer.test.ts` (new)
**Intent:** Heuristic process analysis producing ProcessFindings.
**Tests (write FIRST):**
- Dead end detection: error → different approach → produces "dead_end" finding
- Multiple dead ends: count is correct
- Retry storm: same tool+input 3+ times → "retry_storm" finding
- Unhandled error: error result → next action doesn't address it → "unhandled_error" finding
- Low exploration: only 1 approach → "low_exploration" info finding
- Clean session: no dead ends, varied approaches → no warnings
- Session stats: correct duration, tool distribution, exploration ratio
- Empty session → no findings
**Implementation:**
- `analyzeTrace(session: TraceSession): ProcessFinding[]` — main entry
- `detectDeadEnds(events: TraceEvent[]): ProcessFinding[]`
- `detectRetryStorms(events: TraceEvent[]): ProcessFinding[]`
- `detectUnhandledErrors(events: TraceEvent[]): ProcessFinding[]`
- `detectLowExploration(events: TraceEvent[]): ProcessFinding[]`
- Helper: `isSimilarToolCall(a, b): boolean` — for retry detection
**Verification:** `vitest run src/trace/analyzer.test.ts` — all pass
**Estimate:** 5 min

### Task 7: Trace Index Module (src/trace/index.ts)
**Files:** `src/trace/index.ts` (new)
**Intent:** Public API re-exporting parser, distiller, analyzer, types.
**Tests:** N/A (re-exports only). Verified by import in CLI command.
**Implementation:**
```typescript
export { parseTrace } from './parser.js';
export { distillTrace } from './distiller.js';
export { analyzeTrace } from './analyzer.js';
export type { TraceSession, TraceEvent, TraceStats, ProcessFinding, ... } from './types.js';
```
**Verification:** `tsc --noEmit` passes
**Estimate:** 1 min

### Task 8: CLI Command (src/cli/commands/trace.ts + test)
**Files:** `src/cli/commands/trace.ts` (new), `src/cli/commands/trace.test.ts` (new)
**Intent:** `agentreview trace <path>` command with text/json/markdown output.
**Tests (write FIRST):**
- Missing path argument → error message
- Non-existent file → error message
- Valid JSONL → parses, analyzes, prints formatted output
- `--format json` → valid JSON output with findings + stats
- `--format markdown` → markdown formatted output
- `--stats-only` → only stats, no process analysis
- `--verbose` → includes distilled trace in output
**Implementation:**
- `createTraceCommand(): Command` — commander subcommand
- Read file from disk (fs.readFile)
- Run redaction → parse → distill → analyze pipeline
- Format output (text/json/markdown renderers)
- Register in main CLI index.ts
**Verification:** `vitest run src/cli/commands/trace.test.ts` — all pass
**Estimate:** 5 min

### Task 9: CLI Integration (src/cli/index.ts edit)
**Files:** `src/cli/index.ts` (edit)
**Intent:** Register the trace subcommand in the main CLI.
**Tests:** Integration: `node dist/cli/index.js trace --help` prints usage.
**Implementation:**
- Import createTraceCommand
- Add `.addCommand(createTraceCommand())` to program
**Verification:** Build + run `--help` shows trace command
**Estimate:** 1 min

### Task 10: Integration Test
**Files:** `src/trace/integration.test.ts` (new)
**Intent:** End-to-end test with a realistic Claude Code JSONL fixture.
**Tests:**
- Create a fixture JSONL file with realistic Claude Code events (user prompts, assistant responses, tool calls with results, errors, retries)
- Parse → distill → analyze full pipeline
- Verify: stats are accurate, findings are correct, distilled text is within budget
- Verify: redaction was applied (planted secrets are gone)
- Verify: failed tool calls are NOT collapsed in distilled output
**Fixture:** Create `src/trace/fixtures/sample-session.jsonl` with ~50 events covering all scenarios
**Verification:** `vitest run src/trace/integration.test.ts` — all pass
**Estimate:** 5 min

## Total: 10 tasks, ~36 minutes estimated build time

## Execution Order
Tasks 1-4 are independent (types, parser, redaction — can be parallelized).
Tasks 5-6 depend on Task 1 (types) and Task 2 (parser).
Task 7 depends on Tasks 2, 5, 6.
Tasks 8-9 depend on Task 7.
Task 10 depends on all above.

## Build Agent
Primary: Claude Code with Superpowers TDD
Branch: `feat/agent-trace-review` (created from main)
