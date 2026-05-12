# AgentReview — Adversarial Design & Plan Review

> **Reviewer:** Senior Staff Engineer (adversarial lens)
> **Date:** 2026-05-12
> **Verdict:** Conditionally sound, but several critical assumptions will fail in production. Don't ship Phase 8 until the issues below are addressed.

---

## 1. Architecture Gaps

### 1.1 No Rate Limiting on Either End
The design mentions GitHub rate limits in the error handling section (403 → "show reset time") but has **zero implementation for it**. GitHub's REST API is 5,000 req/hr for authenticated users, but secondary rate limits exist for concurrent reads. Running `Promise.allSettled` across 3+ agents all hitting GitHub simultaneously could trigger secondary limits on large org setups. No mention of this anywhere in Tasks 1.1–1.3 or 4.2.

Outbound LLM calls have the same problem. Three parallel `openai.chat.completions.create()` calls could trigger OpenAI's per-minute RPM limits, especially on `gpt-4o` where limits are tighter than most users expect. The retry logic in Task 3.1 fires *per agent* after the fact — there's no global semaphore or queue to prevent thundering herd.

### 1.2 No Caching of Any Kind
The Non-Goals list explicitly calls out caching. Fine for v1 *if* users understand the cost implication: every single run re-fetches the PR diff and re-calls 3 LLMs. A developer running this twice on the same PR (say, after tweaking a custom lens) pays double. There's no content-addressed cache, no "last-run" file, nothing. At $0.02/1K tokens on gpt-4o input, a 100KB diff reviewed 3x costs real money per run. **This will cause user complaints within the first week.** Even a simple `.agentreview-cache/` directory with SHA-keyed results would save this.

### 1.3 GitHub API Pagination is Unhandled
Task 1.2 creates `getFiles()` which returns `ChangedFile[]`. The GitHub Files API paginates at 300 files per page by default. PRs in monorepos routinely exceed this. The Octokit `paginate()` helper handles this, but the task spec says nothing about it. As written, any PR touching >300 files silently returns an incomplete file list with no error or warning. This is a silent data loss bug.

### 1.4 LLM Context Window is Ignored
The design handles diff truncation at 100KB, but the actual constraint is **tokens**, not bytes. A 100KB diff can be anywhere from ~25K to ~100K tokens depending on file type (minified JS = fewer tokens, verbose YAML = more). GPT-4o has a 128K context window. Subtract the system prompt (~1K tokens), the PR metadata and file list (~2K), the output schema instruction (~500), and you're left with ~124K for the diff. That's fine today. But if a user switches to a smaller model (gpt-3.5-turbo at 16K context) via `--model`, the tool will hard-fail at the API level with no graceful handling. The truncation logic in Task 1.3 must be token-aware, not byte-aware.

### 1.5 No Timeout on the Entire Pipeline
Task 4.2 mentions a per-agent timeout (default 60s, configurable), but there's no wall-clock timeout on the full run. If all 3 agents hang at exactly 59s, the user waits 3 minutes for nothing. A `--max-wait` flag or a top-level `AbortController` with a sensible default (e.g., 3 minutes) is missing.

### 1.6 Single LLM Provider is a Single Point of Failure
The LLM client abstraction (Task 3.1) is designed to support multiple providers, but the implementation only ships OpenAI. OpenAI has outages. Teams with Anthropic API keys have no fallback. The abstraction is there; the alternative provider is explicitly blocked out to v1. This is fine architecturally, but the error message when OpenAI is down should at least say "You can configure an Anthropic fallback with `agentreview config set LLM_PROVIDER anthropic`" — even if that path doesn't work yet, it sets expectations correctly.

---

## 2. Bad Assumptions

### 2.1 LLMs Will Reliably Return Valid JSON
Task 3.2 (`parseFindings`) handles "JSON inside markdown code blocks" as its only fallback. This dramatically underestimates the failure modes:

- LLMs return prose followed by JSON (e.g., "Here are my findings: ```json [...]```")
- LLMs return JSON with trailing commas (common, invalid JSON)
- LLMs return JSON with single quotes instead of double quotes
- LLMs include `//` comments in JSON
- LLMs return a JSON *object* instead of array (e.g., `{ "findings": [...] }`)
- LLMs add a preamble like "Based on my analysis..." before the JSON array
- The response gets cut off mid-array due to max_tokens limits

Each of these needs a distinct handling path. "Returns `[]` on complete parse failure" is not acceptable UX — it silently produces a "clean" lens report when the lens actually errored. **This is worse than surfacing the error.** A user trusting a CRITICAL-free security report where security actually returned garbled JSON is a real-world security incident waiting to happen.

### 2.2 Jaccard Similarity Will Catch Semantic Duplicates
It won't. Jaccard on unigrams works for near-exact duplicates. Two agents finding the same SQL injection vulnerability but phrasing it differently will not be deduplicated:

- Security: "Unsanitized user input in `db.query()` at `routes/user.ts:45`"
- Quality: "Missing input validation in database call at `routes/user.ts:45`"

Token overlap here is low (maybe 0.3–0.4). Both make it through. The user sees what looks like two findings, doesn't realize they're the same issue, and the report looks noisy. The 0.8 threshold was pulled from thin air — no empirical basis is cited. **In practice this dedup will be nearly useless except for findings with identical wording.**

The correct solution is embedding-based semantic similarity (e.g., `text-embedding-ada-002`). Yes, it adds cost and complexity. But if dedup is in the design as a value-add feature, it needs to actually work.

### 2.3 100KB is a Meaningful Truncation Threshold
100KB is an arbitrary byte limit with no relationship to:
- LLM context windows (should be token-based)
- PR complexity (a 200KB diff of documentation changes is less important than a 20KB diff changing authentication logic)
- File prioritization (which 100KB do you keep? The design says "keep files < 10KB whole" but doesn't address what gets *dropped* or in what order)

A PR that adds 50 small config files and modifies one critical `auth.ts` will truncate in ways that may drop `auth.ts` entirely if it happens to be at the end of the file list. There's no priority ordering by file criticality (e.g., prefer files with `auth`, `security`, `token`, `password` in their names).

### 2.4 2.5 Hour Estimate Is Optimistic by 3–5x
This estimate assumes:
- Prompt engineering works on the first try (it never does)
- JSON parsing handles all edge cases quickly (see §2.1 above)
- No debugging time for LLM weirdness
- No iteration on the 3 built-in lens prompts (Task 2.1 says "production-quality" — that alone is a full day of tuning)
- No time for actually running the tool on real PRs and finding it gives garbage output

A realistic estimate for a senior engineer: **2–3 days**. For an AI agent executing these tasks: likely 4–6 hours of wall time, with several iteration loops on prompt quality and JSON parsing robustness.

### 2.5 Custom Lens Loading is a Security Invariant
The spec says custom lenses are loaded from `~/.agentreview/lenses/*.json`. JSON is data, so this is fine. But Task 2.2 says "validates schema." The validation in `loadCustomLenses()` is not specified. If validation is loose, a malformed lens with an enormous `systemPrompt` could cause LLM cost explosion. If someone adds a lens that injects prompt injection payloads into the system prompt, this tool becomes a vector for attacking the LLM pipeline itself.

---

## 3. Over-Engineering for v1

### 3.1 Jaccard Dedup at All
As noted above, it doesn't work well. More importantly: **duplicates are not a real problem in v1**. With 3 lenses on a typical PR, you might get 5–15 findings total. Even if 2 overlap, the user can see that. Premature dedup optimization at the cost of incorrect dedup is strictly worse than no dedup. Recommend: remove dedup from v1, add `--no-dedup` flag (which becomes `--dedup` in v2 when it actually works).

### 3.2 The `conf` Package for Config
`conf` is an XDG-compliant config storage abstraction — solid library, but heavyweight for what's needed here. The tool could read from a single `~/.agentreview.json` using plain `fs.readFileSync`/`JSON.parse` with a 20-line wrapper. Task 7.1 adds a full `ConfigManager` class as a dependency of most of the codebase. This abstraction layer will cause problems when you want to unit test any component that needs config (you now need to mock `conf`).

### 3.3 `agentreview config set/get/list` Subcommand
Storing API keys via `agentreview config set GITHUB_TOKEN ghp_...` types the token into your shell history. The correct pattern for credentials is environment variables. The config subcommand adds surface area and a false sense of security. Environment variables are sufficient for v1. The `agentreview lenses list/add` subcommand is fine (it manages non-secret data).

### 3.4 Terminal Renderer (Task 6.3)
Nice-to-have, not v1 material. Markdown renders fine in any terminal that supports it (iTerm2, Warp, VS Code integrated terminal). The `chalk` dependency is added just for this. If the tool is being piped to CI (a primary use case given the `--fail-on` flag), terminal colors are stripped anyway. **Do markdown first, add terminal renderer in v2.**

### 3.5 Phase 8 Polish as Its Own Phase
`npm publish prep` in "Polish" is fine. But the README (Task 8.2) should be written incrementally as other tasks complete, not deferred to the end. A README written after the fact reflects the spec, not the actual behavior.

---

## 4. Under-Engineering

### 4.1 Retry Logic is One Task (Task 3.1)
Retry logic for LLM calls involves:
1. Distinguishing retryable errors (429, 500, 503, timeout) from non-retryable ones (400 bad request, 401 auth failure, 404 model not found)
2. Exponential backoff with jitter (not just fixed intervals)
3. Respecting `Retry-After` headers from OpenAI 429 responses
4. Context-aware retry: if the failure is "response too long," retrying with the same prompt won't help — need to reduce context first
5. Per-agent retry state (don't let one agent's retry delay block others)
6. Surfacing partial retry attempts in `--verbose` output

This is 2–3 tasks minimum, not one.

### 4.2 Prompt Engineering is Not a Task at All
Task 4.1 is "prompt builder" — it builds prompts programmatically. But the *quality* of the prompts in Tasks 2.1 (built-in lens definitions) and 4.1 (JSON schema instruction) will determine 80% of the tool's usefulness. The spec says "System prompts are full, production-quality (not placeholder)" as a verification for Task 2.1. But there are no iterations, no evaluation criteria, no examples of what good vs. bad output looks like. 

In practice: you'll write the security lens prompt, run it on a real PR, get mediocre results, spend 2 hours tuning it, and then realize the JSON output instruction conflicts with the lens persona. This is the highest-risk part of the entire project and it gets one task.

### 4.3 Testing Strategy is Smoke-Test Only
Vitest is listed in deps but appears in the plan mostly as "unit test with mocked X" assertions. There are no integration tests, no test fixtures of real PR diffs, no evaluation of finding quality. The smoke test in Task 8.1 is against "a known small open-source PR" — this will pass even if the report output is garbage, as long as it exits 0 and outputs *something*.

**Missing tests that matter:**
- Property-based tests for the JSON parser (Task 3.2) with random LLM-like output strings
- Contract test: the `AgentFinding` type matches the JSON schema actually sent to the LLM
- Regression test: a fixture PR diff with known security issues → security lens produces at least one HIGH+ finding
- Rendering round-trip: JSON output can be re-parsed and re-rendered to markdown deterministically

### 4.4 `--post` Flag Under-Scoped
Task 7.2 mentions `--post` as "post rendered markdown as GitHub PR comment." Issues not addressed:
- GitHub PR comments have a size limit (~65,536 characters). A large report will fail silently or get truncated.
- Should `--post` update an existing AgentReview comment (idempotent) or always create a new one? Re-running the tool will spam the PR timeline with duplicate bot comments.
- The comment body includes the full report. For a PR with 20 findings, this is a wall of text. No truncation or "top 5 findings" summary mode.
- `getFiles()` in Task 1.2 already has a `postComment()` stub — good — but the behavior isn't designed.

### 4.5 Progress Feedback is `--verbose` Only
Task 4.2 mentions "Logs progress when `verbose: true`." But for a tool that takes 15–60 seconds to complete, **silent running is terrible UX even without `--verbose`**. Users will assume the tool crashed. A minimal progress indicator (spinner via `ora`, or even just `console.error('Dispatching agents...')` to stderr) should be on by default. Verbose mode can add per-agent timing details.

---

## 5. Security Concerns

### 5.1 Custom Lens Code Execution (Future Attack Vector)
Current spec: custom lenses are JSON files with a `systemPrompt` string. Good — no code execution. But the spec's long-term vision ("marketplace of community-contributed lenses") implies future loading of JavaScript modules. The architecture needs to call this out explicitly: **lenses are data forever, not code.** If custom code execution is ever added, it needs sandboxing (VM2, isolated-vm, or Worker threads with restricted permissions). Document this constraint now before someone adds `require()` support in a PR.

### 5.2 API Keys in Config File
Task 7.1 uses `conf` to store config in `~/.agentreview/config.json`. If this file contains `GITHUB_TOKEN` and `OPENAI_API_KEY`, it's a plaintext credential store. On a shared machine or in a leaked dotfiles repo, this is a credential exposure vector. The tool should:
1. Never write API keys to the config file (use env vars for secrets)
2. Or use OS keychain integration (node-keytar)
3. At minimum: warn on `config set GITHUB_TOKEN` that this stores the token in plaintext

Task 7.3 shows `agentreview config get GITHUB_TOKEN` returns masked output (`test***`). If you're masking it on read, the key is stored — this design has already committed to storing secrets in plaintext.

### 5.3 PR Diff Sent to Third-Party LLM — No Warning
The tool sends your private PR diff to OpenAI (or another provider) without any disclosure. For enterprise teams with data residency requirements, HIPAA obligations, or IP sensitivity, this is a blocker. The tool should print a one-time acknowledgment:

```
⚠️  AgentReview sends your PR diff to OpenAI for analysis.
    Review OpenAI's data policy: https://openai.com/policies/api-data-usage-policies
    Run with --acknowledge-data-policy to skip this prompt.
```

This is also a legal/compliance requirement in some jurisdictions.

### 5.4 Shell History Exposure
`agentreview config set GITHUB_TOKEN ghp_abc123` types the token verbatim into the shell. This is stored in `~/.bash_history`, `~/.zsh_history`, etc. Users routinely paste shell history into Slack, bug reports, etc. The `config set` command should accept token values from stdin when the value is `-`:

```
echo $GITHUB_TOKEN | agentreview config set GITHUB_TOKEN -
```

Or just not accept tokens via config at all and insist on env vars.

### 5.5 Secrets in PR Diffs Forwarded to LLM
A PR that accidentally commits then removes an API key still has that key in its diff. The tool will cheerfully forward it to OpenAI. There's no pre-send scan for common secret patterns (the same patterns that tools like `trufflehog` or `gitleaks` use). At minimum: warn if the diff appears to contain common secret patterns before sending.

---

## 6. Developer Experience Issues

### 6.1 No Cost Estimate Before Running
For a 500-line diff with 3 lenses on gpt-4o: ~$0.10–0.50 per run. For a large PR (2000 lines), this can hit $2–5. There's no `--dry-run` flag that shows:
```
Would dispatch 3 agents (security, architecture, quality)
Estimated tokens: ~45,000 input, ~3,000 output
Estimated cost: ~$0.25 (gpt-4o pricing)
Run with --confirm to proceed.
```
This is table stakes for any tool that burns API credits.

### 6.2 No `--list-lenses` or `agentreview lenses list` Discovery
Task 7.4 adds `agentreview lenses list` as a subcommand. But from the primary command: if a user passes `--lens fhir-compliance` and that lens doesn't exist, the error message is just "Unknown lens: fhir-compliance." There's no suggestion of available lenses. The UX should be:
```
Error: Unknown lens 'fhir-compliance'. Available lenses: security, architecture, quality
```

### 6.3 `--fail-on` Ambiguity
`--fail-on HIGH` exits with code 2 if there are HIGH or above findings. But what if 2 of 3 agents fail entirely (errored, not findings)? The tool exits 0 because no HIGH findings were found — but the review was incomplete. This is a CI false negative. **If any agent errors, the tool should exit 1 by default, regardless of `--fail-on`.**

### 6.4 Non-TTY Auto-Detection is Fragile
Task 6.4: "Auto-selects `terminal` for TTY stdout, `markdown` for non-TTY." This is sensible in principle but breaks in:
- VS Code integrated terminal (reports as TTY but user wants markdown)
- Scripts that capture stdout with process substitution
- CI systems that allocate a PTY (GitHub Actions with `tty: true`)

The auto-detection should be a fallback, not the default. Default to `terminal` when TTY, but document that `--format markdown` is recommended for CI pipelines regardless.

### 6.5 GitHub Enterprise is Absent
The spec says GitHub Enterprise is a non-goal. Fine. But the URL parser (Task 1.1) handles `github.com/owner/repo/pull/123` only. When a GHE user tries `https://github.mycompany.com/org/repo/pull/456`, they get "Invalid PR URL" with no explanation of why or whether GHE is planned. Document the limitation in the error message.

### 6.6 No Way to Resume a Partial Run
If 2 of 3 agents complete before the third times out, you get a partial report and have to re-run everything. A `--resume` flag that uses a local temp file to cache completed agent results would eliminate this. Not v1 material necessarily, but the architecture should not preclude it (i.e., don't structure the pipeline so that partial results can't be stored).

---

## 7. Implementation Risks

### Task 2.1 (Built-in Lens System Prompts) — Severely Underestimated
**Stated estimate:** ~3 minutes of a 15-minute phase.

Producing *production-quality* system prompts for 3 distinct review lenses requires:
- Tuning the JSON output schema instruction so findings have useful `location` and `suggestion` fields
- Calibrating severity so the security lens doesn't call every `console.log` a CRITICAL
- Testing on 5–10 diverse PRs to validate signal quality
- Iterating on false positive rates

This is a **2–4 hour task** for an experienced prompt engineer. An AI agent doing it blindly will produce prompts that work syntactically but produce low-signal output. The 2.5-hour total estimate for the entire project doesn't have room for this.

### Task 3.2 (Structured Response Parser) — 1 Task → 3 Tasks
The failure modes for LLM JSON parsing are enumerated above in §2.1. The current spec's "return `[]` on complete parse failure" behavior is a silent data loss bug that could mask serious security findings. This needs:
- Task 3.2a: JSON extraction with fallback chain (direct → code fence → regex → fail loud)
- Task 3.2b: Finding schema validation with partial recovery
- Task 3.2c: Max_tokens detection and graceful truncation handling

### Task 4.1 (Prompt Builder) — Snapshot Tests Are Insufficient
The "snapshot test" for prompt builder will lock in whatever output the builder produces on day 1, even if that output is suboptimal. Snapshot tests are useful for regression, not correctness. The prompt builder needs behavioral tests: does the output include the PR title? Does truncation notice appear when `context.truncated === true`? Does the JSON schema appear in the system prompt? These are point tests, not snapshots.

### Task 5.1 (Jaccard Dedup) — Tokenization Strategy Unspecified
"Jaccard similarity on unigrams" leaves critical questions open:
- What is a token? Whitespace-split words? Lowercase? Punctuation stripped?
- How are code identifiers handled? `getUserById` → one token or three?
- Are stop words removed? ("the", "a", "in", "at")
- What's the token set for `location`? File path split by `/`? By `.`?

Without specifying this, two implementations of this task will produce different dedup results. The 0.8 threshold may be correct for one tokenization and wildly wrong for another.

### Task 7.2 (Main CLI Wiring) — Largest Single Task in the Plan
This task assembles the entire pipeline. It has 8 dependencies (Tasks 1.2, 2.2, 3.1, 4.2, 5.2, 6.4, 7.1) and includes `--post`, `--fail-on`, `--verbose` spinner, and graceful error handling for multiple error types. The verification step says "runs with real token + real PR." This is essentially an integration test.

This task should be split into:
- Task 7.2a: Pipeline wiring (URL → fetch → dispatch → consolidate → render → stdout)
- Task 7.2b: `--post` flag and GitHub comment posting
- Task 7.2c: `--fail-on` exit code logic and error handling

### Task 8.1 (Smoke Test) — Fragile by Design
Testing against a "known small open-source PR" will:
1. Fail if that PR gets closed/merged and the repo deletes it
2. Produce different results as the LLM model changes
3. Be nondeterministic (LLMs are stochastic)

Use a fixture-based integration test instead: record the GitHub API responses and LLM responses for a specific PR, replay them deterministically. This is what VCR-style testing (nock, msw, polly.js) enables.

---

## 8. Missing Edge Cases

### 8.1 Empty Diff
A PR with only file renames or only binary file changes produces an empty or near-empty unified diff. The tool should short-circuit with "No reviewable text changes found" rather than sending agents a diff containing only `Binary files a/image.png and b/image.png differ`.

### 8.2 LLM Returns Findings for Files Not in the Diff
LLMs occasionally hallucinate file names and line numbers that don't exist in the diff (e.g., they "recall" similar code from training data). There's no validation that `finding.location` references an actual file in `context.files`. A hallucinated `src/auth/bypass.ts:100` finding would appear in the report as a real finding. Add a validation step in the consolidator.

### 8.3 GitHub API Returns Draft PR Without Warning
The spec mentions "Warn but continue" for draft PRs. But the warning is buried in the error handling section. A developer who sets up `--fail-on HIGH` in CI on a branch that creates draft PRs will get unexpected exits. The warning should be prominent and the `--allow-draft` flag explicit.

### 8.4 PR with 0 Findings Across All Lenses
The report format assumes there are findings to render. The "clean" case (`[]` from all agents) should produce a celebratory summary, not an empty findings section that looks like a broken report.

### 8.5 `--post` on a PR with Existing AgentReview Comment
Running `agentreview --post` twice on the same PR creates two comments. Most users will re-run after fixing issues. The tool should search for an existing comment from the same token's user, update it if found, and only create if not found. This is straightforward with Octokit but requires a list-comments API call that's not in the current client design.

### 8.6 LLM Model Not Available in Region
Some OpenAI models are region-restricted. If a user in the EU tries to use `gpt-4o` without enabling it in their account, they get a 404 model not found error. The error message should suggest trying `gpt-4-turbo` or checking model availability.

### 8.7 Unicode and Non-ASCII in Diffs
Diffs containing unicode identifiers, comments in Chinese/Japanese/Korean, or RTL text will either tokenize poorly (inflating token count estimates) or cause JSON serialization issues if the LLM returns findings with unicode that the parser mishandles. No mention of encoding anywhere in the spec.

---

## 9. Alternative Approaches Worth Considering

### 9.1 Use OpenAI's `response_format: { type: "json_object" }` Mode
Instead of prompt-engineering JSON compliance ("Return findings as a JSON array..."), use the structured output mode available in gpt-4o. This guarantees valid JSON, eliminating the entire parsing failure surface area in Task 3.2. It requires using `json_schema` response format with a provided schema object. The implementation changes are minimal; the reliability improvement is significant.

### 9.2 Stream LLM Responses for Progress Visibility
The 15–60 second wait is the biggest UX problem. Streaming (SSE) is supported by OpenAI's SDK natively. While streaming a JSON array is tricky to parse incrementally, you can stream the response and show "Agent [security] is thinking..." with a live character counter. This makes the wait feel much shorter and doesn't require structural changes.

### 9.3 File-Focused Rather Than Diff-Focused Review
Instead of sending the full unified diff, send each changed file's content with diff annotations inline. This gives the LLM better context (can see surrounding code, not just changed lines) and allows per-file parallelism that's more granular than per-lens. For each file, all 3 lenses could review it simultaneously. This scales better to large PRs.

### 9.4 Replace Jaccard with Embedding-Based Similarity
If dedup is a first-class feature (and it should be, since it's listed as a key value prop), use `text-embedding-ada-002` (or OpenAI's newer embedding models) to get semantic vectors for each finding, then cluster by cosine similarity. This correctly deduplicates "SQL injection in db.query()" and "missing input sanitization in database layer." The cost is minimal (~$0.0001 for 20 findings).

### 9.5 Drop `conf`, Use Plain `~/.agentreviewrc` JSON
Simpler, debuggable, no dependency. Users can `cat ~/.agentreviewrc` and hand-edit it. The file format is documented in README. Zero magic.

### 9.6 Eliminate Config Subcommand for v1
Just use environment variables. Document them prominently. Add `dotenv` support for `.agentreview.env` in the project root. This is the Unix-native approach, avoids shell history exposure, and eliminates 2 tasks (7.1 and 7.3) from the critical path.

---

## 10. Priority Reordering

The current sequence has a structural problem: **prompts are designed before the LLM client exists**, meaning the schema instruction in lenses (Task 2.1) can't be tested against actual LLM behavior until Phase 3 and 4 are done. This is a late-discovery risk.

**Recommended sequence:**

```
Phase 0: Scaffold (unchanged)
Phase 1: GitHub Client (unchanged, but add pagination to Task 1.2)
Phase 3: LLM Client FIRST — before Lens Registry
  Task 3.1: LLM client with retry
  Task 3.2a: JSON extraction fallback chain
  Task 3.2b: Schema validation with partial recovery
  Task 3.2c: Max_tokens detection
Phase 2: Lens Registry (after LLM client — prompts informed by actual LLM behavior)
  Task 2.1: Built-in lens prompts (now you can test them immediately)
  Task 2.2: Registry with schema validation
Phase 4: Dispatcher (unchanged)
Phase 5: Consolidator
  Task 5.1: REMOVE Jaccard dedup — just flatten and sort
  Task 5.2: Report consolidator (simpler without dedup)
Phase 6: Renderers
  Task 6.1: Markdown renderer
  Task 6.2: JSON renderer
  Task 6.3: DEFER terminal renderer to v2
  Task 6.4: Renderer router (simpler without terminal)
Phase 7: CLI
  Task 7.1: SIMPLIFY config — dotenv + env vars, no conf package, no config subcommand
  Task 7.2a: Pipeline wiring
  Task 7.2b: --post flag
  Task 7.2c: --fail-on + error handling
  Task 7.3: lenses subcommand (keep this one)
Phase 8: Polish
  Task 8.1: Fixture-based integration test (not live smoke test)
  Task 8.2: README (written as features land, finalized here)
  Task 8.3: npm publish prep
```

**Net change:** Remove 3 tasks (dedup, terminal renderer, config subcommand), split 3 tasks into 6, add 1 task. Result: 27 tasks, but with cleaner sequencing, fewer late-discovery bugs, and better separation of concerns.

---

## Summary Scorecard

| Dimension | Score | Key Issue |
|-----------|-------|-----------|
| Architecture | 6/10 | Pagination gap, no token-aware truncation, no caching |
| Assumptions | 4/10 | JSON parsing fragility, Jaccard dedup ineffectiveness |
| v1 Scope | 5/10 | Terminal renderer and dedup are premature |
| Implementation depth | 5/10 | Retry logic, prompt quality massively underestimated |
| Security | 4/10 | Plaintext credential storage, no data disclosure warning |
| DX | 6/10 | No cost estimate, silent hang, no dry-run |
| Testing | 4/10 | Smoke test only, no fixture-based integration tests |
| **Overall** | **5/10** | Solid structure, dangerous assumptions, underestimated complexity |

**Minimum required before shipping:**
1. Fix JSON parsing to fail *loudly*, not silently return `[]`
2. Add GitHub API pagination to `getFiles()`
3. Add a data-disclosure acknowledgment prompt
4. Add basic progress output (not verbose-only)
5. Token-aware diff truncation (not byte-based)
6. Integration tests against fixture data (not live API smoke tests)

Everything else can be iterated. But ship with the silent JSON failure and you'll have users trusting reports that lie to them.
