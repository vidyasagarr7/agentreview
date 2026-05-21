# Implementation Plan: GitHub Actions Integration

**Date:** 2026-05-21
**Spec:** `2026-05-21-github-action-design.md`
**Branch:** `feat/github-action`
**Revision:** v2 — incorporates design review + plan challenge findings

---

## Task Breakdown

---

### Task 0: Bundling spike — prove tsup CJS works (Finding 4: HIGH)
**Files:** `action/src/spike.ts` (temporary)
**Intent:** De-risk the entire plan by proving tsup can bundle ESM deps into CJS.
**Implementation:**
- Create minimal entry that imports: `@anthropic-ai/sdk`, `openai`, `p-limit`, `@octokit/rest`, `@actions/core`
- Run: `npx tsup action/src/spike.ts --format cjs --platform node --target node20 --bundle --no-external '/.*/''`
- Verify output is valid CJS, runs without error under `node --eval "require('./action/dist/spike.js')"`
- Measure bundle size
- Delete spike file after confirming
**Verification:** CJS bundle loads without error. If this fails, fall back to ncc or subprocess approach.

---

### Task 1: Action metadata (`action.yml`)
**Files:** `action.yml`
**Intent:** Define the action's inputs, outputs, and runtime config.
**Content:**
- name: AgentReview
- description: AI-powered multi-lens code review for PRs
- All inputs from spec section 5.1
- All outputs from spec section 5.2
- runs.using: node20, runs.main: action/dist/index.js
- branding: icon: shield, color: blue
**Verification:** Valid YAML, all inputs have descriptions

---

### Task 2: Input parsing (`action/src/inputs.ts`)
**Files:** `action/src/inputs.ts`, `action/src/inputs.test.ts`
**Intent:** Parse and validate Action inputs into structured config.
**Tests:**
- Anthropic key provided → provider=anthropic, key set
- OpenAI key provided → provider=openai, key set
- Neither key → throws error
- Both keys → anthropic takes precedence
- Default model is claude-sonnet-4-20250514
- Lenses parsing: "security,quality" → ['security', 'quality']
- Lenses default: "all" → 'all'
- fail-on validation: "HIGH" → valid, "INVALID" → throws
- Boolean inputs parsed correctly (validate, verbose, codebase-context)
- pr-number override parsed when present
- comment-mode: full | summary | collapsed
- Builds LLMConfig with provider-aware context tokens (Anthropic: 200000, OpenAI: 128000) (Finding 5)
- Model-provider validation: `gpt-*` with anthropic key → error (Finding 5)
- custom-lenses-dir validates path exists on disk, throws helpful error if missing (Finding 6)
**Implementation:**
- Use `@actions/core.getInput()` for all inputs
- Return typed `ActionInputs` interface
**Verification:** Tests pass

---

### Task 3: PR context extraction (`action/src/context.ts`)
**Files:** `action/src/context.ts`, `action/src/context.test.ts`
**Intent:** Extract PR metadata from GitHub Actions event context.
**Tests:**
- pull_request event → extracts owner, repo, prNumber, token
- Non-PR event (workflow_dispatch/issue_comment) with pr-number input → constructs context from github.context.repo + pr-number override (Finding 7)
- Non-PR event without pr-number → throws with clear message
- pull_request_target event → works (for fork PRs)
- Token from input overrides default github.token
**Implementation:**
- Use `@actions/github.context`
- Support both `pull_request` and `pull_request_target`
**Verification:** Tests pass

---

### Task 4: Review pipeline (`action/src/run.ts`)
**Files:** `action/src/run.ts`, `action/src/run.test.ts`
**Intent:** Orchestrate the full review using existing agentreview modules.
**Tests:**
- Full pipeline with mocked GitHubClient + LLMClient → returns result
- Lenses filtering works (security-only returns only security findings)
- Codebase context enabled/disabled works
- Validation enabled/disabled works
- fail-on threshold calculation correct
- Error in one lens doesn't kill the whole review
- Wires context.skippedFiles through to consolidate() (Finding 3)
- noDedup intentionally excluded from Action inputs (defaults to false) (Finding 3)
**Implementation:**
- Import existing modules directly (not subprocess)
- Build LLMConfig from action inputs
- Run standard pipeline: getPR → buildContext → dispatch → validate → consolidate → render
**Verification:** Tests pass

---

### Task 5: Post results (`action/src/post-results.ts`)
**Files:** `action/src/post-results.ts`, `action/src/post-results.test.ts`
**Intent:** Post review comment on PR + write to step summary.
**Tests:**
- First run → creates new comment
- Re-run (comment exists with marker) → updates existing comment
- Uses existing `<!-- agentreview -->` marker (Finding 1: same marker as CLI to avoid duplicate comments)
- Large report (>65K) → truncated gracefully with note
- Step summary written via core.summary
- comment-mode=summary → only posts finding counts + severity table
- comment-mode=collapsed → wraps findings in <details> blocks
- Returns comment ID for outputs (Finding 2)
**Implementation:**
- Extend `GitHubClient.postOrUpdateComment()` to return `{ commentId: number, created: boolean }` (Finding 2)
- Use same `<!-- agentreview -->` marker as CLI (Finding 1: no parallel posting system)
- Write full report to $GITHUB_STEP_SUMMARY via core.summary.addRaw()
- Respect comment-mode for PR comment
**Verification:** Tests pass

---

### Task 6: Output setting (`action/src/outputs.ts`)
**Files:** `action/src/outputs.ts`, `action/src/outputs.test.ts`
**Intent:** Set action outputs from review results.
**Tests:**
- findings-count set correctly
- critical-count, high-count set correctly
- exit-code: 0 when no fail-on match, 2 when match
- report output contains markdown
**Implementation:**
- Use `@actions/core.setOutput()`
**Verification:** Tests pass

---

### Task 7: Main entry point (`action/src/index.ts`)
**Files:** `action/src/index.ts`
**Intent:** Wire everything together.
**Implementation:**
- Import parseInputs, extractPRContext, runReview, postResults, setOutputs
- try/catch with core.setFailed on error
- core.info for progress logging
**Verification:** tsc passes

---

### Task 8: tsup bundle + build script
**Files:** `tsup.config.action.ts`, `package.json` (scripts)
**Intent:** Bundle the action into a single CJS file via tsup.
**Implementation:**
- Create `tsup.config.action.ts` with format: ['cjs'], platform: 'node', target: 'node20', noExternal: [/.*/]
- Add script: `"build:action": "tsup --config tsup.config.action.ts"`
- Install `@actions/core` and `@actions/github` as dependencies
- Build and commit `action/dist/index.js`
- Verify bundle size < 50MB
**Verification:** `npm run build:action` succeeds, `action/dist/index.js` exists, is CJS

---

### Task 9: Example workflow + README
**Files:** `README.md` (update), `.github/workflows/agentreview.yml` (example)
**Intent:** Document usage and add example workflow.
**Content:**
- Usage section in README with basic and advanced examples
- Permissions requirements
- Available inputs/outputs table
- Troubleshooting section
- Example workflow file
**Verification:** README renders correctly on GitHub

---

### Task 10: Build verification
**Steps:**
1. `npm run build` — CLI still works
2. `npm run build:action` — Action bundles successfully
3. `npm test` — all existing + new tests pass
4. `npx tsc --noEmit` — clean
5. Bundle size check: `ls -lh action/dist/index.js`
6. Verify action.yml is valid

---

## Execution Order

- **Group 0:** Task 0 (bundling spike — must pass before anything else)
- **Group 1:** Tasks 1, 2, 3, 6 (action.yml + inputs + context + outputs — no dependencies)
- **Group 2:** Tasks 4, 5 (pipeline + post-results — depend on inputs/context)
- **Group 3:** Tasks 7, 8 (entry point + bundling — depend on everything)
- **Group 4:** Tasks 9, 10 (docs + verification)

Estimated time: 1-2 hours with parallel execution.
