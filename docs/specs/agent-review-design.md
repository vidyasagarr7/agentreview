# AgentReview — Design Spec

> Multi-perspective automated PR review CLI using parallel AI agents.

---

## 1. Idea Stress-Test (Office Hours: Skeptic ↔ Founder)

### Q: What specific pain does this solve that existing tools don't?

**Skeptic:** GitHub Copilot PR review, CodeRabbit, Sourcery, Sweep, and a dozen others already do "AI PR review." They're integrated into the PR workflow, have CI hooks, and cost $10–20/seat/month. Why build another?

**Founder:** They're single-lens tools. CodeRabbit gives you *a* review; it doesn't separate "is this secure?" from "is this the right architecture?" from "is this readable?" Engineering leads care about the *dimension* of the finding — a security issue is a blocker, a style nit is optional noise. Most tools mash it all together. AgentReview surfaces concerns by lens so triage is immediate.

---

### Q: Why would someone pay for this vs. just running `claude review` manually?

**Skeptic:** You can already pipe a diff to Claude and say "review this for security issues." That takes 30 seconds to set up. Why build scaffolding around something so simple?

**Founder:** Because running one agent isn't the same as running three agents with different system prompts, merging their outputs, deduplicating overlapping findings, mapping severity consistently across lenses, and formatting a report your whole team can read in 2 minutes. The value is in the orchestration and the consolidated output, not the individual LLM call. The 30-second DIY version gives you raw LLM output; this gives you a structured, actionable report.

---

### Q: What's the real moat?

**Skeptic:** This is all prompt engineering and API wiring. Any competitor can copy it in a weekend.

**Founder:** The moat isn't the tech — it's the *lens library*. Over time, teams will build custom review lenses for their own stack (e.g., a FHIR compliance lens for healthcare, a PCI-DSS lens for fintech). A marketplace of community-contributed review lenses creates stickiness and network effects. The CLI being local and composable (pipes, CI scripts) builds muscle memory in teams. Also: the format of the report becomes a contract other tools integrate with.

---

### Q: Who's the first customer?

**Founder:** Mid-size engineering teams (20–200 engineers) who care about code quality but can't afford dedicated security or architecture reviewers on every PR. Tech leads who are the single bottleneck on review quality. First customer is likely a startup CTO who's tired of being the only person catching architecture drift.

**Minimum viable customer:** A dev who runs it on their own PRs before requesting review, so they catch their own issues first.

---

### Q: What's the fastest path to something people will use?

**Founder:** Ship a version that takes a GitHub PR URL, runs three agents (security, architecture, quality), and prints a markdown report to stdout. No config, no setup beyond an API key. Tweet the demo. If people star it and ask "can I add custom lenses?" — you have product-market fit signal. First milestone: 100 GitHub stars.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    CLI Entry Point                   │
│              agentreview <pr-url> [flags]            │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                  PR Context Builder                  │
│  • Fetch PR metadata (title, desc, labels, author)  │
│  • Fetch diff (patch format, file list)             │
│  • Fetch base branch context (recent commits)       │
│  • Construct ReviewContext object                   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                  Agent Dispatcher                    │
│  • Resolve active lenses (default + custom)         │
│  • Build per-lens prompts (system + user)           │
│  • Dispatch agents in parallel (Promise.all)        │
│  • Collect AgentResult[] with timing/errors         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                Report Consolidator                   │
│  • Parse structured findings from each agent        │
│  • Deduplicate overlapping findings                 │
│  • Map severity to unified scale (CRITICAL→INFO)    │
│  • Sort by severity, then lens                      │
│  • Render: markdown / JSON / terminal color         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                   Output Handler                     │
│  • Print to stdout / write to file                  │
│  • Optional: post as PR comment (--post flag)       │
└─────────────────────────────────────────────────────┘
```

---

## 3. Key Components

### 3.1 CLI Parser (`src/cli/index.ts`)

Entrypoint. Parses args using `commander`. Validates PR URL format. Loads config from `~/.agentreview/config.json` or env vars. Orchestrates the pipeline.

**Responsibilities:**
- Argument parsing and validation
- Config loading and merging (env > config file > defaults)
- Error handling at the top level (clean user-facing messages)
- Exit codes (0 = success, 1 = error, 2 = PR has CRITICAL findings)

### 3.2 GitHub API Client (`src/github/client.ts`)

Thin wrapper around GitHub REST API (Octokit or direct fetch). Handles auth, rate limits, pagination.

**Key methods:**
- `getPR(owner, repo, number): Promise<PRData>`
- `getDiff(owner, repo, number): Promise<string>` — raw unified diff
- `getFiles(owner, repo, number): Promise<ChangedFile[]>`
- `postComment(owner, repo, number, body): Promise<void>` — for `--post` flag

**PRData shape:**
```typescript
interface PRData {
  title: string;
  body: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  labels: string[];
  diff: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
}
```

### 3.3 Lens Registry (`src/lenses/registry.ts`)

Manages built-in and custom review lenses. A lens is a named review perspective with a system prompt template.

**Built-in lenses:**
| Lens | Focus | Prompt persona |
|------|-------|---------------|
| `security` | Auth, injection, secrets, OWASP | "You are a senior security engineer..." |
| `architecture` | Design patterns, coupling, SOLID, scale | "You are a staff engineer focusing on system design..." |
| `quality` | Readability, maintainability, test coverage, docs | "You are a senior engineer doing a quality review..." |

**Custom lenses:** Loaded from `~/.agentreview/lenses/*.json`. Schema:
```typescript
interface Lens {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  focusAreas: string[];     // hints for prompt construction
  severity?: 'strict' | 'normal' | 'advisory';  // default: normal
}
```

### 3.4 Agent Dispatcher (`src/agents/dispatcher.ts`)

Constructs per-lens prompts and dispatches all agents concurrently.

**Prompt construction per lens:**
```
System: <lens.systemPrompt>

You are reviewing a GitHub PR. Your job is to identify issues from your specific lens.

Return findings as a JSON array. Each finding must have:
- id: string (unique slug)
- severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
- category: string (brief category label)
- location: string (file:line or "general")
- summary: string (one line)
- detail: string (explanation + evidence)
- suggestion: string (what to do about it)

If there are no issues for your lens, return an empty array [].

User: 
PR Title: {title}
PR Description: {body}

Changed files: {fileList}

Diff:
{diff}
```

**Dispatch strategy:**
- All lenses run in parallel via `Promise.allSettled`
- Per-agent timeout: 60s (configurable)
- Failed agents are logged but don't block the report
- Partial results are surfaced with `[AGENT ERROR]` annotation

### 3.5 LLM Client (`src/llm/client.ts`)

Abstraction over LLM providers. Default: OpenAI (GPT-4o). Configurable to Anthropic Claude or any OpenAI-compatible endpoint.

**Methods:**
- `complete(systemPrompt, userPrompt, options): Promise<string>`
- Handles retries with exponential backoff (max 3 attempts)
- Validates that response parses as JSON array before returning

### 3.6 Report Consolidator (`src/report/consolidator.ts`)

Merges `AgentResult[]` into a unified `ConsolidatedReport`.

**Deduplication logic:**
- Hash each finding by: `(location_normalized + summary_keywords)` using fuzzy matching (>80% token overlap = duplicate)
- Keep highest severity version of a duplicate
- Tag finding with all lenses that flagged it (e.g., `[security, architecture]`)

**Severity mapping (unified scale):**
```
CRITICAL  → 🔴 Must fix before merge
HIGH      → 🟠 Should fix before merge
MEDIUM    → 🟡 Consider fixing
LOW       → 🔵 Minor improvement
INFO      → ⚪ FYI / informational
```

### 3.7 Report Renderer (`src/report/renderer.ts`)

Renders `ConsolidatedReport` to output format.

**Formats:**
- `markdown` (default): Full markdown with headers, tables, code refs
- `json`: Raw structured data for tooling integration
- `terminal`: Color-coded, human-readable, compact (no markdown syntax)

**Markdown report structure:**
```markdown
# AgentReview: PR #123 — <title>

> Reviewed by: security · architecture · quality
> Reviewed at: 2026-05-12T01:00:00Z
> Files changed: N | +X / -Y lines

## Summary
| Severity | Count |
...

## Findings

### 🔴 CRITICAL (N)
#### [security] Hardcoded AWS credentials in config.ts:45
...

### 🟠 HIGH (N)
...

## Lens Notes
### Security
...clean (no issues found)...

---
*Generated by [AgentReview](https://github.com/...)*
```

---

## 4. Agent Dispatch Strategy

### Parallelism
All lenses dispatch simultaneously. For 3 lenses + GPT-4o, typical wall time is 15–30s vs 45–90s sequential. This is the single biggest UX win.

### Context per agent
Each agent gets:
1. **System prompt** — lens persona + JSON output schema (enforced)
2. **PR metadata** — title, description, labels (signals intent)
3. **File list** — what changed (signals scope)
4. **Diff** — the actual code changes

What agents do NOT get:
- Full file contents (too expensive, not necessary for most reviews)
- PR comment history (reduces noise, future option)

### Diff size handling
GitHub diffs for large PRs can exceed context limits. Strategy:
1. If diff < 100KB: send full diff
2. If diff >= 100KB: send per-file summaries + full diff for files < 10KB
3. Add `[TRUNCATED]` note in report if context was reduced

### Prompt engineering per lens
Each lens's system prompt is tuned to:
- Define what "counts" as an issue for that lens (prevents noise)
- Specify severity calibration (security is strict; quality is advisory by default)
- Require structured JSON output (no prose, no markdown in findings)
- Instruct agent to explain the *why*, not just the *what*

---

## 5. Report Consolidation Approach

### Step 1: Parse
Parse each agent's JSON response. If parsing fails, mark agent as errored; continue with others.

### Step 2: Normalize locations
Normalize file paths (strip leading `a/`/`b/` from diff notation). Map line numbers where available.

### Step 3: Deduplicate
Two findings are duplicates if:
- Same file (normalized)
- Summary tokens overlap >80% (Jaccard similarity on unigrams)
- Both flagged as same or adjacent severity

Merge strategy: keep highest severity, concatenate lens tags, keep most detailed `detail` field.

### Step 4: Sort
1. By severity (CRITICAL first)
2. Within severity: by lens (security > architecture > quality)
3. Within lens: by file path (alphabetical)

### Step 5: Aggregate stats
- Total findings by severity
- Total findings by lens
- Clean lenses (no findings)
- Review confidence (LOW if any agent errored, NORMAL otherwise)

---

## 6. CLI Interface Design

### Commands

```bash
# Primary command
agentreview <pr-url> [options]

# Examples
agentreview https://github.com/org/repo/pull/123
agentreview https://github.com/org/repo/pull/123 --lens security,architecture
agentreview https://github.com/org/repo/pull/123 --format json > report.json
agentreview https://github.com/org/repo/pull/123 --post       # post to PR as comment
agentreview https://github.com/org/repo/pull/123 --fail-on HIGH  # exit 2 if HIGH+ findings

# Config management
agentreview config set GITHUB_TOKEN ghp_...
agentreview config set LLM_PROVIDER openai
agentreview lenses list
agentreview lenses add ./my-lens.json
```

### Flags
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--lens` | `string` | `all` | Comma-separated lens IDs to run |
| `--format` | `string` | `markdown` | Output format: `markdown`, `json`, `terminal` |
| `--output` | `string` | stdout | Output file path |
| `--post` | `bool` | false | Post report as PR comment |
| `--fail-on` | `string` | none | Exit code 2 if findings at this severity+ |
| `--timeout` | `number` | 60 | Per-agent timeout in seconds |
| `--model` | `string` | `gpt-4o` | LLM model override |
| `--no-dedup` | `bool` | false | Disable finding deduplication |
| `--verbose` | `bool` | false | Show agent dispatch progress |

### Environment Variables
| Var | Description |
|-----|-------------|
| `GITHUB_TOKEN` | GitHub personal access token |
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key (if using Claude) |
| `AGENTREVIEW_MODEL` | LLM model override |
| `AGENTREVIEW_LENSES` | Comma-separated lens IDs |

---

## 7. Error Handling & Edge Cases

### GitHub API errors
- 401: "GitHub token missing or invalid. Run `agentreview config set GITHUB_TOKEN <token>`"
- 403: Rate limit. Show reset time, suggest `--no-dedup` to reduce calls.
- 404: PR not found. Validate URL format before API call.
- PR is draft: Warn but continue (user may want draft reviews).
- PR is merged/closed: Warn but continue.

### LLM errors
- No API key: Fail fast with clear message before dispatching any agents.
- Agent times out: Mark lens as `[TIMED OUT]` in report. Don't block other lenses.
- Agent returns non-JSON: Attempt to extract JSON from markdown code blocks. If still invalid, mark as `[PARSE ERROR]`.
- Rate limit (429): Retry with exponential backoff up to 3 times. If all fail, mark lens errored.

### Diff edge cases
- Binary files: Skip silently (note in report "N binary files skipped").
- Renamed files only: Report as INFO-level for architecture lens.
- Empty diff (only whitespace): Short-circuit, return "No meaningful changes to review."
- Monorepo PRs (hundreds of files): Warn about cost, require `--confirm-large` flag if >50 files.

### Output edge cases
- stdout is a pipe (non-TTY): Use `markdown` format by default (not `terminal`).
- `--post` fails (no write permission): Fall back to printing to stdout, log error.
- Partial results (some agents errored): Always produce a report, annotate with which lenses succeeded.

---

## 8. Configuration & Extension

### Config file: `~/.agentreview/config.json`
```json
{
  "github": { "token": "..." },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKey": "...",
    "timeout": 60
  },
  "defaults": {
    "lenses": ["security", "architecture", "quality"],
    "format": "terminal",
    "failOn": null
  }
}
```

### Custom lens file: `~/.agentreview/lenses/my-lens.json`
```json
{
  "id": "fhir-compliance",
  "name": "FHIR Compliance",
  "description": "Reviews changes for HL7 FHIR spec compliance",
  "systemPrompt": "You are a FHIR spec expert...",
  "focusAreas": ["FHIR resource types", "REST semantics", "data mapping"],
  "severity": "strict"
}
```

---

## 9. Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 20+ | Ubiquitous, great async, easy npm publish |
| Language | TypeScript | Type safety for API shapes, better DX |
| CLI framework | `commander` | Lightweight, battle-tested |
| GitHub API | `@octokit/rest` | Official SDK, handles auth/pagination |
| LLM calls | `openai` SDK | Supports OpenAI-compatible endpoints |
| Output | `chalk` + `marked` | Terminal colors + markdown rendering |
| Config | `conf` | XDG-compliant config storage |
| Testing | `vitest` | Fast, zero-config, ESM-native |
| Build | `tsup` | Single-file CJS+ESM output, fast |
| Publish | npm | Standard CLI distribution |

---

## 10. Non-Goals (v1)

- Web UI or GitHub App integration
- PR comment threading (only top-level comments)
- Diff-level line annotations in GitHub UI
- Caching of previous reviews
- Team/org settings or policy enforcement
- Support for GitLab, Bitbucket
- Custom LLM hosting / self-hosted models (but OpenAI-compat endpoint is possible via config)
