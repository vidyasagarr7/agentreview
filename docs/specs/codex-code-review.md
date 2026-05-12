# Codex Adversarial Code Review

Review scope: all files under `src/`, with checks against `docs/specs/agent-review-design.md`.

## Executive Verdict

Not ready to ship. The implementation has a hard compile failure, several spec-critical features are either missing or wired incorrectly, and some "safety" behavior silently proceeds in exactly the cases where a CI/user would expect a hard stop or an explicit annotation. The passing unit tests are not meaningful enough because they miss the CLI/config integration and several important edge cases.

## Findings

### Critical: project does not typecheck or build cleanly

- `src/cli/index.ts:4` imports `ora`, which is ESM-only, from a package that is treated as CommonJS because `package.json` lacks `"type": "module"`. `npm run typecheck` fails with TS1479.
- `src/cli/index.ts:6` imports `homedir` from `path`; Node exports `homedir` from `os`. `npm run typecheck` fails with TS2305.
- `src/llm/client.test.ts:34`, `src/llm/client.test.ts:46`, `src/llm/client.test.ts:58`, `src/llm/client.test.ts:70`, `src/llm/parse-findings.test.ts:20`, and `src/llm/parse-findings.test.ts:45` also fail under `tsc --noEmit`.

This is not a theoretical issue. I ran `npm run typecheck`; it exits 2. A CLI that cannot pass its own TypeScript check is not phase-complete.

### High: CLI ignores environment/default config promised by the spec and README

- `src/cli/config.ts:96` exposes `getDefaultLenses()`, `src/cli/config.ts:100` exposes `getDefaultFormat()`, and `src/cli/config.ts:104` exposes `getFailOnSeverity()`, but `src/cli/index.ts:223` to `src/cli/index.ts:247` hard-code CLI defaults instead of using them.
- `AGENTREVIEW_LENSES`, `AGENTREVIEW_FORMAT`, and `AGENTREVIEW_FAIL_ON` are documented in `README.md` and in the design spec, but they do not affect an actual `agentreview <pr-url>` run unless the user passes flags.

That breaks CI defaults and local config expectations. It is also a spec compliance failure for "Config loading and merging (env > config file > defaults)" in section 3.1.

### High: provider abstraction is fake; Anthropic config routes into the OpenAI SDK

- `src/cli/config.ts:46` accepts `LLM_PROVIDER=anthropic` and returns `provider: 'anthropic'` at `src/cli/config.ts:79`.
- `src/llm/client.ts:29` always constructs `new OpenAI(...)`, regardless of `config.provider`.

Setting `LLM_PROVIDER=anthropic` will send the Anthropic key to the OpenAI client path and fail authentication. The design spec explicitly calls for configurable OpenAI/Anthropic/OpenAI-compatible provider behavior; the current abstraction advertises support it does not implement.

### High: non-interactive privacy disclosure proceeds by default

- `src/cli/disclosure.ts:31` to `src/cli/disclosure.ts:33` automatically proceeds when stdin is not a TTY.
- `src/cli/disclosure.ts:25` to `src/cli/disclosure.ts:27` also treats `--yes` as consent, but the option text in `src/cli/index.ts:270` to `src/cli/index.ts:273` says "Skip the data disclosure prompt", not "acknowledge sending proprietary code to an LLM".

The tool sends PR diffs to an external provider. In CI or piped usage, it currently prints a warning and continues even if the user never acknowledged the data policy. That is a poor security/privacy default and easy to trigger accidentally.

### High: timeout implementation leaks work and can still spend tokens after a timeout

- `src/agents/dispatcher.ts:12` to `src/agents/dispatcher.ts:16` races the LLM promise against a timer but never cancels the underlying request.
- `src/llm/client.ts:29` to `src/llm/client.ts:32` sets an OpenAI client timeout, but the dispatcher adds a second timeout layer without an `AbortController`.

When `withTimeout` rejects, the OpenAI request can continue in the background. The report marks the lens failed while the process may still be spending money/rate-limit budget. The timer is also not cleared after success, which leaves avoidable live timers until expiry.

### High: deduplication does not implement the specified algorithm

- `src/report/dedup.ts:3` to `src/report/dedup.ts:7` says fuzzy/Jaccard dedup is deferred to v2.
- `src/report/dedup.ts:23` to `src/report/dedup.ts:27` keys duplicates by exact normalized summary and exact severity.

The design spec requires normalized location plus >80% summary-token overlap, and duplicates with adjacent severity should merge while keeping the highest severity. This implementation fails common cross-lens duplicates such as "Hardcoded token in config" vs "Secret committed in config", and it never merges the same issue if one lens says HIGH and another says CRITICAL.

### Medium: large diff handling does not match the spec and can hide important files

- `src/github/context-builder.ts:47` to `src/github/context-builder.ts:55` bases truncation on model token budget, not the spec's 100KB diff threshold.
- `src/github/context-builder.ts:79` to `src/github/context-builder.ts:90` drops any patch that does not fit. There is no per-file summary fallback.
- `src/github/context-builder.ts:30` to `src/github/context-builder.ts:39` only matches `diff --git a/<same> b/<same>`, so renamed files (`a/old b/new`) are not extracted during truncation.

For a large single security-relevant file, the agent can receive an empty or near-empty diff plus a truncation note. For renamed files, the file can disappear from the truncated context entirely. The spec says large diffs should include per-file summaries and full diffs for files under 10KB.

### Medium: GitHub API error handling collapses rate limits into auth failures

- `src/github/client.ts:55` to `src/github/client.ts:58` maps both 401 and 403 to `GitHubAuthError`.

GitHub uses 403 for rate limits and permission issues. The spec requires showing reset time for rate limits. This implementation tells users their token is missing or invalid, which sends them in the wrong direction and makes CI failures harder to diagnose.

### Medium: `--post` duplicates the hidden marker

- `src/report/renderers/markdown.ts:62` emits `<!-- agentreview -->`.
- `src/github/client.ts:134` to `src/github/client.ts:135` prepends `<!-- agentreview -->` again before posting/updating.

Posted comments begin with two markers. That is sloppy output and makes the comment identity contract split across two layers. Only the GitHub posting layer should own the hidden update marker, or the renderer should document that all markdown output includes it.

### Medium: terminal output format is missing

- `src/types/index.ts:87` only allows `'markdown' | 'json'`.
- `src/cli/index.ts:229` to `src/cli/index.ts:231` only exposes markdown and JSON.
- `src/report/renderer.ts:5` to `src/report/renderer.ts:12` has no terminal renderer.

The design spec lists `terminal` as a supported format and says stdout TTY handling should default to terminal-style output. The current implementation cannot produce it.

### Medium: command-line flag name diverges from the design spec

- The spec uses `--lens` in section 6 examples.
- `src/cli/index.ts:233` to `src/cli/index.ts:237` implements `--lenses` only.

This is a direct interface mismatch. The README now documents `--lenses`, but the code was requested to comply with `docs/specs/agent-review-design.md`, not just the rewritten README.

### Medium: custom lens validation is too weak

- `src/lenses/registry.ts:14` to `src/lenses/registry.ts:32` checks presence of fields but not that `id`, `name`, `description`, and `systemPrompt` are strings or that `focusAreas` contains strings.
- `src/cli/commands/lenses.ts:58` to `src/cli/commands/lenses.ts:70` repeats a different partial validator and does not require `focusAreas` to be an array.

A malformed custom lens can be accepted and later cause prompt construction or reporting to behave unpredictably. The validation logic is also duplicated, so registry loading and CLI add can disagree.

### Medium: malformed findings are silently downgraded to "clean"

- `src/llm/parse-findings.ts:15` to `src/llm/parse-findings.ts:18` returns `null` for malformed findings.
- `src/llm/parse-findings.ts:154` to `src/llm/parse-findings.ts:171` filters all malformed findings and still returns an empty array if none are valid.

This avoids crashing but creates false clean reports. If a lens returns a JSON array where every object is malformed, that is a parse/validation failure, not "no findings". The code even warns to stderr, but the consolidated report marks the lens clean.

### Low: binary/patchless files are not annotated

- `src/github/client.ts:89` to `src/github/client.ts:96` preserves `patch?: string`, but `src/github/context-builder.ts:79` to `src/github/context-builder.ts:81` silently skips files whose patch cannot be extracted.

The spec says binary files should be skipped with a report note. The current report has no field for skipped binary/patchless files, so reviewers do not know what the agents never saw.

### Low: output path writes do not ensure parent directories exist

- `src/cli/index.ts:164` to `src/cli/index.ts:166` calls `writeFile(opts.output, ...)` directly.

`--output reports/review.md` fails if `reports/` does not exist. This is not fatal, but for a CLI meant to be used in CI artifacts, creating parent directories or producing a targeted error would be better.

## Test Coverage Gaps

- No CLI integration tests cover `AGENTREVIEW_LENSES`, `AGENTREVIEW_FORMAT`, or `AGENTREVIEW_FAIL_ON`; this is why the dead config getters shipped.
- No build/typecheck assertion exists in the test suite; `vitest` passes while `tsc --noEmit` fails.
- No tests cover `LLM_PROVIDER=anthropic` or an OpenAI-compatible endpoint path.
- No timeout test verifies that timers are cleared or that requests are cancellable.
- No dedup tests cover fuzzy summary overlap or adjacent severity merging, even though the spec requires both.
- No context-builder tests cover renamed files, binary files without patches, empty diffs, or one oversized file that cannot fit.
- No GitHub client tests cover 403 rate-limit handling, draft/closed warnings, pagination failure, or `postOrUpdateComment` marker behavior.
- No CLI tests cover `--post` fallback behavior, `--no-dedup`, invalid timeout values, or output file errors.

## Verification Performed

- `npm test`: passed, 71 tests.
- `npm run typecheck`: failed with the TypeScript errors listed above.
