# Design Spec: Codebase Security Scanner (`agentreview scan`)

**Date:** 2026-05-21
**Author:** Vex (design) — pending cross-agent review
**Status:** DRAFT — awaiting human approval

---

## 1. Problem Statement

AgentReview currently only reviews **PR diffs** through its security lens. This means:
- You can't scan a full codebase for vulnerabilities without a PR
- Pre-existing security debt in the codebase is invisible
- Teams can't run periodic security audits with the tool
- New team members can't get a security posture overview of a repo

**Goal:** Add `agentreview scan` — a command that performs a full codebase security audit on any GitHub repo or local directory.

---

## 2. User Stories

1. **As a developer**, I want to scan my repo for security issues so I can fix vulnerabilities before they become incidents.
2. **As a security engineer**, I want to run periodic codebase audits and get structured, actionable findings.
3. **As a team lead**, I want a severity-ranked security posture report for my codebase.
4. **As a CI pipeline**, I want to block deploys when critical/high severity issues exist (`--fail-on`).

---

## 3. CLI Interface

```
agentreview scan <target> [options]

Arguments:
  target    GitHub repo URL (https://github.com/owner/repo) or local path (./my-project)

Options:
  --focus <areas>         Comma-separated focus areas: auth,secrets,injection,config,deps,crypto,data-flow (default: all)
  --model <model>         LLM model override
  --format <format>       Output format: markdown | json (default: markdown)
  --output <file>         Write report to file
  --fail-on <severity>    Exit code 2 if findings at/above this severity
  --max-files <n>         Max files to analyze per chunk (default: 50)
  --budget <tokens>       Token budget per scan chunk (default: 100000)
  --branch <ref>          Branch/tag/SHA to scan (default: HEAD / default branch)
  --post <pr-url>         Post scan results as a PR comment (for tracking)
  --ensemble <models>     Multi-model scan (comma-separated)
  --timeout <seconds>     Per-chunk timeout
  -v, --verbose           Verbose output
  -y, --yes               Acknowledge data disclosure
```

### Examples
```bash
# Full security scan of a GitHub repo
agentreview scan https://github.com/myorg/myapp

# Scan local project, focus on secrets and auth
agentreview scan ./my-project --focus secrets,auth

# CI gate: fail on HIGH or above
agentreview scan https://github.com/myorg/myapp --fail-on HIGH --yes

# Multi-model for high-confidence results
agentreview scan ./my-project --ensemble claude-sonnet-4-20250514,gpt-4o
```

---

## 4. Architecture

### 4.1 New Module: `src/scan/`

```
src/scan/
  index.ts              # Public API: scanCodebase()
  discovery.ts          # File discovery + filtering + security prioritization
  chunker.ts            # Groups files into LLM-sized scan chunks by security domain
  prompts.ts            # Security scan system prompts (deeper than PR security lens)
  orchestrator.ts       # Multi-chunk scan coordination + result merging
  local-reader.ts       # Local filesystem repo reader
  types.ts              # Scan-specific types
```

### 4.2 New CLI Command: `src/cli/commands/scan.ts`

Registered as a subcommand alongside existing `lenses` and `fix` commands.

### 4.3 Data Flow

```
Target (GitHub URL or local path)
  │
  ▼
┌─────────────────────┐
│  Source Resolution   │  → GitHub API (remote) or filesystem (local)
│  + File Discovery    │  → Walk tree, filter, prioritize security-relevant files
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Chunker             │  → Group files by security domain
│                      │  → Each chunk fits within token budget
│                      │  → Priority: auth > secrets > input-handling > config > deps > general
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Scan Orchestrator   │  → Dispatch chunks to LLM in parallel (controlled concurrency)
│                      │  → Each chunk gets domain-specific security prompt
│                      │  → Parse findings from each chunk
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Consolidation       │  → Merge findings across chunks
│  + Dedup + Scoring   │  → Dedup cross-chunk duplicates
│                      │  → Apply confidence scoring + validation
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Report Renderer     │  → Reuse existing markdown/JSON renderers
│                      │  → Add scan-specific summary: risk posture, file coverage
└─────────────────────┘
```

---

## 5. Detailed Design

### 5.1 File Discovery (`discovery.ts`)

**Source abstraction:**
```typescript
interface SourceReader {
  listFiles(): Promise<FileEntry[]>;
  readFile(path: string): Promise<string | null>;
}

class GitHubSourceReader implements SourceReader { ... }   // Uses existing GitHubClient
class LocalSourceReader implements SourceReader { ... }     // Uses fs
```

**Filtering rules:**
- **Skip:** `node_modules/`, `vendor/`, `.git/`, `dist/`, `build/`, `__pycache__/`, binary files, images, fonts, lock files (`package-lock.json`, `yarn.lock`, `Gemfile.lock`)
- **Skip by extension:** `.min.js`, `.map`, `.svg`, `.png`, `.jpg`, `.woff`, `.ttf`, `.ico`, `.pdf`
- **Include all** other source files: `.ts`, `.js`, `.py`, `.go`, `.java`, `.rb`, `.rs`, `.php`, `.cs`, `.yaml`, `.yml`, `.json`, `.toml`, `.env*`, `.dockerfile`, `docker-compose*`, `.tf`, `.hcl`, etc.
- **Size cap:** Skip files > 100KB (likely generated/minified)

**Security prioritization** (determines scan order + chunk inclusion):

| Tier | Pattern | Examples |
|------|---------|---------|
| P0 — Critical | Auth, access control, crypto | `auth/`, `login`, `session`, `middleware/auth`, `crypto`, `jwt`, `oauth` |
| P1 — High | Secrets, config, env | `.env*`, `config/`, `secrets`, `credentials`, `*.key`, `*.pem`, Dockerfiles, CI configs |
| P2 — Medium | Input handling, API routes | `routes/`, `controllers/`, `handlers/`, `api/`, `graphql/`, `mutations`, `validators` |
| P3 — Normal | Data models, services | `models/`, `services/`, `repositories/`, `database/`, `migrations/` |
| P4 — Low | Tests, docs, scripts | `test/`, `spec/`, `__tests__/`, `scripts/`, `docs/` (still scanned — tests can leak secrets) |

### 5.2 Chunking Strategy (`chunker.ts`)

Files are grouped into **security domain chunks**:

```typescript
interface ScanChunk {
  id: string;                    // e.g. "auth-001"
  domain: SecurityDomain;        // auth | secrets | input-handling | config | deps | crypto | general
  files: ChunkFile[];            // { path, content, priority }
  estimatedTokens: number;
  focusPrompt: string;           // Domain-specific system prompt addendum
}
```

**Chunking algorithm:**
1. Classify each file into a security domain (based on path + content heuristics)
2. Within each domain, sort by priority tier
3. Pack files into chunks up to token budget (default 100K tokens)
4. If a single file exceeds budget, truncate to most relevant sections (top + any auth/crypto patterns found)
5. If total files exceed capacity, ensure P0-P2 files always get included; P3-P4 are best-effort

**Domain classification heuristics:**
- `auth` domain: path contains auth/login/session/jwt/oauth/permission/rbac/acl OR imports auth libraries
- `secrets` domain: `.env*`, `*config*` with credential patterns, `docker-compose*`, CI/CD configs
- `injection` domain: route handlers, controllers, query builders, template renderers
- `config` domain: infra configs (Terraform, Docker, k8s), security headers, CORS
- `deps` domain: `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`
- `crypto` domain: files importing crypto libs, certificate handling, key generation
- `general` domain: everything else

### 5.3 Security Scan Prompts (`prompts.ts`)

Each domain gets a **specialized system prompt** that goes deeper than the existing PR security lens:

**Auth domain prompt focuses on:**
- Complete auth bypass scenarios (not just "missing check" but how to exploit it)
- Session fixation, token reuse, privilege escalation chains
- Default credentials, admin backdoors
- OAuth/OIDC misconfiguration (redirect URI validation, state parameter)
- RBAC/ABAC gaps — can lower-privilege users access higher-privilege endpoints?

**Secrets domain prompt focuses on:**
- Hardcoded credentials (API keys, passwords, tokens, connection strings)
- `.env` files with secrets that shouldn't be committed
- CI/CD secrets exposure (GitHub Actions with `${{ secrets.* }}` in logs)
- Private keys, certificates in repo
- Patterns that look like rotated-but-still-present old credentials

**Injection domain prompt focuses on:**
- SQL injection (parameterized queries vs string concatenation)
- Command injection (child_process, exec, system calls)
- Path traversal (user input in file paths)
- Template injection (server-side template rendering with user input)
- NoSQL injection, LDAP injection, header injection
- XSS (reflected, stored, DOM-based)

**Config domain prompt focuses on:**
- Docker running as root, exposed ports, secrets in build args
- Terraform/k8s with overly permissive IAM, public S3 buckets
- Missing security headers (CSP, HSTS, X-Frame-Options)
- CORS misconfiguration (wildcard origins with credentials)
- Debug mode enabled in production configs

**Deps domain prompt focuses on:**
- Known vulnerable dependency versions (based on version constraints)
- Pinning practices (exact vs range — ranges can pull vulnerable patches)
- Suspicious/typosquatting package names
- Unnecessary dangerous dependencies (eval-based, native code for simple tasks)

**Crypto domain prompt focuses on:**
- Weak algorithms (MD5, SHA1 for security purposes, DES, RC4)
- Insecure random number generation for security-sensitive operations
- Missing key rotation patterns
- Certificate validation disabled (rejectUnauthorized: false)
- Timing attack vulnerability in comparison operations

### 5.4 Scan Orchestrator (`orchestrator.ts`)

```typescript
interface ScanOptions {
  focus?: SecurityDomain[];     // Filter to specific domains
  maxConcurrency: number;       // Parallel chunk processing (default: 3)
  budgetTokens: number;         // Per-chunk budget
  model?: string;
  timeout: number;
  validate: boolean;
  verbose: boolean;
}

interface ScanResult {
  target: string;
  branch: string;
  scannedAt: string;
  filesDiscovered: number;
  filesScanned: number;
  filesSkipped: number;
  chunks: ChunkResult[];
  findings: AgentFinding[];     // Reuse existing finding type
  stats: ScanStats;
  coverage: CoverageReport;     // Which security domains were covered
}
```

**Orchestration flow:**
1. Resolve source (GitHub or local) → get file list
2. Run discovery → filter + prioritize
3. Run chunker → produce scan chunks
4. Dispatch chunks to LLM (parallel, max concurrency 3 to avoid rate limits)
5. Parse findings from each chunk (reuse `parseFindings`)
6. Cross-chunk dedup (reuse existing `dedup.ts` with minor adaptation)
7. Optional: validation pass (reuse existing validator)
8. Consolidate into ScanResult

### 5.5 Report Adaptations

The existing `ConsolidatedReport` type needs a **scan variant** that includes:
- **Coverage summary:** which security domains were scanned, how many files per domain
- **Risk posture:** overall severity distribution + hotspot files (files with most findings)
- **File heat map:** top 10 files by finding count/severity

Markdown report header for scan mode:
```
# 🔒 Security Scan: owner/repo

Scanned at: 2026-05-21T07:00:00Z | Branch: main | Model: claude-sonnet-4-20250514

## Risk Posture
| Severity | Count |
|----------|-------|
| CRITICAL | 2     |
| HIGH     | 5     |
| ...      | ...   |

## Coverage
| Domain | Files Scanned | Findings |
|--------|---------------|----------|
| auth   | 12            | 3        |
| ...    | ...           | ...      |

## Hotspots
1. src/auth/middleware.ts — 3 findings (1 CRITICAL, 2 HIGH)
2. ...

## Findings
[... standard finding format ...]
```

---

## 6. Reuse from Existing Code

| Component | Reuse | Adaptation Needed |
|-----------|-------|-------------------|
| `GitHubClient` | ✅ tree, file content | Add `getDefaultBranch()` method |
| `CodebaseFetcher` | ✅ file fetching with concurrency | Increase `maxFiles` for scan mode |
| `LLMClient` | ✅ full reuse | None |
| `parseFindings` | ✅ full reuse | None |
| `dedup.ts` | ✅ mostly | Adapt for cross-chunk (not cross-lens) dedup |
| `validator.ts` | ✅ full reuse | None |
| `scorer.ts` | ✅ full reuse | None |
| `report/renderers/markdown.ts` | 🔧 partial | Add scan-specific header/summary sections |
| `report/renderers/json.ts` | 🔧 partial | Add scan metadata fields |
| `ConfigManager` | ✅ full reuse | None |
| `disclosure.ts` | ✅ full reuse | None |

**New code estimate:** ~800-1200 lines across 8 files (scan module + CLI command + types + tests).

---

## 7. Testing Strategy

### Unit Tests
- `discovery.test.ts`: file filtering, priority classification, skip rules
- `chunker.test.ts`: domain classification, chunk packing, budget enforcement, single-large-file truncation
- `prompts.test.ts`: prompt generation for each domain
- `orchestrator.test.ts`: end-to-end scan flow with mocked LLM
- `local-reader.test.ts`: local filesystem reading

### Integration Tests
- Scan a small known-vulnerable test fixture repo (create `test/fixtures/vulnerable-app/`)
- Verify findings are produced for planted vulnerabilities (hardcoded key, SQL injection, missing auth check)

### Production Test (Phase 5.5)
- Run against a real open-source repo with known vulnerabilities
- Compare findings against known CVEs/issues
- Verify false positive rate is reasonable

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Token budget blowout on large repos | High cost, slow scans | Strict budget enforcement per chunk, priority-based file selection, skip low-priority files when budget exhausted |
| Rate limiting on LLM API | Scan hangs/fails | Max concurrency of 3, exponential backoff (already in LLMClient), chunk-level retry |
| GitHub API rate limits (remote repos) | Can't fetch files | Batch tree fetches, cache aggressively, local clone fallback |
| False positives in large codebase | Noisy report | Validation pass + confidence scoring (reuse existing), domain-specific prompt tuning |
| Single file too large for context | Missed coverage | Truncation with heuristic extraction of security-relevant sections |

---

## 9. Out of Scope (Future)

- **Incremental scan** (only scan changed files since last scan) — needs state management
- **SARIF output** (for GitHub Advanced Security integration)
- **Custom scan rules** (user-defined patterns/prompts)
- **Dependency vulnerability database lookup** (integration with OSV/NVD)
- **Auto-fix for scan findings** (extend existing `fix` command)

---

## 10. Success Criteria

1. `agentreview scan` works on both GitHub URLs and local paths
2. Produces actionable, severity-ranked findings organized by security domain
3. Covers all 6 security domains (auth, secrets, injection, config, deps, crypto)
4. Handles repos up to ~500 source files within reasonable time/cost (<5 min, <$2 for Sonnet)
5. False positive rate <30% on production test against known-vulnerable repos
6. All existing tests continue to pass
7. New scan-specific tests cover discovery, chunking, and orchestration
