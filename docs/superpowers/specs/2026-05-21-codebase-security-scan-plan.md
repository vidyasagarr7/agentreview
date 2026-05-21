# Implementation Plan: Codebase Security Scanner

**Date:** 2026-05-21
**Spec:** `2026-05-21-codebase-security-scan-design.md`
**Branch:** `feat/codebase-security-scan`
**Revision:** v2 — incorporates 10 plan challenge findings

---

## Task Breakdown

Each task is atomic (2-10 min), has exact file paths, and includes verification steps.

---

### Task 1: Scan-specific types (`src/scan/types.ts`)
**Files:** `src/scan/types.ts`
**Intent:** Define all scan-specific TypeScript types and interfaces.
**Content:**
- `SecurityDomain` enum: `auth | secrets | injection | config | deps | crypto | data-flow | general` (Finding 10: add `data-flow`)
- `FileEntry`: `{ path, size, priority: number }`
- `ChunkFile`: `{ path, content, priority, estimatedTokens }`
- `ScanChunk`: `{ id, domain, files, estimatedTokens, focusPrompt }`
- `ScanOptions`: `{ focus?, maxConcurrency, budgetTokens, model?, timeout, validate, verbose, redact }`
- `ChunkResult`: `{ chunkId, domain, findings: AgentFinding[], error?, durationMs }`
- `CoverageEntry`: `{ domain, filesScanned, findings }`
- `ScanResult`: `{ target, branch, scannedAt, filesDiscovered, filesScanned, filesSkipped, chunks, findings, stats, coverage }`
- `ScanProgressCallback` type
- `SourceReader` interface: `{ listFiles(), readFile(path), cleanup?() }`
**Verification:** `npx tsc --noEmit` passes

---

### Task 2: Filesystem sandboxing — LocalSourceReader (`src/scan/local-reader.ts`)
**Files:** `src/scan/local-reader.ts`, `src/scan/local-reader.test.ts`
**Intent:** Implement sandboxed local filesystem reader.
**Tests first (RED):**
- Reads regular file within root → returns content
- Rejects symlink pointing outside root → returns null
- Rejects `../../../etc/passwd` path traversal → returns null
- Skips non-regular files (directories, device files) → returns null
- Skips files > 100KB → returns null
- `listFiles()` returns all files recursively, excluding skip patterns
- Filters out `node_modules/`, `.git/`, `dist/`, binary extensions
**Implementation:**
- `realpath`-based jail enforcement
- `lstat` check for regular files
- Recursive directory walk with skip patterns
- Size check before read
**Verification:** All tests pass, `npx tsc --noEmit` passes

---

### Task 3: Shallow clone helper (`src/scan/clone.ts`)
**Files:** `src/scan/clone.ts`, `src/scan/clone.test.ts`
**Intent:** Clone remote repos locally for scanning.
**Tests first (RED):**
- Parses GitHub URL → extracts owner/repo
- Creates temp directory and calls `git clone --depth 1`
- Supports `--branch <ref>` for specific branch/tag
- `cleanup()` removes temp directory
- Handles clone failure gracefully (bad URL, private repo without auth)
- **Authenticated clone:** when `GITHUB_TOKEN` available, rewrites URL to `https://x-access-token:TOKEN@github.com/owner/repo.git` (Finding 8)
- Test: authenticated URL construction produces correct format
**Implementation:**
- `child_process.execFile('git', ['clone', '--depth', '1', ...])` with timeout
- Token injection: if token available, use authenticated URL for private repo support
- Return a `LocalSourceReader` pointed at the cloned directory
- Temp dir via `fs.mkdtemp()`
**Verification:** All tests pass (mock `execFile` for unit tests)

---

### Task 4: File discovery & priority classification (`src/scan/discovery.ts`)
**Files:** `src/scan/discovery.ts`, `src/scan/discovery.test.ts`
**Intent:** Filter files and classify into security priority tiers.
**Tests first (RED):**
- P0 classification: `src/auth/middleware.ts` → P0, `lib/jwt.ts` → P0
- P1 classification: `.env.production` → P1, `Dockerfile` → P1, `.github/workflows/deploy.yml` → P1
- P2 classification: `src/routes/api.ts` → P2, `src/controllers/users.ts` → P2
- P3 classification: `src/models/user.ts` → P3
- P4 classification: `test/auth.test.ts` → P4
- Skip rules: `node_modules/foo.js` → skipped, `dist/bundle.min.js` → skipped
- Domain classification: file → SecurityDomain mapping
**Implementation:**
- `classifyPriority(path: string): number` — regex-based tier assignment
- `classifyDomain(path: string, content?: string): SecurityDomain` — domain assignment
- `discoverFiles(reader: SourceReader, focus?: SecurityDomain[]): Promise<ClassifiedFile[]>` — main entry
**Verification:** All tests pass

---

### Task 5: Token estimation + chunking (`src/scan/chunker.ts`)
**Files:** `src/scan/chunker.ts`, `src/scan/chunker.test.ts`
**Intent:** Group classified files into LLM-sized scan chunks by security domain.
**Tests first (RED):**
- Token estimation: `estimateTokens("hello world")` → 3 (11 chars / 4)
- Budget enforcement: chunks don't exceed budget × 0.85
- Domain grouping: auth files go in auth chunks, secrets files in secrets chunks
- Priority ordering: within a chunk, P0 files come before P4
- Large file truncation: 200KB file → head+tail truncation within budget
- Multi-chunk domain: 50 auth files that exceed budget → split into auth-001, auth-002
- Focus filtering: `--focus auth,secrets` → only auth and secrets chunks
**Implementation:**
- `estimateTokens(text: string): number` — `Math.ceil(text.length / 4)`
- `truncateFile(content: string, budgetTokens: number): string` — head+tail
- `chunkFiles(files: ClassifiedFile[], options: ChunkOptions): ScanChunk[]` — main entry
**Verification:** All tests pass

---

### Task 6: Security scan prompts (`src/scan/prompts.ts`)
**Files:** `src/scan/prompts.ts`, `src/scan/prompts.test.ts`
**Intent:** Domain-specific system prompts for each security domain.
**Tests first (RED):**
- Each domain has a non-empty system prompt
- Auth prompt contains OWASP references (A01, A07)
- Secrets prompt mentions known key patterns (AKIA, ghp_)
- All prompts instruct JSON array output format (same as existing lens format)
- `buildScanPrompt(chunk: ScanChunk)` returns `{ system, user }` with file contents embedded
- **parseFindings compatibility test** (Finding 7): mock a realistic LLM response to a scan prompt, pass through `parseFindings()`, verify it parses correctly
**Implementation:**
- One prompt constant per domain (7 domains: auth, secrets, injection, config, deps, crypto, data-flow + general fallback)
- `buildScanPrompt(chunk: ScanChunk): { system: string; user: string }` — assembles system prompt + file contents as user prompt
- User prompt includes: file list, file contents with line numbers, repo/branch metadata
**Verification:** All tests pass

---

### Task 7: Secret redaction (`src/scan/redact.ts`)
**Files:** `src/scan/redact.ts`, `src/scan/redact.test.ts`
**Intent:** Mask known secret patterns before LLM transmission.
**Tests first (RED):**
- AWS key `AKIA1234567890ABCDEF` → `[REDACTED_AWS_KEY]`
- GitHub token `ghp_abc123...` → `[REDACTED_GH_TOKEN]`
- OpenAI key `sk-abc123...` → `[REDACTED_OPENAI_KEY]`
- Private key block → `[REDACTED_PRIVATE_KEY]`
- Connection string `postgres://user:pass@host/db` → `[REDACTED_CONN_STRING]`
- Non-secret content passes through unchanged
- Redaction count is returned for reporting
**Implementation:**
- `redactSecrets(content: string): { redacted: string; count: number }`
- Array of `{ name, regex, replacement }` patterns
**Verification:** All tests pass

---

### Task 8: Scan-specific cross-chunk dedup (`src/scan/dedup-scan.ts`)
**Files:** `src/scan/dedup-scan.ts`, `src/scan/dedup-scan.test.ts`
**Intent:** Deduplicate findings across scan chunks using location-proximity and domain-aware merging.
**Tests first (RED):**
- Same file, same line, same severity across 2 chunks → merged into 1 finding
- Same file, ±5 lines, similar category → merged, keep highest severity
- Same file, different severity, same category across domains → merged
- Findings in different files → NOT merged
- Findings in same file but different categories → NOT merged
- Merged findings track all source domains
**Implementation:**
- `dedupScanFindings(chunkResults: ChunkResult[]): AgentFinding[]`
- Location-proximity: parse `file:line` from finding.location, group by file, merge within ±5 lines + same category
- Cross-domain: same file + similar summary → merge using inline token overlap similarity (Finding 5: self-contained, do NOT import from `dedup.ts` — implement `tokenOverlap` locally in this module to avoid export dependency)
**Verification:** All tests pass

---

### Task 9: Scan orchestrator (`src/scan/orchestrator.ts`)
**Files:** `src/scan/orchestrator.ts`, `src/scan/orchestrator.test.ts`
**Intent:** Coordinate the full scan pipeline: resolve source → discover → chunk → dispatch → dedup → validate → report.
**Tests first (RED):**
- Full pipeline with mocked LLM → returns ScanResult with expected shape
- Respects maxConcurrency (only N chunks dispatched in parallel)
- Handles chunk-level LLM failure gracefully (other chunks still complete)
- Progress callback fired for each chunk start/complete/fail
- Redaction applied when option set
- Focus filtering respects --focus option
- Cleanup called on clone-based readers (even on error)
**Implementation:**
- `scanCodebase(target: string, options: ScanOptions, llm: LLMClient): Promise<ScanResult>`
- Uses `p-limit` for concurrency control (Finding 2: committed to p-limit, NOT manual semaphore)
- Dispatches each chunk by calling `llm.complete()` with `buildScanPrompt()` output and `maxTokens: 8192` (Finding 1: scan chunks produce more findings than PR lenses)
- Parses findings via existing `parseFindings()`
- Applies `dedupScanFindings()`
- Optionally runs validation (reuse existing `validateAgentResults`)
- Builds coverage report + stats
**Verification:** All tests pass

---

### Task 10: Scan report renderer (`src/scan/renderer.ts`) — STANDALONE (Finding 6)
**Files:** `src/scan/renderer.ts`, `src/scan/renderer.test.ts`
**Intent:** Render scan results as markdown or JSON. This is a **standalone renderer**, NOT extending the existing `src/report/renderer.ts` (which operates on `ConsolidatedReport` for PR reviews). Scan reports have different structure (coverage tables, hotspots, domain breakdown).
**Tests first (RED):**
- Markdown output includes: title, risk posture table, coverage table, hotspots, findings
- JSON output includes all ScanResult fields
- Empty findings → "✅ No security issues found" message
- Hotspots sorted by severity then count
- **Regression guard:** existing PR markdown renderer (`src/report/renderers/markdown.ts`) still produces correct output (run existing tests)
**Implementation:**
- `renderScanReport(result: ScanResult, format: 'markdown' | 'json'): string`
- Markdown: header → risk posture table → coverage table → top 10 hotspots → findings (standard format)
- JSON: serialize full ScanResult
**Verification:** All tests pass + existing report tests pass

---

### Task 11: Enhanced data disclosure (`src/cli/disclosure.ts`)
**Files:** `src/cli/disclosure.ts`
**Intent:** Add scan-specific disclosure prompt alongside existing PR disclosure.
**Tests first (RED):** (update existing `disclosure.test.ts` if present, else create)
- `checkScanDisclosure(acknowledged, yes, { fileCount, provider, model, focus })` shows scan-specific warning
- Secrets focus triggers additional credential warning
- `--yes` flag bypasses prompt
**Implementation:**
- Add `checkScanDisclosure()` function (keep existing `checkDataDisclosure()` intact)
- Scan-specific warning text per spec section 5.6
**Verification:** Existing PR disclosure tests still pass + new scan tests pass

---

### Task 12a: CLI command skeleton — `agentreview scan` (`src/cli/commands/scan.ts`) (Finding 3: split)
**Files:** `src/cli/commands/scan.ts`
**Intent:** Basic CLI subcommand with argument parsing, config resolution, progress display, stdout/file output.
**Implementation:**
- Commander subcommand with all options from spec section 3 (EXCEPT `--ensemble` — descoped, Finding 4)
- Resolve target: GitHub URL → clone; local path → LocalSourceReader
- Config resolution (same pattern as main review command)
- Progress spinners using `ora` (same pattern as main command)
- Call `scanCodebase()` → render → stdout or `--output <file>`
- `--fail-on` support: exit code 2 logic (same as main command)
**Verification:** `npx tsc --noEmit` passes, `node dist/cli/index.js scan --help` shows correct options

---

### Task 12b: `--issue` support for scan CLI (Finding 3: split)
**Files:** `src/cli/commands/scan.ts` (extend)
**Depends on:** Task 13 (`createIssue()` on GitHubClient)
**Intent:** Add `--issue` flag to post scan results as a GitHub Issue.
**Implementation:**
- Parse target URL for owner/repo (or require explicit `--repo` for local scans)
- Create issue with severity-based labels
- Truncate body if >65K chars (GitHub limit)
**Verification:** `npx tsc --noEmit` passes

---

### Task 13: Register scan command + GitHubClient extensions
**Files:** `src/cli/index.ts`, `src/github/client.ts`
**Intent:** Wire scan command into main CLI, add `getDefaultBranch()` and `createIssue()` to GitHubClient.
**Note:** Must complete BEFORE Task 12b (Finding 3: ordering fix)
**Implementation:**
- `src/cli/index.ts`: `program.addCommand(createScanCommand())`
- `src/github/client.ts`: add `getDefaultBranch(owner, repo)` and `createIssue(owner, repo, title, body, labels?)`
**Verification:** `agentreview scan --help` works, `npx tsc --noEmit` passes

---

### Task 13b: LLMClient `maxTokens` override (`src/llm/client.ts`) (Finding 1: NEW)
**Files:** `src/llm/client.ts`, `src/llm/client.test.ts`
**Intent:** Allow callers to pass `maxTokens` to `complete()`. Scan mode needs 8192+ vs default 4096.
**Implementation:**
- Add optional `options?: { maxTokens?: number }` parameter to `LLMClient.complete()`
- Anthropic provider: use `options.maxTokens ?? 4096`
- OpenAI provider: pass as `max_tokens` if provided
- Backward compatible: existing callers don't pass options, get default 4096
**Tests:**
- Existing tests still pass (no options = default behavior)
- New test: passing `maxTokens: 8192` uses that value
**Verification:** All existing + new tests pass

---

### Task 14: Public API + index re-export (`src/scan/index.ts`)
**Files:** `src/scan/index.ts`
**Intent:** Clean public API for the scan module.
**Implementation:**
- Export `scanCodebase`, types, `renderScanReport`
**Verification:** `npx tsc --noEmit` passes

---

### Task 15: Test fixture — vulnerable app (`test/fixtures/vulnerable-app/`)
**Files:** `test/fixtures/vulnerable-app/` (multiple files)
**Intent:** Create a small intentionally-vulnerable app for integration testing.
**Content:**
- `src/auth/login.ts`: hardcoded admin password, missing rate limiting
- `src/routes/users.ts`: SQL injection via string concatenation
- `src/config/database.ts`: hardcoded connection string
- `.env`: AWS key + DB password (committed intentionally)
- `Dockerfile`: runs as root
- `package.json`: outdated express version
**Verification:** Files exist, are valid code-like content

---

### Task 16: Integration test — full scan pipeline
**Files:** `src/scan/integration.test.ts`
**Intent:** End-to-end test scanning the vulnerable fixture with mocked LLM.
**Tests:**
- Scan `test/fixtures/vulnerable-app/` → produces findings
- Coverage includes auth, secrets, config, deps domains
- Findings reference correct file locations
- Dedup works across chunks
- Progress callbacks fire
**Verification:** All tests pass

---

### Task 17: Build verification + final checks
**Files:** None (verification only)
**Steps:**
1. `npm run build` — clean build passes
2. `npm test` — all tests pass (existing + new)
3. `npx tsc --noEmit` — no type errors
4. `agentreview scan --help` — correct output
5. Verify existing PR review still works: `agentreview <pr-url> --lenses security -y`
**Verification:** All green

---

## Execution Order (revised per challenge findings)

Tasks can be parallelized in groups:
- **Group 0 (dependencies):** `npm install p-limit` + verify ESM compat with tsup build (Finding 2)
- **Group 1 (foundations):** Tasks 1, 7, 11, 13b (types + redact + disclosure + LLMClient maxTokens — no pipeline dependencies; Finding 9: moved disclosure earlier)
- **Group 2 (readers):** Tasks 2, 3 (local reader + clone — depend on types)
- **Group 3 (pipeline):** Tasks 4, 5, 6 (discovery + chunker + prompts — depend on types + reader)
- **Group 4 (orchestration):** Tasks 8, 9, 10 (dedup + orchestrator + renderer — depend on pipeline)
- **Group 5 (CLI):** Task 13 first, then Tasks 12a, 12b, 14 (wiring → CLI skeleton → --issue → exports)
- **Group 6 (testing):** Tasks 15, 16, 17 (fixtures + integration + verification — depend on everything)

## Descoped from v1 (Finding 4)
- `--ensemble` for scan mode — existing `runEnsemble()` operates on `ReviewContext`/`Lens[]`, incompatible with scan chunks. Will add in a follow-up after the core scan ships.

Total estimated time: 2-3 hours with parallel subagent execution.
