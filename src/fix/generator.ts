import type { AgentFinding, ReviewContext, FixAttempt } from '../types/index.js';

type FixLLM = { complete(system: string, user: string): Promise<string> };

export interface FixGeneratorOptions {
  maxAttempts?: number;
  dryRun?: boolean;
}

const FIXABLE_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM']);
const FIXABLE_DISPOSITIONS = new Set(['confirmed', 'uncertain', undefined, 'unvalidated']);

export function isFixable(finding: AgentFinding): boolean {
  return (
    FIXABLE_SEVERITIES.has(finding.severity) &&
    FIXABLE_DISPOSITIONS.has(finding.disposition) &&
    finding.disposition !== 'disproven'
  );
}

export function extractPatch(raw: string): string {
  // Try code-fenced diff first
  const fenced = raw.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  // Try bare unified diff (starts with --- or diff --git)
  const diffStart = raw.match(/((?:diff --git|---)\s[\s\S]*)/);
  if (diffStart) return diffStart[1].trim();

  return raw.trim();
}

function fileFromLocation(location: string): string {
  return location.split(':')[0].trim();
}

function relevantPatch(finding: AgentFinding, context: ReviewContext): string {
  const file = fileFromLocation(finding.location);
  const match = context.pr.files.find(
    (f) => f.filename === file || f.filename.endsWith(file)
  );
  return match?.patch ?? '';
}

function buildFixPrompt(
  finding: AgentFinding,
  filePatch: string,
): { system: string; user: string } {
  const system = [
    'You are a code fixer. Generate a minimal unified diff patch that fixes ONLY the described issue.',
    'Do not refactor unrelated code. Do not change formatting. Be surgical.',
    'Return the patch inside a ```diff code fence.',
    'After the patch, add a one-line explanation starting with "Explanation:".',
  ].join(' ');

  const user = [
    `## Issue to Fix`,
    `**ID:** ${finding.id}`,
    `**Severity:** ${finding.severity}`,
    `**Location:** ${finding.location}`,
    `**Summary:** ${finding.summary}`,
    `**Detail:** ${finding.detail}`,
    `**Suggestion:** ${finding.suggestion}`,
    ``,
    `## Current Code (diff patch)`,
    '```diff',
    filePatch || '(no patch available)',
    '```',
    ``,
    `Generate a unified diff patch that fixes this issue. Be minimal.`,
  ].join('\n');

  return { system, user };
}

function extractExplanation(raw: string): string {
  const match = raw.match(/Explanation:\s*(.+)/i);
  return match?.[1]?.trim() ?? 'Fix applied for the described issue.';
}

export async function generateFixes(
  findings: AgentFinding[],
  context: ReviewContext,
  llm: FixLLM,
  options: FixGeneratorOptions = {},
): Promise<FixAttempt[]> {
  const fixable = findings.filter(isFixable);
  const fixes: FixAttempt[] = [];

  for (const finding of fixable) {
    const filePatch = relevantPatch(finding, context);
    const { system, user } = buildFixPrompt(finding, filePatch);

    try {
      const raw = await llm.complete(system, user);
      const patch = extractPatch(raw);
      const explanation = extractExplanation(raw);

      fixes.push({
        findingId: finding.id,
        finding,
        patch,
        explanation,
        status: 'pending',
      });
    } catch {
      fixes.push({
        findingId: finding.id,
        finding,
        patch: '',
        explanation: 'Fix generation failed.',
        status: 'failed',
      });
    }
  }

  return fixes;
}
