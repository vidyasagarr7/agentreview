# Design Spec: GitHub Actions Integration

**Date:** 2026-05-21
**Author:** Vex
**Status:** REVISED — incorporates design review findings
**Reviewer:** Subagent (DevOps/Actions expert) — SHIP WITH CHANGES

---

## 1. Problem Statement

AgentReview is a CLI tool. To use it, you need to:
- Install it locally or in CI via npm
- Set up env vars (API keys, GitHub token)
- Run it manually or write custom CI scripts

**Goal:** Ship a first-class GitHub Action so any repo can add AI code review in 5 minutes with a single workflow file.

---

## 2. User Stories

1. **As a repo maintainer**, I want to add `agentreview` to my CI so every PR gets auto-reviewed.
2. **As a security team lead**, I want to block merges when critical/high security findings exist.
3. **As a developer**, I want review comments posted directly on my PR without any manual steps.
4. **As an open-source maintainer**, I want to choose which lenses run (security only, or all three).

---

## 3. Usage (End Result)

```yaml
# .github/workflows/agentreview.yml
name: AgentReview
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: vidyasagarr7/agentreview@v1
        with:
          # Required: LLM provider API key
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # OR
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}

          # Optional
          model: claude-sonnet-4-20250514     # default: claude-sonnet-4-20250514
          lenses: security,architecture,quality  # default: all
          fail-on: HIGH                        # default: (none) — don't fail
          validate: true                       # default: true
          codebase-context: true               # default: true
          verbose: false                       # default: false
```

### Advanced Usage

```yaml
      - uses: vidyasagarr7/agentreview@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-sonnet-4-20250514
          lenses: security
          fail-on: CRITICAL
          # Custom lens from repo
          custom-lenses-dir: .github/agentreview/lenses
```

---

## 4. Architecture

### 4.1 Action Type: JavaScript (Node20)

Using `node20` runtime (not Docker) for:
- Faster startup (~2s vs ~30s for Docker)
- Cross-platform (Ubuntu, macOS, Windows runners)
- Direct access to `@actions/core`, `@actions/github`

### 4.2 Files

```
action.yml                    # Action metadata + inputs/outputs
action/
  src/
    index.ts                  # Main entry point
    inputs.ts                 # Parse and validate Action inputs
    context.ts                # Extract PR context from GitHub event
    run.ts                    # Orchestrate the review pipeline
    outputs.ts                # Set Action outputs
    post-results.ts           # Post review comment + set status check
action/dist/
  index.js                    # Bundled output (tsup CJS — NOT ncc, see below)
```

### 4.3 Bundling: tsup (NOT ncc)

**Design review finding:** The project uses tsup (esbuild-based). Adding ncc creates a two-bundler problem. Additionally, ncc has known issues with ESM-only packages (Anthropic/OpenAI SDKs).

**Decision:** Use tsup for the action bundle too:
```typescript
// tsup.config.action.ts
export default {
  entry: ['action/src/index.ts'],
  outDir: 'action/dist',
  format: ['cjs'],  // GitHub Actions requires CJS
  platform: 'node',
  target: 'node20',
  bundle: true,
  noExternal: [/.*/],  // Inline everything
}
```
This keeps one bundler, handles ESM deps correctly, and outputs CJS as Actions requires.

### 4.3 Data Flow

```
GitHub Event (pull_request)
  │
  ▼
┌─────────────────────┐
│  Parse Inputs        │  → API keys, model, lenses, fail-on
│  + Validate          │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Extract PR Context  │  → owner, repo, PR number from github.context
│                      │  → No need to parse URLs — we have structured data
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Run AgentReview     │  → Reuse existing: GitHubClient, LLMClient, 
│  (Library Call)      │     dispatchAgents, consolidate, validate, render
│                      │  → NOT a subprocess — direct function call
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Post Results        │  → Comment on PR (reuse GitHubClient.postOrUpdateComment)
│  + Set Outputs       │  → Set status check (pass/fail based on --fail-on)
│                      │  → Set Action outputs (findings-count, report-path)
└─────────────────────┘
```

### 4.4 Key Design Decision: Library Call, Not Subprocess

The action imports agentreview functions directly — it does NOT shell out to `node dist/cli/index.js`. This means:
- No need to install dependencies at runtime
- Faster execution
- Better error handling
- Access to structured results (not just CLI output)

The existing code is already well-modularized:
- `GitHubClient.getPR()` → fetch PR data
- `buildReviewContext()` → build context with truncation
- `dispatchAgents()` → run lenses in parallel
- `validateAgentResults()` → confidence scoring
- `consolidate()` → merge + dedup findings
- `render()` → format as markdown
- `GitHubClient.postOrUpdateComment()` → post to PR
- `buildCodebaseContext()` → codebase awareness

---

## 5. Detailed Design

### 5.1 Action Inputs (`action.yml`)

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic-api-key` | One of API keys required | | Anthropic API key |
| `openai-api-key` | One of API keys required | | OpenAI API key |
| `model` | No | `claude-sonnet-4-20250514` | LLM model to use |
| `lenses` | No | `all` | Comma-separated lenses |
| `fail-on` | No | (none) | Fail if findings at/above severity |
| `validate` | No | `true` | Enable confidence scoring |
| `min-confidence` | No | `40` | Min confidence score (0-100) |
| `codebase-context` | No | `true` | Enable codebase awareness |
| `codebase-budget` | No | `8000` | Token budget for codebase context |
| `verbose` | No | `false` | Enable verbose logging |
| `custom-lenses-dir` | No | | Path to custom lens JSON files (requires actions/checkout first) |
| `github-token` | No | `${{ github.token }}` | GitHub token (auto-provided) |
| `pr-number` | No | (from event) | Override PR number (for workflow_dispatch/issue_comment triggers) |
| `comment-mode` | No | `full` | Comment mode: full, summary, or collapsed |

### 5.2 Action Outputs

| Output | Description |
|--------|-------------|
| `findings-count` | Total number of findings |
| `critical-count` | Number of CRITICAL findings |
| `high-count` | Number of HIGH findings |
| `review-comment-id` | ID of the posted PR comment |
| `report` | Full markdown report (truncated if >1MB; also written to $GITHUB_STEP_SUMMARY) |
| `exit-code` | 0 (clean) or 2 (findings above fail-on threshold) |

### 5.3 Entry Point (`action/index.ts`)

```typescript
import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseInputs } from './inputs.js';
import { extractPRContext } from './context.js';
import { runReview } from './run.js';
import { postResults } from './post-results.js';
import { setOutputs } from './outputs.js';

async function main() {
  try {
    const inputs = parseInputs();
    const prContext = extractPRContext();
    const result = await runReview(inputs, prContext);
    await postResults(result, prContext, inputs);
    setOutputs(result);
    
    if (result.shouldFail) {
      core.setFailed(`AgentReview found findings at or above ${inputs.failOn} severity`);
    }
  } catch (error) {
    core.setFailed(`AgentReview failed: ${error.message}`);
  }
}

main();
```

### 5.4 PR Context Extraction (`action/context.ts`)

```typescript
export function extractPRContext() {
  const { context } = github;
  
  if (context.eventName !== 'pull_request') {
    throw new Error('AgentReview action only works on pull_request events');
  }
  
  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber: context.payload.pull_request!.number,
    token: core.getInput('github-token') || context.token,
  };
}
```

### 5.5 Review Pipeline (`action/run.ts`)

Reuses existing modules directly:
1. Create `GitHubClient` with the github-token
2. Fetch PR via `GitHubClient.getPR()`
3. Build review context via `buildReviewContext()`
4. Optionally build codebase context via `buildCodebaseContext()`
5. Resolve lenses via `LensRegistry`
6. Create `LLMClient` with the provided API key
7. Dispatch agents via `dispatchAgents()`
8. Validate via `validateAgentResults()` (if enabled)
9. Consolidate + render via `consolidate()` + `render()`
10. Check fail-on threshold
11. Return structured result

### 5.6 Posting Results (`action/post-results.ts`)

- Uses `GitHubClient.postOrUpdateComment()` — already handles create-or-update
- Adds a footer: `<!-- agentreview-action -->` marker for identifying our comments
- On re-run (new commits pushed), updates the existing comment instead of creating a new one

### 5.7 Bundling

Use tsup to compile everything into a single CJS `action/dist/index.js`:
```bash
npx tsup --config tsup.config.action.ts
```

This outputs CJS (required by Actions runtime), inlines all deps, and handles ESM packages correctly.

**Additional results posting:**
- Write full report to `$GITHUB_STEP_SUMMARY` (visible in Actions UI, no size limit)
- Comment on PR (truncated to 65K chars if needed)
- Set output `report` (truncated to 1MB if needed)

**Concurrency guidance in README:**
```yaml
concurrency:
  group: agentreview-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

---

## 6. Reuse from Existing Code

| Component | Reuse | Notes |
|-----------|-------|-------|
| `GitHubClient` | ✅ full | getPR, postOrUpdateComment, getRepoTree, getFileContent |
| `buildReviewContext` | ✅ full | |
| `buildCodebaseContext` | ✅ full | |
| `LensRegistry` | ✅ full | Including custom lens loading |
| `LLMClient` | ✅ full | |
| `dispatchAgents` | ✅ full | |
| `validateAgentResults` | ✅ full | |
| `consolidate` | ✅ full | |
| `render` | ✅ full | |
| `ConfigManager` | ❌ replaced | Action builds `LLMConfig` manually from inputs (provider, model, apiKey, timeout, contextTokens) |
| `checkDataDisclosure` | ❌ skipped | Action always runs non-interactively — disclosure is implicit by adding the action |

**New code estimate:** ~300-500 lines across 6 files (action module) + action.yml + ncc build config.

---

## 7. Testing Strategy

### Unit Tests
- `inputs.test.ts`: input parsing, validation, defaults, missing key errors
- `context.test.ts`: PR context extraction, non-PR event rejection
- `outputs.test.ts`: output setting
- `run.test.ts`: end-to-end with mocked GitHubClient + LLMClient

### Integration Test
- Create a test workflow in the agentreview repo itself
- Trigger on PRs to verify the action works end-to-end

### Manual Test
- Fork a test repo, add the action, open a PR, verify it posts a comment

---

## 8. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| tsup bundle too large (>50MB GitHub limit) | MEDIUM | Bundle will be 10-25MB (both LLM SDKs included). Under limit but monitor. Consider lazy dynamic imports for unused SDK in future |
| Rate limiting on LLM API in parallel CI runs | MEDIUM | Action uses existing LLMClient retry logic |
| GitHub token permissions insufficient | LOW | Document required permissions in README |
| Sensitive code sent to LLM | MEDIUM | Document clearly in README. Consider future --redact support for Action |
| Action marketplace approval | LOW | Just needs a release tag and a README |

---

## 9. Distribution

1. **Tag release:** `git tag v1.0.0 && git push --tags`
2. **GitHub Marketplace:** Submit via repo settings → Actions → Publish
3. **Usage:** `uses: vidyasagarr7/agentreview@v1` (major version tag)
4. **Versioning:** Maintain `v1` tag pointing to latest v1.x.x

---

## 10. Success Criteria

1. `uses: vidyasagarr7/agentreview@v1` works in any repo's workflow
2. Posts review comment on PR with findings
3. Updates comment on re-push (doesn't duplicate)
4. `fail-on` correctly sets check status
5. Action outputs are set (findings-count, etc.)
6. Bundle size < 10MB
7. Execution time < 60s for typical PR (excluding LLM latency)
8. All existing CLI tests continue to pass
