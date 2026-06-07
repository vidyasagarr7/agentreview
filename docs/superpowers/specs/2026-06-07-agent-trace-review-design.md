# Agent Trace Review — Design Spec (v2, post-review)

## Review History
- **v1:** Initial design
- **v2:** Revised after adversarial reviews by Gemini (eng review, 4-7/10 ratings) and Claude Code (CEO review, "don't build this version"). Key changes: reframed as standalone command, cut Codex/Cursor/LLM digest from v1, added threat model, local-only by default, cut diff-derivable signals.

## Problem Statement

AI coding agents produce session transcripts that reveal **process quality signals invisible in the final diff**: whether the agent explored alternatives, how many attempts failed, and whether errors were acknowledged but not handled. No existing tool reviews the agent's decision-making process.

## Solution: `agentreview trace` — Standalone Command

**Critical reframing (from CEO review):** The trace owner is the code author, not the PR reviewer. The right v1 is a standalone command the author runs on their own sessions, NOT a PR-coupled review feature.

```bash
# The MVP command
agentreview trace ~/.claude/projects/.../session.jsonl
```

Output: process digest + flagged findings, printed to stdout. No PR coupling. No external LLM calls. Local-only.

## Scope: v1 (The Wedge)

### In Scope
1. **Claude Code JSONL parser** — one format, the one we dogfood
2. **Trace distiller** — compress raw transcripts for analysis (port vibeshub's approach with fixes)
3. **Local heuristic process checks** — the 3 signals that GENUINELY need the trace
4. **Enhanced redaction** — add entropy-based detection (standalone improvement, applies to `scan` too)
5. **`agentreview trace <path>` CLI command** — standalone, local-only

### Out of Scope (v2+)
- Codex/Cursor parsers (add when users show up with those traces)
- LLM-powered digest generation (adds cost, latency, security surface)
- PR comment integration / `--trace` flag on review command
- Lens framework integration
- vibeshub URL fetching
- Subagent tree analysis

### Signals: Only What the Diff Can't Tell You

**CEO review correctly identified that 4 of 7 original signals are derivable from the diff.** Cut those. Keep only trace-exclusive signals:

| Signal | Why it needs the trace | Check type |
|--------|----------------------|------------|
| **Exploration depth** | Did agent try alternatives or just first approach? | Heuristic: count distinct approaches before final solution |
| **Dead ends / fragility** | How many failed attempts? Rolled-back code? | Heuristic: count error → retry sequences |
| **Acknowledged-but-unhandled errors** | Agent saw an error, continued without fixing | Heuristic: error in tool result → no subsequent fix attempt |

**Bonus signals (cheap heuristics on the trace, not achievable from diff):**
| Signal | Check |
|--------|-------|
| **Session duration** | How long did the agent work? Quick = simple or sloppy? |
| **Tool call distribution** | Heavy on Read vs Write? Exploration vs execution ratio? |
| **Retry patterns** | Same command retried 3+ times = flaky approach? |

## Threat Model (MANDATORY — addresses security review gap)

### Threat: Trace contains secrets, PII, internal URLs, proprietary code

**Principle: traces are the most sensitive artifact an engineer produces.** They contain:
- Secrets pasted into prompts ("here's my API key")
- Environment variables from Bash `env` / `cat .env`
- File contents from anywhere on disk the agent touched
- Internal URLs, infra topology, customer names from grep results
- PII from any database the agent queried
- The user's thought process (prompts reveal strategy, frustration)

### Mitigations

1. **Local-only by default** — v1 does NO external API calls. All analysis is heuristic/regex. Distilled output stays on the user's machine.
2. **Redaction before any processing** — run redaction FIRST, before parsing. The parser never sees raw secrets.
3. **Prompt text summarization** — user prompts are kept (they show intent) but tool outputs (Read/Bash results) are truncated aggressively (80 chars OK, 400 chars errors)
4. **No LLM in v1** — eliminates the exfiltration channel entirely. If v2 adds LLM digest, it requires explicit `--send-to-llm` opt-in with a warning.

### What redaction covers
- Named patterns: AWS, GitHub, OpenAI, Anthropic, Stripe, Slack keys, JWTs, private keys, connection strings
- Entropy-based: Shannon entropy ≥4.0 for quoted strings ≥32 chars
- Context-aware: env assignment patterns (`SECRET_KEY=<value>`)

### What redaction DOESN'T cover (known gaps, documented)
- Short passwords (under entropy/length threshold)
- Customer names in grep results (not pattern-matchable)
- Internal hostnames (would need a custom allow/deny list)
- User prompt text itself (kept for intent analysis — documented risk)

## Architecture

### New Modules

```
src/trace/
├── parser.ts        # Claude Code JSONL parser → unified TraceSession
├── types.ts         # TraceEvent types (user, assistant, tool_use)
├── distiller.ts     # Compress traces: 4-tier classify → collapse → truncate
├── analyzer.ts      # Heuristic process checks (exploration, dead ends, errors)
└── index.ts         # Public API

src/scan/
└── redact.ts        # Enhanced with entropy detection (existing file, additive)
```

### Parser Design

**Streaming, not batch** (addresses Gemini's memory pressure concern):
- Use readline-style line-by-line parsing
- Never load full JSONL into memory
- Each line: `JSON.parse` → classify → emit or discard
- Malformed lines: skip with warning counter (addresses interrupted session edge case)

**Output: `TraceSession`**
```typescript
interface TraceSession {
  sessionId: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  events: TraceEvent[];  // Filtered, only meaningful events
  stats: TraceStats;     // Computed during parse
}

interface TraceStats {
  totalEvents: number;
  userPrompts: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  errorCount: number;
  durationMs: number | null;
}
```

### Distiller Design (improved from vibeshub)

**Key fix from Gemini review: NEVER collapse failed tool calls.** Only collapse successful exploration runs.

Four-tier classification:
1. **Drop** — noise (permission-mode, file-history-snapshot, attachment, last-prompt, ai-title)
2. **Keep full** — user prompts, assistant text
3. **Summarize** — tool calls: keep name + key input, truncate results (80 chars OK, 400 chars errors)
4. **Collapse** — runs of 6+ consecutive SUCCESSFUL tool-only events → `[exploration: N tools]`

**Write call handling** (Gemini's "large write" concern): For Write/Edit tools, keep only the file path and a size indicator (`Write src/foo.ts (2.4KB)`), not the content.

Budget:
- Target: 60K tokens
- Hard cap: 200K tokens
- Over target: collapse exploration runs
- Over hard cap: head/tail truncation with `[… elided N events …]`

### Analyzer Design (heuristic, no LLM)

```typescript
interface ProcessFinding {
  signal: string;         // e.g., "dead_end", "low_exploration", "unhandled_error"
  severity: "info" | "warning";
  description: string;
  evidence: string;       // Distilled excerpt showing the pattern
  eventIndex: number;     // Where in the trace this occurred
}
```

**Detection algorithms:**

1. **Dead ends**: Sequence of tool calls → error result → different approach attempted. Count these. Report: "Agent had N dead ends before reaching final solution. High count suggests fragility."

2. **Low exploration**: Only 1 approach attempted before implementation. Report: "Agent went with first approach without exploring alternatives."

3. **Unhandled errors**: Error in tool result → next action doesn't address it. Report: "Agent acknowledged error at [event] but continued without fixing."

4. **Retry storms**: Same command (same tool + similar input) repeated 3+ times. Report: "Agent retried [command] N times — suggests flaky approach."

5. **Session stats**: Duration, tool distribution, exploration/execution ratio as context.

### Enhanced Redaction

Additive changes to existing `src/scan/redact.ts`:

```typescript
// NEW patterns
{ name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED_JWT]' },
{ name: 'Env Assignment', regex: /([A-Z][A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD|PASS))=([A-Za-z0-9/+=_-]{16,})/g, replacement: '$1=[REDACTED_ENV]' },
{ name: 'AWS Secret Key', regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, replacement: '[REDACTED_AWS_SECRET]' },

// NEW: Shannon entropy detection for unknown tokens
function shannonEntropy(s: string): number { ... }
// Apply to quoted strings ≥32 chars with entropy ≥4.0
```

### CLI Command

```bash
agentreview trace <path-to-jsonl> [options]

Options:
  --format <fmt>     Output format: text (default), json, markdown
  --verbose          Show full distilled trace alongside findings
  --stats-only       Just show session stats, no process analysis
```

**Output format (text, default):**
```
📊 Session Summary
  Model: claude-sonnet-4-20250514 | Duration: 12m | Tools: 47 calls
  Distribution: 18 Read, 12 Write, 8 Bash, 5 Edit, 4 Grep

⚠️  Process Findings (3)

  [warning] Dead End — 2 failed approaches before final solution
    Evidence: Bash: npm test → ERR → rewrote handler → Bash: npm test → ERR → switched to async pattern
    At: events 12-28

  [warning] Retry Storm — same Bash command retried 4 times
    Evidence: Bash: tsc --noEmit (repeated 4x with same error)
    At: events 31-38

  [info] Low Exploration — single approach attempted
    Evidence: No alternative designs explored before implementation
    At: events 3-47
```

## Success Criteria

1. Correctly parses Claude Code JSONL transcripts (including edge cases: malformed lines, empty sessions, huge sessions)
2. Distiller compresses traces while preserving ALL failed tool calls
3. Heuristic analyzer detects dead ends, retry storms, unhandled errors, and low exploration
4. Enhanced redaction catches JWTs, env assignments, and high-entropy tokens
5. `agentreview trace` command works standalone, no external API calls
6. Memory-efficient: handles 100MB+ transcripts without OOM
7. Zero impact on existing `agentreview` review/scan commands
8. 100% test coverage on parser, distiller, analyzer, and enhanced redaction

## Kill Criterion

If we don't run `agentreview trace` on 10+ of our own sessions in the first month after shipping, kill it. Don't build v2.
