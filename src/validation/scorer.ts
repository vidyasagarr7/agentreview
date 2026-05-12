import type { AgentFinding, ReviewContext } from '../types/index.js';
import type { LLMClient } from '../llm/client.js';

type ValidationLLM = Pick<LLMClient, 'complete'>;

interface ScoreResponse {
  id: string;
  confidenceScore: number;
}

const BATCH_SIZE = 10;
const MAX_PATCH_CHARS = 7000;

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function fileFromLocation(location: string): string {
  return location.split(':')[0].trim();
}

function compactFinding(finding: AgentFinding): Record<string, unknown> {
  return {
    id: finding.id,
    severity: finding.severity,
    category: finding.category,
    location: finding.location,
    summary: finding.summary,
    detail: finding.detail,
    suggestion: finding.suggestion,
    lenses: finding.lenses,
  };
}

function relevantDiffForBatch(batch: AgentFinding[], context: ReviewContext): string {
  const files = new Set(batch.map((finding) => fileFromLocation(finding.location)).filter(Boolean));
  const patches = context.pr.files
    .filter((file) => files.has(file.filename) && file.patch)
    .map((file) => `diff for ${file.filename}\n${file.patch}`)
    .join('\n\n');

  const evidence = patches || context.diff;
  return evidence.length > MAX_PATCH_CHARS
    ? `${evidence.slice(0, MAX_PATCH_CHARS)}\n...[truncated for validation]`
    : evidence;
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const trimmed = candidate.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }

    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }

    throw new Error('Validation response did not contain JSON');
  }
}

function parseScores(raw: string): ScoreResponse[] {
  const parsed = extractJson(raw);
  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { scores?: unknown }).scores)
      ? (parsed as { scores: unknown[] }).scores
      : [];

  return records
    .filter((record): record is { id: string; confidenceScore: number } =>
      !!record &&
      typeof record === 'object' &&
      typeof (record as { id?: unknown }).id === 'string' &&
      typeof (record as { confidenceScore?: unknown }).confidenceScore === 'number'
    )
    .map((record) => ({
      id: record.id,
      confidenceScore: clampScore(record.confidenceScore),
    }));
}

function buildValidationPrompt(batch: AgentFinding[], context: ReviewContext): { system: string; user: string } {
  const system = [
    'You validate existing code review findings cheaply.',
    'Do not find new issues. Do not re-review the PR.',
    'Only judge whether each alleged finding is supported by the provided diff evidence.',
    'Return compact JSON only.',
  ].join(' ');

  const user = [
    'For each finding, assign confidenceScore 0-100 based on:',
    '- whether this is a real bug rather than a false positive',
    '- whether the cited location is correct',
    '- whether the suggestion is actionable',
    '',
    'This is an evidence audit, not another lens review. Penalize speculative claims.',
    '',
    `Changed files:\n${context.fileList}`,
    '',
    `Relevant diff:\n${relevantDiffForBatch(batch, context)}`,
    '',
    `Findings:\n${JSON.stringify(batch.map(compactFinding))}`,
    '',
    'Return exactly: {"scores":[{"id":"finding id","confidenceScore":0}]}',
  ].join('\n');

  return { system, user };
}

export async function scoreFindings(
  findings: AgentFinding[],
  context: ReviewContext,
  llm: ValidationLLM
): Promise<AgentFinding[]> {
  if (findings.length === 0) return [];

  const scored: AgentFinding[] = [];

  for (let i = 0; i < findings.length; i += BATCH_SIZE) {
    const batch = findings.slice(i, i + BATCH_SIZE);
    const { system, user } = buildValidationPrompt(batch, context);
    const raw = await llm.complete(system, user);
    const scores = new Map(parseScores(raw).map((score) => [score.id, score.confidenceScore]));

    scored.push(...batch.map((finding) => ({
      ...finding,
      confidenceScore: scores.get(finding.id),
      disposition: 'unvalidated' as const,
    })));
  }

  return scored;
}
