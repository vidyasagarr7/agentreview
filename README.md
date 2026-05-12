# AgentReview

Multi-perspective automated PR review using parallel AI agents — security, architecture, and code quality lenses running in parallel against any GitHub PR.

## Features

- 🔴 **Security lens** — auth flaws, injection risks, secret exposure, insecure patterns
- 🏗️ **Architecture lens** — design violations, coupling, scalability, API contracts
- ✅ **Quality lens** — error handling, test coverage, documentation, maintainability
- 🔌 **Custom lenses** — write your own JSON lens definitions
- 🚀 **Parallel execution** — all lenses run concurrently for speed
- 🔁 **Smart dedup** — cross-lens duplicate findings are merged automatically
- 📝 **Markdown & JSON output** — pipe to files, CI artifacts, or post directly to GitHub
- ⚡ **CI-friendly** — `--fail-on` exit code 2 for gate-able pipelines

## Installation

### From npm

```bash
npm install -g agentreview
```

### From source

```bash
git clone https://github.com/your-org/agentreview
cd agentreview
npm install
npm run build
npm link
```

## Configuration

AgentReview needs two API tokens. Set them as environment variables or in a `.env` file in your working directory.

```env
# Required
GITHUB_TOKEN=ghp_...          # github.com/settings/tokens (repo or public_repo scope)
OPENAI_API_KEY=sk-...         # platform.openai.com/api-keys

# Optional
AGENTREVIEW_MODEL=gpt-4o      # default model
AGENTREVIEW_FORMAT=markdown   # default output format (markdown|json)
AGENTREVIEW_LENSES=all        # default lenses (all or comma-separated IDs)
AGENTREVIEW_TIMEOUT=60        # per-agent timeout in seconds
AGENTREVIEW_FAIL_ON=HIGH      # default fail-on severity for CI use
AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1  # skip data disclosure prompt
```

### GitHub Token Scopes

| Repo type | Required scope |
|-----------|---------------|
| Public repos | `public_repo` |
| Private repos | `repo` |

Create at: https://github.com/settings/tokens

## Usage

```bash
agentreview <pr-url> [options]
```

### Basic review

```bash
agentreview https://github.com/owner/repo/pull/123
```

### Run specific lenses only

```bash
agentreview https://github.com/owner/repo/pull/123 --lenses security,quality
```

### Output as JSON

```bash
agentreview https://github.com/owner/repo/pull/123 --format json
```

### Save to file

```bash
agentreview https://github.com/owner/repo/pull/123 --output review.md
```

### Post review comment to GitHub

```bash
agentreview https://github.com/owner/repo/pull/123 --post
```

If a previous AgentReview comment exists on the PR, it will be updated in place rather than creating a new one.

### CI/CD gate — fail on severity

```bash
agentreview https://github.com/owner/repo/pull/123 --fail-on HIGH
# exits 0 if no HIGH/CRITICAL findings, exits 2 if any are found
```

### Non-interactive / skip disclosure prompt

```bash
agentreview https://github.com/owner/repo/pull/123 --yes
# or set AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1
```

### Use a different model

```bash
agentreview https://github.com/owner/repo/pull/123 --model gpt-4-turbo
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--format <format>` | `markdown` | Output format: `markdown` or `json` |
| `--lenses <ids>` | `all` | Comma-separated lens IDs or `all` |
| `--fail-on <severity>` | — | Exit 2 if findings ≥ severity (CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO) |
| `--timeout <seconds>` | `60` | Per-agent timeout in seconds |
| `--model <model>` | `gpt-4o` | Override LLM model |
| `--post` | `false` | Post/update review comment on the PR |
| `--output <file>` | — | Write report to file instead of stdout |
| `--no-dedup` | `false` | Disable cross-lens finding deduplication |
| `-v, --verbose` | `false` | Enable verbose progress output |
| `-y, --yes` | `false` | Skip data disclosure prompt |

## Built-in Lenses

| ID | Name | Focus |
|----|------|-------|
| `security` | Security Review | Auth, injection, secrets, crypto, input validation |
| `architecture` | Architecture Review | Design patterns, coupling, API contracts, scalability |
| `quality` | Code Quality Review | Error handling, tests, docs, naming, complexity |

List all available lenses:

```bash
agentreview lenses list
```

## Custom Lenses

Create a JSON file defining your lens:

```json
{
  "id": "performance",
  "name": "Performance Review",
  "description": "Identifies performance bottlenecks and inefficiencies",
  "systemPrompt": "You are a performance engineering expert. Analyze the PR diff for: N+1 queries, missing indexes, inefficient algorithms, unnecessary allocations, blocking I/O, and missing caching opportunities.",
  "focusAreas": ["database queries", "algorithm complexity", "caching", "I/O patterns"],
  "severity": "normal"
}
```

Install it:

```bash
agentreview lenses add ./performance.json
```

Custom lenses are stored in `~/.agentreview/lenses/` and automatically loaded on each run.

## Output Examples

### Markdown (default)

```
# AgentReview — owner/repo#123

**Fix: typo in auth logic** · Opened by alice · 3 files, +142/-18

| Severity | Count | Meaning |
|----------|-------|---------|
| 🔴 CRITICAL | 1 | Must fix before merge |
| 🟠 HIGH | 2 | Should fix before merge |

### 🔴 [security] Hardcoded secret in config file

**Location:** `src/config.ts:42`
**Category:** Secret Exposure

The API key is hardcoded as a string literal and will be committed to the repository...

> **Suggestion:** Move the secret to an environment variable and use `process.env.API_KEY`.
```

### JSON

```bash
agentreview https://github.com/owner/repo/pull/123 --format json | jq '.stats'
```

```json
{
  "total": 3,
  "bySeverity": { "CRITICAL": 1, "HIGH": 2, "MEDIUM": 0, "LOW": 0, "INFO": 0 },
  "byLens": { "security": 2, "architecture": 1 },
  "cleanLenses": ["quality"],
  "erroredLenses": [],
  "parseErrorLenses": []
}
```

## CI/CD Integration

### GitHub Actions

```yaml
- name: AgentReview
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY: "1"
  run: |
    npx agentreview ${{ github.event.pull_request.html_url }} \
      --fail-on HIGH \
      --post \
      --yes
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Review completed, no findings at or above `--fail-on` severity |
| `1` | Error (config, network, parse) |
| `2` | Findings found at or above `--fail-on` severity |

## Data Privacy

AgentReview sends PR diffs to your configured LLM provider (default: OpenAI). This may include proprietary code. Review the data policies:

- OpenAI: https://openai.com/policies/api-data-usage-policies
- Anthropic: https://www.anthropic.com/legal/privacy

To suppress the interactive prompt, set `AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1`.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run dev
```

## License

MIT
