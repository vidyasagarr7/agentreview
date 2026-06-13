# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Active  |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **vidyasagarr7@gmail.com** with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact assessment

You should receive a response within 72 hours. We will acknowledge valid reports, keep you informed of progress, and credit you in the release notes if you wish.

## Known Dev-Dependency Advisories

### esbuild (via `tsup`) — GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr

**Status: Not applicable to production use of AgentReview**

`npm audit` reports two high-severity advisories against `esbuild` (pulled in as a dependency of `tsup`, our build tool):

| Advisory | Description | Relevant? |
|----------|-------------|-----------|
| [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr) | Missing binary integrity verification in the **Deno** module | ❌ AgentReview runs on Node.js, not Deno |
| [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | Arbitrary file read via esbuild's **dev server** on **Windows** | ❌ AgentReview doesn't run an esbuild dev server; `tsup` is invoked only during `npm run build` for bundling |

**Why we haven't force-downgraded `tsup`:**  
The suggested fix (`npm audit fix --force`) would downgrade `tsup` to v6.5.0, a breaking change that may alter bundle output. Since neither advisory affects AgentReview's runtime behavior or attack surface, the risk of a forced downgrade outweighs the benefit. We will update `tsup` once a non-breaking patch that resolves the underlying `esbuild` version is available.

**Runtime security posture:**  
AgentReview's production bundle (`dist/`) contains no `esbuild` code. The vulnerability lives entirely in the build toolchain, which is not shipped to end users.

## Production Dependency Security

AgentReview's production dependencies (those included in `dist/`) are minimal and reviewed on each release:

- All production dependencies are scanned with `npm audit --audit-level=critical` as part of CI
- Dependencies are pinned in `package-lock.json`
- The GitHub Action variant runs in a sandboxed environment with no persistent storage access

## Security Design Notes

- **No persistent data storage** — AgentReview does not write findings to disk by default
- **API keys** — passed via environment variables, never logged or included in review output
- **GitHub token scope** — only `repo:read` (pull request diffs) is required; write access is optional for posting comments
- **LLM prompt content** — code diffs are sent to the configured LLM provider; review your provider's data retention policy before using AgentReview on sensitive codebases
