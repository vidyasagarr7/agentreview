# AgentReview — Implementation Plan v2

> Updated based on adversarial code review (codex-review.md).
> Changes from v1 are marked with ⚠️ (modified), ✂️ (removed), ➕ (added), or ✅ (unchanged).
>
> Atomic tasks, each 2–15 minutes. No task produces incomplete state.

---

## Summary of Changes from v1

### Accepted Fixes
- **Task 3.2 (parseFindings):** Now FAILS LOUDLY — returns explicit `ParseError` marker, never silently returns `[]`. Users see "[PARSE ERROR] Security lens returned garbled response" in the report, never a false "clean" result.
- **Task 1.2 (getFiles):** Adds Octokit pagination handling — iterates all pages, warns if >300 files.
- **Task 5.1 (Jaccard dedup):** REMOVED from v1. Too complex, nearly useless. Replaced with simple exact-match dedup (same file + same severity + near-identical summary via toLowerCase/trim).
- **Task 6.3 (terminal renderer):** REMOVED from v1. Markdown + JSON output is sufficient. Cuts scope, cuts `chalk` dependency from critical path.
- **Tasks 7.1/7.3 (config/config subcommand):** SIMPLIFIED — env vars only in v1, no config file storage for secrets, no `config set/get/list` subcommand. Added `dotenv` support for `.env` in project root.
- **Task 2.1 (lens prompts):** Marked as SUBSTANTIAL (2-4 hours, not 3 minutes). Each lens needs carefully crafted system prompts with calibrated severity and JSON output enforcement.
- **Data disclosure warning:** Added on first invocation — warns users that code diffs will be sent to LLM providers.
- **Diff truncation:** Changed from byte-based (100KB) to token-aware (estimate tokens, stay under model context limit minus output budget).
- **Timeline:** Updated to realistic 2-3 days estimate.

### Deferred to v2
- Jaccard/embedding-based dedup
- Terminal color renderer
- Config file storage (conf package)
- `agentreview config set/get/list` subcommand
- OpenAI `response_format: json_object` mode (nice-to-have)
- Streaming LLM responses
- Cost estimation (`--dry-run`)
- Rate limiting / global semaphore

---

## Phase 0: Project Scaffold

---

### Task 0.1 — Initialize npm package ✅
**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.nvmrc`

**Produces:**
- `package.json` with name `agentreview`, bin entry pointing to `dist/cli/index.js`
- `tsconfig.json` targeting ES2022, Node16 module resolution
- `.nvmrc` pinned to `20`
- `.gitignore` covering `node_modules`, `dist`

**Verification:** `npm install` completes without errors.

---

### Task 0.2 — Install runtime dependencies ⚠️
**Files:** `package.json`

**Produces:** `node_modules` with:
- `commander` — CLI parsing
- `@octokit/rest` — GitHub API
- `openai` — LLM calls
- `dotenv` — `.env` file loading (replaces `conf`)
- `ora` — spinner for progress (not verbose-only)
- ~~`conf`~~ — REMOVED (env vars only for config)
- ~~`chalk`~~ — REMOVED (no terminal renderer in v1)
- ~~`marked`~~ — REMOVED (markdown is plain string output)

**Verification:** `node -e "require('@octokit/rest')"` exits 0.

---

### Task 0.3 — Install dev dependencies + build tooling ✅
**Files:** `package.json`, `tsup.config.ts`, `vitest.config.ts`

**Produces:**
- Dev deps: `typescript`, `tsup`, `vitest`, `@types/node`
- `tsup.config.ts` — builds `src/cli/index.ts` → `dist/cli/index.js` (CJS)
- `vitest.config.ts` — test runner config
- `npm run build` and `npm test` scripts

**Verification:** `npm run build` produces `dist/cli/index.js`.

---

### Task 0.4 — Create directory structure + type definitions ✅
**Files:** `src/types/index.ts`

**Produces:**
- Directory tree: `src/cli/`, `src/github/`, `src/lenses/builtin/`, `src/agents/`, `src/llm/`, `src/report/renderers/`
- `src/types/index.ts` — all shared TypeScript interfaces:
  - `PRData`, `ChangedFile`, `Lens`, `ReviewContext`
  - `AgentFinding`, `AgentResult`, `ParseErrorResult`, `ConsolidatedReport`
  - `ReportFormat`, `CLIOptions`, `LLMConfig`

**Verification:** `npx tsc --noEmit` exits 0.

---

## Phase 1: GitHub API Client

---

### Task 1.1 — PR URL parser ✅
**Files:** `src/github/parse-url.ts`, `src/github/parse-url.test.ts`

**Produces:**
- `parsePRUrl(url: string): { owner: string; repo: string; number: number }`
- Handles: `https://github.com/owner/repo/pull/123`, `github.com/owner/repo/pull/123`
- Throws `InvalidPRUrlError` for malformed input with clear message including GHE note

**Verification:** Tests pass for valid URLs, invalid URLs, missing PR number.

---

### Task 1.2 — GitHub API client (read operations) ⚠️
**Files:** `src/github/client.ts`

**Produces:**
- `GitHubClient` class initialized with token
- `getPR(owner, repo, number): Promise<PRData>` — fetches PR metadata
- `getDiff(owner, repo, number): Promise<string>` — fetches unified diff
- `getFiles(owner, repo, number): Promise<ChangedFile[]>` — **paginates ALL pages** using `octokit.paginate()`; logs warning if total files >300
- `postComment(owner, repo, number, body): Promise<void>`
- `listComments(owner, repo, number): Promise<Comment[]>` — for idempotent --post

**CHANGED:** `getFiles()` now iterates all pages. No silent truncation.

**Verification:** Unit test with mocked Octokit confirms pagination is called when page 1 returns 100 results.

---

### Task 1.3 — PR context builder ⚠️
**Files:** `src/github/context-builder.ts`, `src/github/context-builder.test.ts`

**Produces:**
- `buildReviewContext(pr: PRData, diff: string, files: ChangedFile[], modelContextTokens: number): ReviewContext`
- **Token-aware truncation:** estimates tokens as `Math.ceil(bytes / 4)` (conservative estimate)
- Budget: `modelContextTokens - 4000` (reserve 4K for system prompt + metadata + output)
- If diff exceeds budget: truncate per-file, keeping files with security-relevant names first (auth, password, token, secret, key, crypt)
- Annotate `context.truncated = true` and `context.truncationNote` with file count dropped

**CHANGED:** Truncation is now token-aware, not byte-based.

**Verification:** Unit test: given a mock PRData + diff exceeding token budget, `context.truncated === true` and token estimate of `context.diff` is within budget.

---

## Phase 2: Lens Registry

---

### Task 2.1 — Built-in lens definitions ⚠️ (SUBSTANTIAL TASK — 2-4 hours)
**Files:** `src/lenses/builtin/security.ts`, `src/lenses/builtin/architecture.ts`, `src/lenses/builtin/quality.ts`

**Produces:**
- Three `Lens` objects with **carefully engineered, production-quality system prompts**
- Each prompt must:
  - Define a specific, bounded review scope (not "review everything")
  - Calibrate severity explicitly (what is CRITICAL vs HIGH vs LOW for this lens)
  - Enforce JSON-only output with schema reminder
  - Instruct on *why*, not just *what*
  - Provide 2-3 examples of well-formed findings in the prompt
  - Instruct to return `[]` if truly nothing found — do not hallucinate findings
- System prompt length: >500 chars each (substantive, not template filler)

**Security lens focuses on:** OWASP Top 10, hardcoded secrets, auth/authz bypasses, injection (SQL/command/path), insecure deserialization, sensitive data exposure, CSRF, improper error handling that leaks info

**Architecture lens focuses on:** SOLID violations, inappropriate coupling, missing abstractions, design patterns misuse, scalability concerns, circular dependencies, layering violations, API contract breaks

**Quality lens focuses on:** Missing error handling, no test coverage for changed paths, unclear variable names, complex functions (high cognitive complexity), missing documentation for public APIs, dead code, magic numbers

**Verification:** Import each lens; verify `lens.systemPrompt.length > 500`. Manual test against one real PR (recorded as fixture).

---

### Task 2.2 — Lens registry ✅
**Files:** `src/lenses/registry.ts`, `src/lenses/registry.test.ts`

**Produces:**
- `LensRegistry` class
- `getBuiltinLenses(): Lens[]` — returns the 3 built-ins
- `loadCustomLenses(dir: string): Promise<Lens[]>` — reads `*.json`, validates schema, rejects oversized prompts (>10KB)
- `resolveLenses(ids: string[] | 'all'): Lens[]` — filters by ID, throws with available lens list if unknown

**Verification:** Tests confirm: `resolveLenses('all')` returns 3; unknown ID throws with helpful message listing available lenses.

---

## Phase 3: LLM Client

---

### Task 3.1 — LLM client abstraction ✅
**Files:** `src/llm/client.ts`, `src/llm/client.test.ts`

**Produces:**
- `LLMClient` class with config (provider, model, apiKey, timeout)
- `complete(systemPrompt: string, userPrompt: string): Promise<string>` — returns raw LLM response
- Retry logic: 3 attempts, exponential backoff with jitter on 429/500/timeout
- Distinguishes retryable (429, 500, 503, timeout) from non-retryable (400, 401, 404)
- Throws `LLMError` with clean message on final failure

**Verification:** Unit test with mocked OpenAI: retry fires on 429, gives up after 3 failures, throws `LLMError`.

---

### Task 3.2 — Structured response parser ⚠️ (CRITICAL CHANGE)
**Files:** `src/llm/parse-findings.ts`, `src/llm/parse-findings.test.ts`

**Produces:**
- `parseFindings(raw: string, lensId: string): AgentFinding[] | ParseError`
- Return type is a **discriminated union** — either findings OR a parse error (never silent `[]`)
- Fallback chain:
  1. Direct `JSON.parse(raw)` — if array, validate and return
  2. Extract from markdown code fence (` ```json ... ``` `)
  3. Extract JSON array using regex: first `[...]` in the response
  4. Check if response is `{ "findings": [...] }` object shape — unwrap
  5. If all fail → return `{ type: 'ParseError', lensId, raw: raw.slice(0, 200), message: '[PARSE ERROR] Lens returned garbled response' }`
- After successful extraction: validate each finding has required fields; filter malformed items; log count of filtered items
- Handles: trailing commas (try to fix with regex), JSON object instead of array (unwrap), prose before JSON (skip prose)

**CRITICAL CHANGE:** Never returns `[]` on complete parse failure. Returns explicit `ParseError` that surfaces in report as "[PARSE ERROR] {lensId} lens returned garbled response — results may be incomplete."

**Verification:** Tests for: valid JSON array, JSON in code fence, prose + JSON, object with findings key, completely garbled (returns `ParseError` not `[]`), partial findings (returns valid subset + count of filtered).

---

## Phase 4: Agent Dispatcher

---

### Task 4.1 — Prompt builder ✅
**Files:** `src/agents/prompt-builder.ts`, `src/agents/prompt-builder.test.ts`

**Produces:**
- `buildPrompt(lens: Lens, context: ReviewContext): { system: string; user: string }`
- Injects PR metadata, file list, diff into template
- Includes JSON output schema instruction (required fields, severity enum)
- Adds truncation notice to user prompt if `context.truncated === true`

**Verification:** Point tests (not snapshots): output contains file list, contains diff, contains schema instruction, contains truncation note when `context.truncated === true`.

---

### Task 4.2 — Agent dispatcher ⚠️
**Files:** `src/agents/dispatcher.ts`, `src/agents/dispatcher.test.ts`

**Produces:**
- `dispatchAgents(lenses: Lens[], context: ReviewContext, llm: LLMClient, opts): Promise<AgentResult[]>`
- Uses `Promise.allSettled` — all lenses run in parallel
- Per-agent result: `{ lensId, findings: AgentFinding[] | ParseError, error?, durationMs }`
- **Calls `parseFindings()` and stores the discriminated union result** — not silently swallowed
- Shows progress via `ora` spinner ON BY DEFAULT (e.g., "Reviewing with security lens... ✓")
- `--verbose` adds per-agent timing in parentheses

**CHANGED:** ParseError results are stored and surfaced in report, not discarded.

**Verification:** Unit test: mocked parse failure → result has `ParseError` type, not empty findings.

---

## Phase 5: Report Consolidator

---

### Task 5.1 — Finding deduplicator ⚠️ (SIMPLIFIED)
**Files:** `src/report/dedup.ts`, `src/report/dedup.test.ts`

**REMOVED:** Jaccard similarity dedup (too complex, nearly useless per review).

**Produces:**
- `deduplicateFindings(results: AgentResult[]): AgentFinding[]`
- Flatten all findings from all lenses
- Tag each finding with `lenses: string[]` from its source
- **Simple exact-match dedup only:** two findings are duplicates if ALL of:
  - Same file (normalized, case-insensitive)
  - Same severity
  - Summary strings match after toLowerCase + trim + collapse whitespace + strip punctuation
- Merge duplicates: union lens tags, keep longest `detail`
- ParseError results are kept as special findings (not deduplicated)

**Verification:** Tests: identical findings from two lenses → merged with both lens tags; different summaries → both kept; ParseError → surfaced as-is.

---

### Task 5.2 — Report consolidator ✅
**Files:** `src/report/consolidator.ts`, `src/report/consolidator.test.ts`

**Produces:**
- `consolidate(results: AgentResult[], pr: PRData): ConsolidatedReport`
- Calls deduplicator
- Sorts findings: severity DESC (CRITICAL first), then lens order, then file path ASC
- ParseErrors sort after real findings
- Computes summary stats (counts by severity, counts by lens, clean lenses, errored lenses)
- Sets `confidence: 'LOW'` if any agent errored or returned ParseError, otherwise `'NORMAL'`

**Verification:** Given fixture with mixed severities + one ParseError: sorted correctly, confidence is `LOW`, ParseError appears in report.

---

## Phase 6: Report Renderer

---

### Task 6.1 — Markdown renderer ✅
**Files:** `src/report/renderers/markdown.ts`, `src/report/renderers/markdown.test.ts`

**Produces:**
- `renderMarkdown(report: ConsolidatedReport): string`
- Outputs full markdown: header, summary table, findings by severity, lens notes
- ParseError findings render as: `### ⚠️ [PARSE ERROR] {lensId} lens returned garbled response — results may be incomplete`
- Clean lenses noted with: "✅ No issues found"
- Confidence warning if `confidence === 'LOW'`

**Verification:** Point tests: output contains expected headers, CRITICAL section, ParseError section when present, clean lens note.

---

### Task 6.2 — JSON renderer ✅
**Files:** `src/report/renderers/json.ts`

**Produces:**
- `renderJSON(report: ConsolidatedReport): string`
- `JSON.stringify(report, null, 2)` — clean, no transformation
- ParseError entries appear in output with `type: 'ParseError'` field

**Verification:** `JSON.parse(renderJSON(fixture))` round-trips without error.

---

### Task 6.3 — Renderer router ⚠️ (simplified — no terminal renderer)
**Files:** `src/report/renderer.ts`

**Produces:**
- `render(report: ConsolidatedReport, format: ReportFormat): string`
- Routes to markdown or json renderer only
- `ReportFormat` = `'markdown' | 'json'`
- Default: `markdown`

**REMOVED:** Terminal renderer deferred to v2.

**Verification:** `format: 'json'` returns valid JSON. `format: 'markdown'` returns markdown string.

---

## Phase 7: CLI Entry Point

---

### Task 7.1 — Config manager ⚠️ (SIMPLIFIED — env vars only)
**Files:** `src/cli/config.ts`

**REMOVED:** `conf` package, config file, `config set/get/list` subcommand.

**Produces:**
- `ConfigManager` class — reads ONLY from env vars (via `process.env` + `dotenv`)
- Loads `.env` from CWD if present (using `dotenv`)
- `getGitHubToken(): string` — throws `ConfigError` with setup instructions if not set
- `getLLMConfig(): LLMConfig` — resolves provider (openai default), model, apiKey
- `getModelContextTokens(model: string): number` — returns context window size per model (gpt-4o: 128000, gpt-4-turbo: 128000, gpt-3.5-turbo: 16000)
- **Data disclosure check:** `hasAcknowledgedDataPolicy(): boolean` — checks `AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1` env var

**Verification:** Unit test: `GITHUB_TOKEN` env var set → `getGitHubToken()` returns it; unset → throws `ConfigError`.

---

### Task 7.2 — Data disclosure warning ➕ (NEW)
**Files:** `src/cli/disclosure.ts`

**Produces:**
- `checkDataDisclosure(opts: CLIOptions): Promise<void>`
- If `AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1` is set → no-op
- Otherwise: print warning to stderr:
  ```
  ⚠️  AgentReview sends your PR diff to an LLM provider (default: OpenAI) for analysis.
      This includes all changed code in the PR, which may contain sensitive business logic.
      Review OpenAI's data policy: https://openai.com/policies/api-data-usage-policies
      
      To skip this prompt, set: AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1
  ```
- Prompt: "Continue? [y/N]"
- If user answers `n` or hits enter → exit 0 with "Review cancelled."
- If `--yes` / `--non-interactive` flag → auto-acknowledge and log warning to stderr

**Verification:** Unit test: mock stdin `n` → process would exit; `AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1` → no prompt.

---

### Task 7.3 — Main CLI wiring ⚠️
**Files:** `src/cli/index.ts`

**Produces:**
- `commander` program with `agentreview <pr-url>` command + flags:
  - `--lens <ids>` — comma-separated lens IDs or `all` (default)
  - `--format <fmt>` — `markdown` or `json` (default: `markdown`)
  - `--output <path>` — output file (default: stdout)
  - `--post` — post as GitHub PR comment (idempotent: updates existing AgentReview comment)
  - `--fail-on <severity>` — exit 2 if findings at or above severity; exit 1 if any agent errored
  - `--timeout <seconds>` — per-agent timeout (default: 60)
  - `--model <model>` — LLM model override
  - `--no-dedup` — disable deduplication
  - `--verbose` — show per-agent timing
  - `--yes` / `-y` — skip data disclosure prompt
- Pipeline: disclosure check → parse URL → build GitHub client → fetch PR → build context → resolve lenses → dispatch agents → consolidate → render → output
- **`--fail-on` semantics:** exit 2 if findings at or above severity; exit 1 if any agent errored (never exit 0 on incomplete review)
- Graceful error handling with user-friendly messages for all error types
- Unknown lens ID error message includes list of available lenses

**Verification:** `node dist/cli/index.js --help` shows usage and all flags.

---

### Task 7.4 — `lenses` subcommand ✅ (kept)
**Files:** `src/cli/commands/lenses.ts`

**Produces:**
- `agentreview lenses list` — shows built-in + custom lenses with descriptions
- `agentreview lenses add <path-to-json>` — validates + copies lens to `~/.agentreview/lenses/`
- Lens schema validation includes prompt size limit (reject >10KB prompts)

**Verification:** `agentreview lenses list` outputs 3 built-in lenses with descriptions.

---

## Phase 8: Polish & Tests

---

### Task 8.1 — Fixture-based integration test ⚠️ (replaces live smoke test)
**Files:** `src/__tests__/integration/fixtures/pr-diff.txt`, `src/__tests__/integration/pipeline.test.ts`

**CHANGED:** Uses recorded fixture data, not live API calls.

**Produces:**
- Fixture: a real-looking PR diff with a hardcoded secret, a missing input validation, and a refactoring smell
- Integration test: runs the full pipeline with mocked GitHub client (returns fixture) and mocked LLM client (returns fixture findings JSON)
- Asserts: report contains CRITICAL finding from security lens, confidence annotation, valid JSON output when format=json
- Deterministic — no flakiness from live APIs

**Verification:** `npm test` passes the integration test.

---

### Task 8.2 — README ✅
**Files:** `README.md`

**Produces:**
- Install instructions
- Quick start (set env vars, run on a PR)
- All flags documented
- Environment variables table
- Custom lenses section
- Data policy/privacy note
- Contributing section

---

### Task 8.3 — npm publish prep ✅
**Files:** `package.json`, `.npmignore`

**Produces:**
- `package.json`: `files` field → `dist/`, `README.md`
- `.npmignore` excluding `scripts/`, `docs/`, test files
- Version bumped to `0.1.0`

---

## Revised Task Dependency Graph

```
0.1 → 0.2 → 0.3 → 0.4
                     ├─→ 1.1 → 1.2 → 1.3
                     ├─→ 3.1 → 3.2
                     └─→ 2.1 → 2.2

1.3 + 2.2 + 3.2 → 4.1 → 4.2
4.2 → 5.1 → 5.2 → 6.1, 6.2 → 6.3

6.3 + 1.2 + 2.2 + 4.2 + 5.2 + 7.1 → 7.2 → 7.3 → 7.4

7.3 → 8.1 → 8.2 → 8.3
```

---

## Revised Timeline Estimate

| Phase | Tasks | Realistic Estimate |
|-------|-------|--------------------|
| Phase 0: Scaffold | 4 tasks | 1 hour |
| Phase 1: GitHub Client | 3 tasks | 2 hours |
| Phase 2: Lenses | 2 tasks | **4-6 hours** (prompt engineering is hard) |
| Phase 3: LLM Client | 2 tasks | 2 hours |
| Phase 4: Dispatcher | 2 tasks | 1.5 hours |
| Phase 5: Consolidator | 2 tasks | 1.5 hours |
| Phase 6: Renderer | 3 tasks | 2 hours |
| Phase 7: CLI | 4 tasks | 3 hours |
| Phase 8: Polish | 3 tasks | 2 hours |
| **Iteration / debugging** | — | **4-6 hours** |
| **Total** | **25 tasks** | **~2-3 days** |

---

## Definition of Done (v1)

- [ ] `agentreview <pr-url>` runs end-to-end with real GitHub PR
- [ ] All 3 built-in lenses produce findings (or clean) for a non-trivial PR
- [ ] ParseErrors surface visibly in report — never silent
- [ ] `--format json` output passes `JSON.parse()`
- [ ] `--post` posts or updates a comment to the PR
- [ ] `--fail-on HIGH` exits 2 when HIGH findings exist; exits 1 on agent errors
- [ ] All unit and integration tests pass (`npm test`)
- [ ] Data disclosure warning shown on first run
- [ ] `npm build` produces working binary
- [ ] `npm pack` produces publishable artifact
