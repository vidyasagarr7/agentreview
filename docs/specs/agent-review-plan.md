# AgentReview — Implementation Plan

> Atomic tasks, each 2–5 minutes. No task produces incomplete state.
> Order within a phase is sequential unless noted as parallelizable.

---

## Phase 0: Project Scaffold
*Get a working, buildable, testable shell before any real logic.*

---

### Task 0.1 — Initialize npm package
**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.nvmrc`

**Produces:**
- `package.json` with name `agentreview`, bin entry pointing to `dist/cli/index.js`
- `tsconfig.json` targeting ES2022, Node16 module resolution
- `.nvmrc` pinned to `20`
- `.gitignore` covering `node_modules`, `dist`

**Verification:** `npm install` completes without errors. `cat package.json | jq .name` returns `"agentreview"`.

**Dependencies:** none

---

### Task 0.2 — Install runtime dependencies
**Files:** `package.json` (updated lock)

**Produces:** `node_modules` with:
- `commander` — CLI parsing
- `@octokit/rest` — GitHub API
- `openai` — LLM calls
- `chalk` — terminal colors
- `conf` — config storage
- `marked` — markdown rendering

**Verification:** `node -e "require('@octokit/rest')"` exits 0.

**Dependencies:** Task 0.1

---

### Task 0.3 — Install dev dependencies + build tooling
**Files:** `package.json`, `tsup.config.ts`, `vitest.config.ts`

**Produces:**
- Dev deps: `typescript`, `tsup`, `vitest`, `@types/node`
- `tsup.config.ts` — builds `src/cli/index.ts` → `dist/cli/index.js` (CJS)
- `vitest.config.ts` — test runner config
- `npm run build` and `npm test` scripts in `package.json`

**Verification:** `npm run build` produces `dist/cli/index.js`. `npm test` runs and exits 0 (no tests yet, just "no test files found").

**Dependencies:** Task 0.2

---

### Task 0.4 — Create directory structure + barrel exports
**Files:** `src/cli/.keep`, `src/github/.keep`, `src/lenses/.keep`, `src/agents/.keep`, `src/llm/.keep`, `src/report/.keep`, `src/types/index.ts`

**Produces:**
- Directory tree matching the design spec
- `src/types/index.ts` — all shared TypeScript interfaces:
  - `PRData`, `ChangedFile`, `Lens`, `ReviewContext`
  - `AgentFinding`, `AgentResult`, `ConsolidatedReport`
  - `ReportFormat`, `CLIOptions`

**Verification:** `npx tsc --noEmit` exits 0. All interfaces are importable.

**Dependencies:** Task 0.3

---

## Phase 1: GitHub API Client

---

### Task 1.1 — PR URL parser
**Files:** `src/github/parse-url.ts`, `src/github/parse-url.test.ts`

**Produces:**
- `parsePRUrl(url: string): { owner: string; repo: string; number: number }` 
- Handles: `https://github.com/owner/repo/pull/123`, `github.com/owner/repo/pull/123`
- Throws `InvalidPRUrlError` for malformed input

**Verification:** Tests pass for valid URLs, invalid URLs, missing PR number.

**Dependencies:** Task 0.4

---

### Task 1.2 — GitHub API client (read operations)
**Files:** `src/github/client.ts`

**Produces:**
- `GitHubClient` class initialized with token
- `getPR(owner, repo, number): Promise<PRData>` — fetches PR metadata
- `getDiff(owner, repo, number): Promise<string>` — fetches unified diff via `Accept: application/vnd.github.diff`
- `getFiles(owner, repo, number): Promise<ChangedFile[]>` — file list with status/stats

**Verification:** Manual smoke test (requires `GITHUB_TOKEN`): `ts-node src/github/client.ts` with a test PR. Review log output confirms PR metadata returned.

**Dependencies:** Task 1.1

---

### Task 1.3 — PR context builder
**Files:** `src/github/context-builder.ts`

**Produces:**
- `buildReviewContext(pr: PRData, diff: string, files: ChangedFile[]): ReviewContext`
- Handles diff truncation: if diff > 100KB, truncate per-file keeping files < 10KB whole; annotate `context.truncated = true`
- Constructs formatted file list string for prompts

**Verification:** Unit test: given a mock PRData + large diff string, `context.truncated === true` and `context.diff.length < 105000`.

**Dependencies:** Task 1.2

---

## Phase 2: Lens Registry

---

### Task 2.1 — Built-in lens definitions
**Files:** `src/lenses/builtin/security.ts`, `src/lenses/builtin/architecture.ts`, `src/lenses/builtin/quality.ts`

**Produces:**
- Three `Lens` objects exported as named constants
- Each has: `id`, `name`, `description`, `systemPrompt`, `focusAreas`, `severity`
- System prompts are full, production-quality (not placeholder)

**Verification:** Import each lens in a test; verify `lens.id`, `lens.systemPrompt.length > 200`.

**Dependencies:** Task 0.4

---

### Task 2.2 — Lens registry
**Files:** `src/lenses/registry.ts`, `src/lenses/registry.test.ts`

**Produces:**
- `LensRegistry` class
- `getBuiltinLenses(): Lens[]` — returns the 3 built-ins
- `loadCustomLenses(dir: string): Promise<Lens[]>` — reads `*.json` from lens dir, validates schema
- `resolveLenses(ids: string[] | 'all'): Lens[]` — filters by ID, throws if unknown ID

**Verification:** Tests confirm: `resolveLenses('all')` returns 3 lenses; `resolveLenses(['security'])` returns 1; `resolveLenses(['unknown'])` throws.

**Dependencies:** Task 2.1

---

## Phase 3: LLM Client

---

### Task 3.1 — LLM client abstraction
**Files:** `src/llm/client.ts`, `src/llm/client.test.ts`

**Produces:**
- `LLMClient` class with config (provider, model, apiKey, timeout)
- `complete(systemPrompt: string, userPrompt: string): Promise<string>` — returns raw LLM response
- Retry logic: 3 attempts, exponential backoff (1s, 2s, 4s) on 429/500/timeout
- Throws `LLMError` with clean message on final failure

**Verification:** Unit test with mocked OpenAI client: confirms retry fires on 429, gives up after 3 failures, throws `LLMError`.

**Dependencies:** Task 0.4

---

### Task 3.2 — Structured response parser
**Files:** `src/llm/parse-findings.ts`, `src/llm/parse-findings.test.ts`

**Produces:**
- `parseFindings(raw: string): AgentFinding[]`
- Tries direct JSON parse first
- Falls back to extracting JSON from markdown code blocks (` ```json ... ``` `)
- Validates each finding has required fields; filters out malformed items
- Returns empty array (not throw) on complete parse failure; logs warning

**Verification:** Tests for: valid JSON array, JSON inside markdown block, completely garbled response (returns `[]`), partial findings (returns valid subset).

**Dependencies:** Task 3.1

---

## Phase 4: Agent Dispatcher

---

### Task 4.1 — Prompt builder
**Files:** `src/agents/prompt-builder.ts`, `src/agents/prompt-builder.test.ts`

**Produces:**
- `buildPrompt(lens: Lens, context: ReviewContext): { system: string; user: string }`
- Injects PR metadata, file list, diff into template
- Includes the JSON output schema instruction in system prompt
- Adds truncation notice to user prompt if `context.truncated === true`

**Verification:** Snapshot test: given fixture `ReviewContext`, output matches expected prompt structure (contains file list, diff, schema instruction).

**Dependencies:** Task 2.2, Task 1.3

---

### Task 4.2 — Agent dispatcher
**Files:** `src/agents/dispatcher.ts`, `src/agents/dispatcher.test.ts`

**Produces:**
- `dispatchAgents(lenses: Lens[], context: ReviewContext, llm: LLMClient): Promise<AgentResult[]>`
- Uses `Promise.allSettled` — all lenses run in parallel
- Per-agent result: `{ lensId, findings, error?, durationMs }`
- Failed agents: `error` set, `findings: []`
- Logs progress when `verbose: true` (start/end per agent)

**Verification:** Unit test with mocked LLM: 3 lenses dispatched, all run concurrently (mock tracks call order), one mocked failure produces result with `error` set and empty findings.

**Dependencies:** Task 4.1, Task 3.2

---

## Phase 5: Report Consolidator

---

### Task 5.1 — Finding deduplicator
**Files:** `src/report/dedup.ts`, `src/report/dedup.test.ts`

**Produces:**
- `deduplicateFindings(results: AgentResult[]): AgentFinding[]`
- Flatten all findings from all lenses
- Tag each finding with `lenses: string[]`
- Detect duplicates via Jaccard similarity on location + summary tokens (threshold: 0.8)
- Merge duplicates: keep highest severity, union lens tags, keep longest `detail`

**Verification:** Tests: two identical findings from different lenses → merged into one with both lens tags; two distinct findings → both kept; severity escalation on merge.

**Dependencies:** Task 0.4

---

### Task 5.2 — Report consolidator
**Files:** `src/report/consolidator.ts`, `src/report/consolidator.test.ts`

**Produces:**
- `consolidate(results: AgentResult[], pr: PRData): ConsolidatedReport`
- Calls deduplicator
- Sorts findings: severity DESC, then lens order, then file path ASC
- Computes summary stats (counts by severity, counts by lens, clean lenses list)
- Sets `confidence: 'LOW'` if any agent errored, otherwise `'NORMAL'`

**Verification:** Given fixture results with mixed severities + one errored agent: sorted order is correct, stats match, confidence is `LOW`.

**Dependencies:** Task 5.1

---

## Phase 6: Report Renderer

---

### Task 6.1 — Markdown renderer
**Files:** `src/report/renderers/markdown.ts`, `src/report/renderers/markdown.test.ts`

**Produces:**
- `renderMarkdown(report: ConsolidatedReport): string`
- Outputs full markdown per design spec (header, summary table, findings by severity, lens notes)
- Each finding includes: severity emoji, lens tag(s), location, summary, detail, suggestion

**Verification:** Snapshot test: given fixture report, output contains expected headers, table, and CRITICAL finding section.

**Dependencies:** Task 5.2

---

### Task 6.2 — JSON renderer
**Files:** `src/report/renderers/json.ts`

**Produces:**
- `renderJSON(report: ConsolidatedReport): string`
- `JSON.stringify(report, null, 2)` — clean, no transformation
- Ensures `ConsolidatedReport` is fully serializable (no circular refs)

**Verification:** `JSON.parse(renderJSON(fixture))` round-trips without error. All fields present.

**Dependencies:** Task 5.2

---

### Task 6.3 — Terminal renderer
**Files:** `src/report/renderers/terminal.ts`

**Produces:**
- `renderTerminal(report: ConsolidatedReport): string`
- Color-coded using `chalk`: CRITICAL=red bold, HIGH=yellow, MEDIUM=cyan, LOW=blue, INFO=gray
- Compact single-line finding format with severity icon
- Summary bar at top: `🔴 2 CRITICAL  🟠 1 HIGH  🟡 3 MEDIUM`
- No markdown syntax (no `##`, no `**`)

**Verification:** Output contains chalk escape codes when `chalk.level > 0`. Human-readable without markdown.

**Dependencies:** Task 5.2

---

### Task 6.4 — Renderer router
**Files:** `src/report/renderer.ts`

**Produces:**
- `render(report: ConsolidatedReport, format: ReportFormat): string`
- Routes to markdown/json/terminal renderer
- Auto-selects `terminal` for TTY stdout, `markdown` for non-TTY (pipes/files)

**Verification:** Given `format: 'json'`, returns valid JSON. Given `format: 'terminal'`, returns colored text.

**Dependencies:** Tasks 6.1, 6.2, 6.3

---

## Phase 7: CLI Entry Point

---

### Task 7.1 — Config manager
**Files:** `src/cli/config.ts`

**Produces:**
- `ConfigManager` class using `conf` package
- `get(key): string | undefined`
- `set(key, value): void`
- Config merge order: env vars > config file > defaults
- `getGitHubToken(): string` — throws `ConfigError` if not set
- `getLLMConfig(): LLMConfig` — resolves provider, model, key

**Verification:** Unit test: env var `GITHUB_TOKEN` overrides config file value.

**Dependencies:** Task 0.4

---

### Task 7.2 — Main CLI wiring
**Files:** `src/cli/index.ts`

**Produces:**
- `commander` program with `agentreview <pr-url>` command + all flags from spec
- Pipeline: parse URL → build GitHub client → fetch PR → build context → resolve lenses → dispatch agents → consolidate → render → output
- `--post` flag: post rendered markdown as GitHub PR comment
- `--fail-on` flag: exit 2 if findings at or above specified severity
- Graceful error handling: catch `ConfigError`, `InvalidPRUrlError`, etc. with user-friendly messages
- `--verbose` mode: show spinner + per-agent progress

**Verification:** `node dist/cli/index.js --help` shows usage. `node dist/cli/index.js https://github.com/org/repo/pull/1 --format json` (with real token) produces JSON report.

**Dependencies:** Tasks 1.2, 2.2, 3.1, 4.2, 5.2, 6.4, 7.1

---

### Task 7.3 — `config` subcommand
**Files:** `src/cli/commands/config.ts`

**Produces:**
- `agentreview config set <key> <value>` — stores to config file
- `agentreview config get <key>` — reads from config (masks token)
- `agentreview config list` — lists all current config (masks sensitive values)

**Verification:** `agentreview config set GITHUB_TOKEN test123` → `agentreview config get GITHUB_TOKEN` returns `test***` (masked).

**Dependencies:** Task 7.1

---

### Task 7.4 — `lenses` subcommand
**Files:** `src/cli/commands/lenses.ts`

**Produces:**
- `agentreview lenses list` — shows built-in + custom lenses with descriptions
- `agentreview lenses add <path-to-json>` — validates + copies lens to `~/.agentreview/lenses/`

**Verification:** `agentreview lenses list` outputs the 3 built-in lenses. `agentreview lenses add ./test-lens.json` with valid JSON copies the file.

**Dependencies:** Task 2.2, Task 7.1

---

## Phase 8: Polish & Publish Prep

---

### Task 8.1 — End-to-end smoke test script
**Files:** `scripts/smoke-test.sh`

**Produces:**
- Shell script that runs against a real public PR (e.g., a known small open-source PR)
- Asserts: exit 0, output contains "AgentReview", JSON format parses cleanly
- Skipped in CI if `GITHUB_TOKEN` or `OPENAI_API_KEY` not set

**Verification:** `./scripts/smoke-test.sh` runs against a real PR and exits 0.

**Dependencies:** Task 7.2

---

### Task 8.2 — README
**Files:** `README.md` (overwrite)

**Produces:**
- Install instructions (`npm install -g agentreview`)
- Quick start (3 commands: install, config set tokens, run on a PR)
- Output example (pasted terminal screenshot or markdown block)
- All flags documented
- Custom lenses section with example
- Contributing section

**Verification:** README renders on GitHub without broken links or malformed markdown.

**Dependencies:** All prior tasks

---

### Task 8.3 — npm publish prep
**Files:** `package.json` (update), `.npmignore`

**Produces:**
- `package.json`: `files` field limiting publish to `dist/`, `src/`, `README.md`
- `.npmignore` excluding `scripts/`, `docs/`, test files
- Verify `npm pack --dry-run` lists only intended files
- Bump version to `0.1.0`

**Verification:** `npm pack --dry-run` output lists `dist/`, `README.md`, does NOT list test files or `docs/`.

**Dependencies:** Task 8.2

---

## Task Dependency Graph (summary)

```
0.1 → 0.2 → 0.3 → 0.4
                     ├─→ 1.1 → 1.2 → 1.3
                     ├─→ 2.1 → 2.2
                     └─→ 3.1 → 3.2

1.3 + 2.2 → 4.1 → 4.2 (needs 3.2)
4.2 → 5.1 → 5.2 → 6.1,6.2,6.3 → 6.4

6.4 + 1.2 + 2.2 + 3.1 + 4.2 + 5.2 + 7.1 → 7.2
7.1 → 7.3, 7.4

7.2 → 8.1 → 8.2 → 8.3
```

---

## Estimated Timeline

| Phase | Tasks | Estimated Time |
|-------|-------|---------------|
| Phase 0: Scaffold | 4 tasks | ~20 min |
| Phase 1: GitHub Client | 3 tasks | ~20 min |
| Phase 2: Lenses | 2 tasks | ~15 min |
| Phase 3: LLM Client | 2 tasks | ~15 min |
| Phase 4: Dispatcher | 2 tasks | ~15 min |
| Phase 5: Consolidator | 2 tasks | ~15 min |
| Phase 6: Renderer | 4 tasks | ~20 min |
| Phase 7: CLI | 4 tasks | ~30 min |
| Phase 8: Polish | 3 tasks | ~20 min |
| **Total** | **26 tasks** | **~2.5 hours** |

---

## Definition of Done (v1)

- [ ] `agentreview <pr-url>` runs end-to-end with real GitHub PR
- [ ] All 3 built-in lenses produce findings (or clean) for a non-trivial PR
- [ ] `--format json` output passes `JSON.parse()`
- [ ] `--post` posts a comment to the PR
- [ ] `--fail-on HIGH` exits 2 when HIGH findings exist
- [ ] All unit tests pass (`npm test`)
- [ ] Smoke test passes against a real PR
- [ ] `npm pack` produces publishable artifact
