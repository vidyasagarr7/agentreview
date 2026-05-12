import type { Lens, ReviewContext } from '../types/index.js';

const JSON_SCHEMA_INSTRUCTION = `
## Required Output Format

Return ONLY a valid JSON array of findings. No prose, no markdown outside the JSON. Each finding must have:
- "id": string (unique slug like "sec-001")
- "severity": one of "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
- "category": string (brief category label)
- "location": string (file:line or "general")
- "summary": string (one concise line, max 120 chars)
- "detail": string (explanation with evidence from the diff)
- "suggestion": string (concrete actionable fix)

If there are no issues for your lens, return exactly: []
`.trim();

export function buildPrompt(
  lens: Lens,
  context: ReviewContext
): { system: string; user: string } {
  const { pr, diff, fileList, truncated, truncationNote } = context;

  const system = `${lens.systemPrompt}

${JSON_SCHEMA_INSTRUCTION}`;

  const stateWarnings: string[] = [];
  if (pr.isDraft) stateWarnings.push('⚠️ This is a DRAFT PR.');
  if (pr.state === 'merged') stateWarnings.push('ℹ️ This PR is already merged.');
  if (pr.state === 'closed') stateWarnings.push('ℹ️ This PR is closed.');

  const truncationWarning = truncated && truncationNote
    ? `\n⚠️ ${truncationNote}\n`
    : '';

  const user = `PR #${pr.number}: ${pr.title}
Repository: ${pr.repoOwner}/${pr.repoName}
Author: ${pr.author}
Base branch: ${pr.baseBranch} ← ${pr.headBranch}
Labels: ${pr.labels.length > 0 ? pr.labels.join(', ') : '(none)'}
Stats: +${pr.additions} additions / -${pr.deletions} deletions
${stateWarnings.length > 0 ? stateWarnings.join('\n') + '\n' : ''}
## PR Description
${pr.body || '(no description provided)'}

## Changed Files (${pr.files.length} files)
${fileList}
${truncationWarning}
## Diff
${diff}`;

  return { system, user };
}
