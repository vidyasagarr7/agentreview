# Design Spec: Inline PR Annotations

**Date:** 2026-05-21
**Feature:** Post findings as inline review comments on specific PR lines

---

## Problem
Currently AgentReview posts one big comment. Developers have to mentally map "file.ts:42" back to the diff. Inline annotations put findings right where the code is.

## Solution
Use GitHub's Pull Request Reviews API (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`) to submit findings as inline comments on the diff.

## Implementation

### 1. New flag: `--inline` (CLI) / `inline: true` (Action)
- When enabled, findings are posted as inline review comments instead of (or in addition to) a single comment
- Default: `false` (backward compatible)

### 2. Diff position mapping
GitHub Reviews API needs `path` + `line` (or `position` for older API). The newer API accepts:
```json
{
  "path": "src/auth/login.ts",
  "line": 42,
  "side": "RIGHT"
}
```

Parse finding.location ("file.ts:42") → { path, line }.
Only findings with parseable locations AND whose file is in the PR diff get inline comments.
Findings without valid locations fall back to the summary comment.

### 3. Review submission
```typescript
await octokit.pulls.createReview({
  owner, repo, pull_number,
  event: failOn ? 'REQUEST_CHANGES' : 'COMMENT',
  body: summaryMarkdown,  // Overview at top of review
  comments: inlineComments.map(f => ({
    path: f.parsedPath,
    line: f.parsedLine,
    side: 'RIGHT',
    body: formatInlineComment(f),
  })),
});
```

### 4. Comment format per finding
```markdown
**🔴 CRITICAL — Hardcoded Secret**
> AWS access key hardcoded in source

**Suggestion:** Use environment variables or secrets manager.

*AgentReview [security]*
```

### 5. Files needed
- `src/github/client.ts` — add `createInlineReview()` method
- `src/report/inline.ts` — map findings to diff positions, format inline comments
- `src/cli/index.ts` — add `--inline` flag
- `action.yml` + `action/src/inputs.ts` — add `inline` input
- `action/src/post-results.ts` — use inline review when enabled
