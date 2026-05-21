# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Per-repository configuration** (`.agentreview.yml`) — Drop a YAML config file in your repo root to set default lenses, model, fail-on severity, ignore patterns, and scan options. CLI flags and Action inputs take priority over the config file. Supports `ignore` glob patterns to exclude files (tests, migrations, generated code) from review.

- **Incremental scan with baseline** (`--baseline`, `--update-baseline`, `--baseline-path`) — First scan creates a baseline of existing findings. Subsequent scans only report NEW findings not in the baseline, preventing teams from being overwhelmed by pre-existing issues when adopting the tool. Suppressed finding counts shown in reports and CLI summary.

<<<<<<< HEAD
=======
### Added

>>>>>>> adabc40 (feat: incremental scan with baseline — suppress pre-existing findings)
- **SARIF 2.1.0 output format** (`--format sarif`) — Outputs findings in [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) format for GitHub Code Scanning integration. Findings appear inline in PR diffs and in the repository Security tab. Works with both PR review and codebase scan commands. Upload via `github/codeql-action/upload-sarif@v3`.

- **Confidence scoring & validation gates** — Findings are re-evaluated for accuracy; low-confidence results are automatically filtered. Configurable via `--validate`, `--no-validate`, and `--min-confidence <score>`.

- **Auto-fix command** (`agentreview fix`) — Review → validate → generate patch → apply → verify → revert pipeline. Supports `--dry-run` for patch preview and `--min-confidence` to limit fixes to high-confidence findings.

- **Multi-model ensemble review** (`--ensemble`) — Cross-validate findings across multiple LLM providers (e.g., `--ensemble claude-sonnet-4-20250514,gpt-4o`). Uses majority vote strategy; reports unanimous, majority, and single-source findings separately.

- **Codebase awareness** (`--codebase-context`) — Fetches repository tree and analyzes import graphs to provide broader context. Configurable token budget via `--codebase-budget`. Enabled by default; degrades gracefully on failure.

- **Codebase security scanner** (`agentreview scan`) — Deep security analysis of local directories or GitHub repos across 8 security domains (`auth`, `secrets`, `injection`, `config`, `deps`, `crypto`, `data-flow`, `general`).
  - Sandboxed filesystem scanning with configurable file limits
  - Shallow clone support for GitHub targets with `--branch` selection
  - Secret redaction via `--redact` to strip credentials before LLM submission
  - `--focus` to target specific security domains
  - `--issue` to create a GitHub issue with scan results
  - `--fail-on` for CI gate integration

- **GitHub Actions integration** (`uses: vidyasagarr7/agentreview@v1`)
  - Drop-in Action with `anthropic-api-key` or `openai-api-key` inputs
  - Comment modes: `full`, `summary`, `collapsed`
  - Step summary output with structured outputs (`findings-count`, `critical-count`, `high-count`, `exit-code`, `report`)
  - `pr-number` override for `workflow_dispatch` and `issue_comment` triggers
  - `custom-lenses-dir` support (requires `actions/checkout`)
  - `pull_request_target` security documentation

- **Google Gemini provider support** — Use `gemini-*` models with `GEMINI_API_KEY` (CLI) or `google-api-key` (GitHub Action). Auto-detected from model name. Supports 1M context window.

- **Anthropic provider support** — Auto-detects provider from model name (`claude-*` → Anthropic, `gpt-*`/`o1-*`/`o3-*` → OpenAI). Supports both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.

## [0.1.0] - Initial Release

### Added

- Multi-lens PR review with parallel execution (security, architecture, quality)
- Custom lens support via JSON definitions (`agentreview lenses add`)
- Cross-lens deduplication of findings
- Markdown and JSON output formats
- GitHub PR comment posting with upsert (`--post`)
- CI exit codes with `--fail-on` severity gate
- Data disclosure prompt with `--yes` / `AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY` bypass
