# AgentReview

[![npm version](https://img.shields.io/npm/v/agentreview.svg)](https://www.npmjs.com/package/agentreview)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Action-blue?logo=github)](https://github.com/vidyasagarr7/agentreview)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

AI-powered multi-lens code review for pull requests and codebases — security, architecture, and quality analysis with confidence scoring, auto-fix, multi-model ensemble, and GitHub Actions integration.

## Features

- 🔍 **Multi-lens PR review** — Security, architecture, and quality lenses run in parallel
- 🎯 **Confidence scoring** — Validation gate filters false positives with configurable thresholds
- 🔧 **Auto-fix** — Generate, apply, verify, and revert patches for confirmed findings
- 🤝 **Multi-model ensemble** — Cross-validate findings across multiple LLM providers
- 🧠 **Codebase awareness** — Repo tree and import graph context for smarter reviews
- 🔒 **Security scanner** — Deep codebase security analysis across 8 domains
- ⚡ **GitHub Action** — Drop-in CI/CD integration with PR comments and step summaries
- 🔌 **Custom lenses** — Write your own review perspectives as JSON
- 📝 **Multi-provider support** — Works with OpenAI, Anthropic, and Google Gemini models
- 🚀 **CI-friendly** — `--fail-on` exit codes for gate-able pipelines

## Quick Start

### GitHub Action (recommended)

```yaml
- uses: vidyasagarr7/agentreview@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### CLI

```bash
npm install -g agentreview
agentreview https://github.com/owner/repo/pull/123
```

### Using Gemini

```yaml
- uses: vidyasagarr7/agentreview@v1
  with:
    google-api-key: ${{ secrets.GEMINI_API_KEY }}
    model: gemini-2.5-flash
```

```bash
export GEMINI_API_KEY=...
agentreview https://github.com/owner/repo/pull/123 --model gemini-2.5-flash
```

## GitHub Action

### Basic Usage

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: vidyasagarr7/agentreview@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Advanced Usage

```yaml
- uses: vidyasagarr7/agentreview@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    model: claude-sonnet-4-20250514
    lenses: security,quality
    fail-on: HIGH
    validate: true
    min-confidence: 60
    codebase-context: true
    codebase-budget: 12000
    comment-mode: collapsed
    verbose: true
```

### Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `anthropic-api-key` | — | Anthropic API key (required if not using another provider key) |
| `openai-api-key` | — | OpenAI API key (required if not using another provider key) |
| `google-api-key` | — | Google AI (Gemini) API key (required if not using another provider key) |
| `model` | `claude-sonnet-4-20250514` | LLM model to use |
| `lenses` | `all` | Comma-separated lenses or `all` |
| `fail-on` | — | Fail if findings ≥ severity (`CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO`) |
| `validate` | `true` | Enable confidence scoring and validation |
| `min-confidence` | `40` | Minimum confidence score (0–100) to keep a finding |
| `codebase-context` | `true` | Enable repo tree + import graph context |
| `codebase-budget` | `8000` | Token budget for codebase context |
| `comment-mode` | `full` | PR comment mode: `full`, `summary`, or `collapsed` |
| `custom-lenses-dir` | — | Path to custom lens JSON files (requires `actions/checkout`) |
| `github-token` | `${{ github.token }}` | GitHub token for API access |
| `pr-number` | — | Override PR number (for `workflow_dispatch` or `issue_comment` triggers) |
| `verbose` | `false` | Enable verbose logging |

### Outputs

| Output | Description |
|--------|-------------|
| `findings-count` | Total number of findings |
| `critical-count` | Number of CRITICAL findings |
| `high-count` | Number of HIGH findings |
| `review-comment-id` | ID of the posted PR comment |
| `report` | Full markdown report (may be truncated if >1MB) |
| `exit-code` | `0` if clean, `2` if findings above `fail-on` threshold |

### Permissions

```yaml
permissions:
  contents: read          # Read repository content
  pull-requests: write    # Post review comments
```

> **⚠️ `pull_request_target` warning:** If you use `pull_request_target` to review PRs from forks, be aware that the workflow runs with write access to the base repository. Never pass untrusted inputs (like PR branch names) to shell commands without sanitization.

## CLI Reference

### Installation

```bash
npm install -g agentreview
```

### Review a PR

```bash
agentreview <pr-url> [options]
```

```bash
# Basic review
agentreview https://github.com/owner/repo/pull/123

# Security lens only, post to GitHub
agentreview https://github.com/owner/repo/pull/123 --lenses security --post

# JSON output to file
agentreview https://github.com/owner/repo/pull/123 --format json --output review.json

# Use Anthropic model
agentreview https://github.com/owner/repo/pull/123 --model claude-sonnet-4-20250514

# CI gate — fail on HIGH or above
agentreview https://github.com/owner/repo/pull/123 --fail-on HIGH --yes
```

#### Review Options

| Flag | Default | Description |
|------|---------|-------------|
| `--format <format>` | `markdown` | Output format: `markdown`, `json`, or `sarif` |
| `--lenses <ids>` | `all` | Comma-separated lens IDs or `all` |
| `--fail-on <severity>` | — | Exit 2 if findings ≥ severity |
| `--timeout <seconds>` | `60` | Per-agent timeout |
| `--model <model>` | `gpt-4o` | LLM model to use |
| `--post` | `false` | Post/update review comment on the PR |
| `--output <file>` | — | Write report to file |
| `--no-dedup` | `false` | Disable cross-lens deduplication |
| `--validate` / `--no-validate` | `true` | Enable/disable confidence scoring |
| `--min-confidence <score>` | `40` | Minimum confidence to keep a finding (0–100) |
| `--ensemble <models>` | — | Multi-model ensemble (comma-separated) |
| `--codebase-context` / `--no-codebase-context` | `true` | Enable/disable repo tree + import graph |
| `--codebase-budget <tokens>` | `8000` | Token budget for codebase context |
| `-v, --verbose` | `false` | Verbose progress output |
| `-y, --yes` | `false` | Skip data disclosure prompt |

### Scan a Codebase

Deep security scan of a local directory or GitHub repository across 8 security domains.

```bash
agentreview scan <target> [options]
```

```bash
# Scan a GitHub repo
agentreview scan https://github.com/owner/repo

# Scan a local directory
agentreview scan ./my-project

# Focus on specific domains with secret redaction
agentreview scan https://github.com/owner/repo --focus auth,secrets --redact

# Scan and create a GitHub issue with results
agentreview scan https://github.com/owner/repo --issue --fail-on HIGH

# Scan a specific branch
agentreview scan https://github.com/owner/repo --branch develop
```

#### Security Domains

| Domain | Focus |
|--------|-------|
| `auth` | Authentication and authorization |
| `secrets` | Hardcoded secrets and credentials |
| `injection` | SQL, command, and template injection |
| `config` | Security misconfigurations |
| `deps` | Dependency vulnerabilities |
| `crypto` | Cryptography misuse |
| `data-flow` | Sensitive data flow and exposure |
| `general` | General security patterns |

#### Scan Options

| Flag | Default | Description |
|------|---------|-------------|
| `--focus <domains>` | all | Comma-separated security domains |
| `--model <model>` | — | LLM model override |
| `--format <format>` | `markdown` | Output format: `markdown`, `json`, or `sarif` |
| `--output <file>` | — | Write report to file |
| `--fail-on <severity>` | — | Exit 2 if findings ≥ severity |
| `--redact` | `false` | Redact secret patterns before sending to LLM |
| `--issue` | `false` | Create a GitHub issue with results (GitHub targets only) |
| `--max-files <n>` | `50` | Maximum files to scan |
| `--budget <tokens>` | `100000` | Token budget for scan |
| `--branch <ref>` | — | Branch/ref to scan (GitHub targets) |
| `--timeout <seconds>` | — | Per-chunk timeout |
| `-v, --verbose` | `false` | Verbose output |
| `-y, --yes` | `false` | Skip data disclosure prompt |

### Auto-Fix Findings

Review a PR, then generate and apply patches for confirmed findings.

```bash
agentreview fix <pr-url> [options]
```

```bash
# Dry run — generate patches without applying
agentreview fix https://github.com/owner/repo/pull/123 --dry-run

# Apply fixes to a local checkout
agentreview fix https://github.com/owner/repo/pull/123 --repo-dir ./repo

# Only fix high-confidence findings
agentreview fix https://github.com/owner/repo/pull/123 --repo-dir ./repo --min-confidence 80
```

The fix pipeline: **Review → Validate → Generate patch → Apply → Verify → Revert if verification fails**.

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Generate patches without applying |
| `--repo-dir <path>` | — | Local repo checkout (required unless `--dry-run`) |
| `--min-confidence <score>` | — | Only fix findings above this confidence |
| `--model <model>` | — | LLM model override |
| `--output <file>` | — | Write fix report to file |
| `-v, --verbose` | `false` | Verbose output |
| `-y, --yes` | `false` | Skip data disclosure prompt |

### Multi-Model Ensemble

Cross-validate findings across multiple models to reduce false positives and increase confidence.

```bash
agentreview https://github.com/owner/repo/pull/123 \
  --ensemble claude-sonnet-4-20250514,gpt-4o
```

Ensemble uses a **majority vote** strategy — findings confirmed by multiple models are ranked higher. The report shows unanimous, majority, and single-source findings separately.

Requires API keys for each provider used (e.g., both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`).

### Codebase Awareness

Automatically fetches the repository tree and analyzes import graphs to give the LLM broader context about the codebase structure.

```bash
# Enabled by default — disable if you want faster reviews
agentreview https://github.com/owner/repo/pull/123 --no-codebase-context

# Increase token budget for larger repos
agentreview https://github.com/owner/repo/pull/123 --codebase-budget 16000
```

### Confidence Scoring

Validation is enabled by default. Each finding is re-evaluated for accuracy, and low-confidence findings are filtered out.

```bash
# Raise the bar — only keep findings above 70% confidence
agentreview https://github.com/owner/repo/pull/123 --min-confidence 70

# Disable validation entirely
agentreview https://github.com/owner/repo/pull/123 --no-validate
```

## Configuration

### Environment Variables

```env
# Provider keys (at least one required)
OPENAI_API_KEY=sk-...               # OpenAI API key
ANTHROPIC_API_KEY=sk-ant-...        # Anthropic API key
GEMINI_API_KEY=...                   # Google AI (Gemini) API key

# Required
GITHUB_TOKEN=ghp_...                # github.com/settings/tokens (repo or public_repo scope)

# Optional defaults
AGENTREVIEW_MODEL=gpt-4o            # Default model
AGENTREVIEW_FORMAT=markdown          # Default format (markdown|json|sarif)
AGENTREVIEW_LENSES=all               # Default lenses
AGENTREVIEW_TIMEOUT=60               # Per-agent timeout in seconds
AGENTREVIEW_FAIL_ON=HIGH             # Default fail-on severity
AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1  # Skip data disclosure prompt
```

The provider is auto-detected from the model name: `claude-*` → Anthropic, `gemini-*` → Google, `gpt-*`/`o1-*`/`o3-*` → OpenAI.

### GitHub Token Scopes

| Repo type | Required scope |
|-----------|---------------|
| Public repos | `public_repo` |
| Private repos | `repo` |

Create at: https://github.com/settings/tokens

## Built-in Lenses

| ID | Name | Focus |
|----|------|-------|
| `security` | Security | OWASP Top 10, auth, injection, secrets, crypto, data exposure |
| `architecture` | Architecture | Design patterns, coupling, API contracts, scalability |
| `quality` | Code Quality | Error handling, tests, docs, naming, complexity |

```bash
agentreview lenses list    # List all available lenses
```

## Custom Lenses

Create a JSON file:

```json
{
  "id": "performance",
  "name": "Performance Review",
  "description": "Identifies performance bottlenecks",
  "systemPrompt": "You are a performance expert. Analyze for: N+1 queries, missing indexes, inefficient algorithms, blocking I/O, and missing caching.",
  "focusAreas": ["database queries", "algorithm complexity", "caching", "I/O patterns"],
  "severity": "normal"
}
```

Install and use:

```bash
agentreview lenses add ./performance.json
agentreview https://github.com/owner/repo/pull/123 --lenses performance,security
```

Custom lenses are stored in `~/.agentreview/lenses/` and loaded automatically.

## CI/CD Integration

### GitHub Action (primary)

See [GitHub Action](#github-action) above for full configuration.

### SARIF Output (GitHub Security Tab)

AgentReview can output findings in [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) format, the standard for GitHub Code Scanning. This displays findings inline in PR diffs and in the repository's Security tab.

```bash
# Generate SARIF output
agentreview https://github.com/owner/repo/pull/123 --format sarif --output results.sarif

# Security scan with SARIF output
agentreview scan https://github.com/owner/repo --format sarif --output scan.sarif
```

**GitHub Actions integration:**

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      security-events: write  # Required for SARIF upload
    steps:
      - uses: vidyasagarr7/agentreview@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          format: sarif
          output: results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

### Manual GitHub Actions Workflow

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: vidyasagarr7/agentreview@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          fail-on: HIGH
          comment-mode: collapsed
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Review completed, no findings at or above `--fail-on` severity |
| `1` | Error (config, network, parse) |
| `2` | Findings found at or above `--fail-on` severity |

## Security & Privacy

AgentReview sends code (PR diffs or source files) to your configured LLM provider. This may include proprietary code.

- **OpenAI:** https://openai.com/policies/api-data-usage-policies
- **Anthropic:** https://www.anthropic.com/legal/privacy
- **Google:** https://ai.google.dev/terms

To suppress the interactive disclosure prompt: set `AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1` or pass `--yes`.

**Secret redaction** (scan only): Use `--redact` to strip known secret patterns before sending code to the LLM.

> **⚠️ `pull_request_target`:** If using `pull_request_target` for fork PRs, the workflow runs with write access to the base repo. Never pass untrusted inputs to shell commands.

## Development

```bash
git clone https://github.com/vidyasagarr7/agentreview
cd agentreview
npm install
npm run build
npm test          # typecheck + vitest
npm run dev       # watch mode
```

## License

[MIT](LICENSE) © [Vidya](https://github.com/vidyasagarr7)
