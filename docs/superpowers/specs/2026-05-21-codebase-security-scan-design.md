# Design Spec: Codebase Security Scanner (`agentreview scan`)

**Date:** 2026-05-21
**Author:** Vex (design)
**Status:** REVISED — incorporates design review findings (8 issues addressed)
**Reviewer:** Subagent (security engineer / software architect) — Rating: 7/10 → SHIP WITH CHANGES

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
  --redact                Mask known secret patterns (AKIA*, ghp_*, sk-*, etc.) before sending to LLM
  --issue                 Create a GitHub Issue with scan results (for tracking)
  --ensemble <models>     Multi-model scan (comma-separated)
  --timeout <seconds>     Per-chunk timeout
  -v, --verbose           Verbose output with progress reporting
  -y, --yes               Acknowledge data disclosure (scan-specific warning)
```

### Examples
```bash
# Full security scan of a GitHub repo
agentreview scan https://github.com/myorg/myapp

# Scan local project, focus on secrets and auth
agentreview scan ./my-project --focus secrets,auth

# CI gate: fail on HIGH or above
agentreview scan https://github.com/myorg/myapp --fail-on HIGH --yes

# Scan with secret redaction (safer for sensitive repos)
agentreview scan ./my-project --focus secrets,auth --redact

# Multi-model for high-confidence results
agentreview scan ./my-project --ensemble claude-sonnet-4-20250514,gpt-4o

# Create a GitHub Issue with results
agentreview scan https://github.com/myorg/myapp --issue
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
  local-reader.ts       # Local filesystem repo reader (with sandbox enforcement)
  clone.ts              # Shallow-clone helper for remote repos
  dedup-scan.ts         # Scan-specific cross-chunk dedup (location-proximity + domain-aware)
  redact.ts             # Secret pattern redaction before LLM transmission
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
│  Source Resolution   │  → Shallow clone (remote) or sandboxed filesystem (local)
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
  cleanup?(): Promise<void>;  // For clone-based readers: remove temp dir
}

class CloneSourceReader implements SourceReader { ... }    // git clone --depth 1, then read locally
class LocalSourceReader implements SourceReader { ... }     // Sandboxed local fs reads
```

**Remote repos use shallow clone (not per-file API fetching):**
- `git clone --depth 1 --branch <ref> <url> <tmpdir>` — one operation, no API rate limits
- After clone, use `LocalSourceReader` against the cloned directory
- Cleanup: remove temp dir after scan completes (or on error)
- Fallback: if `git` is not available, fall back to GitHub API with backpressure (track `x-ratelimit-remaining`, throttle at <100)

**⚠️ SECURITY: Filesystem sandboxing (Finding 1 — CRITICAL):**

All local file reads MUST be sandboxed:
```typescript
class LocalSourceReader implements SourceReader {
  private rootReal: string;  // realpath-resolved root

  constructor(targetPath: string) {
    this.rootReal = fs.realpathSync(path.resolve(targetPath));
  }

  async readFile(relPath: string): Promise<string | null> {
    const abs = path.resolve(this.rootReal, relPath);
    const real = await fs.promises.realpath(abs);
    // JAIL CHECK: resolved path must be within root
    if (!real.startsWith(this.rootReal + path.sep) && real !== this.rootReal) {
      return null;  // Symlink escape — skip silently
    }
    const stat = await fs.promises.lstat(abs);
    if (!stat.isFile()) return null;  // Skip non-regular files (devices, pipes, etc.)
    return fs.promises.readFile(real, 'utf-8');
  }
}
```

This prevents:
- **Symlink traversal:** Symlinks resolving outside the root are rejected
- **Path traversal:** All paths are resolved against the canonicalized root
- **Device files:** Only regular files are read (`stat.isFile()` check)

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

**Token estimation strategy:**
- Use `chars / 4` heuristic (conservative for code, matches existing `context-builder.ts` approach)
- Apply **85% safety margin**: pack to 85K tokens on a 100K budget, reserving 15K for system prompt + response tokens
- This is model-agnostic; the heuristic is close enough for both GPT and Claude tokenizers on code

**Chunking algorithm:**
1. Classify each file into a security domain (based on path + content heuristics)
2. Within each domain, sort by priority tier
3. Pack files into chunks up to token budget × 0.85 (safety margin)
4. If a single file exceeds budget, use **head+tail truncation**: take first N/2 tokens (imports, declarations, class headers) + last N/2 tokens (exports, main logic, route registration). This captures the most security-relevant parts of any file without language-specific parsing.
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

**Progress reporting:**
The orchestrator exposes progress callbacks (same pattern as existing `dispatcher.ts`):
```typescript
onProgress?: (chunkId: string, status: 'started' | 'completed' | 'failed', meta?: {
  domain: SecurityDomain;
  fileCount: number;
  durationMs?: number;
  findingCount?: number;
}) => void;
```
CLI displays: `[2/8 chunks] Scanning auth domain... (12 files)` → `[2/8 chunks] ✓ auth done (3.2s, 4 findings)`

**Orchestration flow:**
1. Resolve source: shallow clone (remote) or sandboxed local reader
2. Run discovery → filter + prioritize
3. Optional: apply `--redact` — run `redact.ts` regex patterns over file contents before chunking
4. Run chunker → produce scan chunks
5. Dispatch chunks to LLM (parallel, max concurrency 3 to avoid rate limits)
6. Parse findings from each chunk (reuse `parseFindings`)
7. **Scan-specific cross-chunk dedup** (`dedup-scan.ts`) — NOT reusing `dedup.ts` directly:
   - Location-proximity: findings on same file within ±5 lines = likely same issue → merge
   - Cross-domain correlation: same file + similar category across domains → merge, keep highest severity
   - No lens-based grouping (chunks map to domains, not lenses)
8. Optional: validation pass (reuse existing validator)
9. Consolidate into ScanResult
10. Cleanup: remove shallow clone temp dir if applicable

### 5.5 Secret Redaction (`redact.ts`)

When `--redact` is enabled, file contents are processed before being sent to the LLM:

```typescript
const REDACT_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  { name: 'GitHub Token', regex: /ghp_[a-zA-Z0-9]{36}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { name: 'OpenAI Key', regex: /sk-[a-zA-Z0-9]{48}/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { name: 'Generic Secret', regex: /(?<=['"])[a-zA-Z0-9+/]{40,}={0,2}(?=['"])/g, replacement: '[REDACTED_BASE64]' },
  { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { name: 'Connection String', regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/g, replacement: '[REDACTED_CONN_STRING]' },
];
```

The LLM can still detect *that* a hardcoded secret exists (it sees the `[REDACTED_*]` placeholder) without the actual secret value being transmitted. This significantly reduces the risk of sending real credentials to third-party APIs.

### 5.6 Enhanced Data Disclosure

Scan mode uses a **separate disclosure prompt** from PR review mode:

```
⚠️  CODEBASE SCAN DATA DISCLOSURE

This scan will read and send the FULL CONTENTS of source files to an external
LLM API ({provider}). This is a broader scope than PR diff review.

Estimated: {fileCount} files will be sent to {provider} ({model}).

This may include:
  • Source code (proprietary logic, algorithms)
  • Configuration files (potentially containing partial secrets)
  • Environment files (.env, docker-compose) if present

Recommendation: Use --redact to mask known secret patterns before transmission.

Do you acknowledge and wish to proceed? (y/N)
```

For `--focus secrets` specifically, an additional warning:
```
⚠️  The 'secrets' focus area intentionally reads files likely to contain credentials.
   Use --redact to prevent actual secret values from being sent to the LLM.
```

### 5.7 Report Adaptations

The existing `ConsolidatedReport` type needs a **scan variant** that includes:
- **Coverage summary:** which security domains were scanned, how many files per domain
- **Risk posture:** overall severity distribution + hotspot files (files with most findings)
- **File heat map:** top 10 files by finding count/severity

**Output options:**
- `--output <file>`: Write report to local file (primary for large scans)
- `--issue`: Create a GitHub Issue with scan results (better than PR comments for codebase-wide findings; includes severity labels)
- `stdout`: Default when no `--output` or `--issue` specified

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
| `GitHubClient` | 🔧 minimal | Add `getDefaultBranch()` method. NOT used for bulk file fetching (use shallow clone instead) |
| `CodebaseFetcher` | ❌ not reused for scan | Scan uses shallow clone + local reader instead of per-file API fetching |
| `LLMClient` | ✅ full reuse | None |
| `parseFindings` | ✅ full reuse | None |
| `dedup.ts` | 🔧 **new scan-specific** | Cross-chunk dedup needs location-proximity + domain-aware merging (see `dedup-scan.ts`) |
| `validator.ts` | ✅ full reuse | None |
| `scorer.ts` | ✅ full reuse | None |
| `report/renderers/markdown.ts` | 🔧 partial | Add scan-specific header/summary sections |
| `report/renderers/json.ts` | 🔧 partial | Add scan metadata fields |
| `ConfigManager` | ✅ full reuse | None |
| `disclosure.ts` | 🔧 extended | Add scan-specific disclosure warning about full file contents being sent to LLM |

**New code estimate:** ~1200-1600 lines across 12 files (scan module + CLI command + types + tests + dedup + redact + clone).

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

### Sandboxing Tests
- `local-reader.test.ts`: symlink escape detection, path traversal rejection, non-regular file skip
- Test with symlink pointing outside root → must return null
- Test with `../../../etc/passwd` relative path → must return null

### Redaction Tests
- `redact.test.ts`: verify all pattern types are caught and replaced
- Verify redacted content still allows LLM to identify secret presence
- Verify non-secret content passes through unchanged

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
| GitHub API rate limits (remote repos) | Can't fetch files | **Primary: shallow clone** (1 git operation). Fallback: API with `x-ratelimit-remaining` backpressure |
| False positives in large codebase | Noisy report | Validation pass + confidence scoring (reuse existing), domain-specific prompt tuning |
| Single file too large for context | Missed coverage | Head+tail truncation (imports/declarations + exports/main logic) |

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
