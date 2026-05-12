import type { FixAttempt, VerificationResult } from '../types/index.js';
import type { ReviewContext } from '../types/index.js';

type VerifyLLM = { complete(system: string, user: string): Promise<string> };

const BATCH_SIZE = 5;

interface VerifyResponse {
  findingId: string;
  passed: boolean;
  issues: string[];
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const trimmed = candidate.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const arrStart = trimmed.indexOf('[');
    const arrEnd = trimmed.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
    }
    const objStart = trimmed.indexOf('{');
    const objEnd = trimmed.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      return JSON.parse(trimmed.slice(objStart, objEnd + 1));
    }
    throw new Error('Could not parse verification response as JSON');
  }
}

function parseVerifyResponse(raw: string): VerifyResponse[] {
  const parsed = extractJson(raw);
  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : [];

  return records
    .filter(
      (r): r is { findingId: string; passed: boolean; issues: string[] } =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as { findingId?: unknown }).findingId === 'string' &&
        typeof (r as { passed?: unknown }).passed === 'boolean',
    )
    .map((r) => ({
      findingId: r.findingId,
      passed: r.passed,
      issues: Array.isArray(r.issues) ? r.issues.filter((i: unknown) => typeof i === 'string') : [],
    }));
}

function buildVerifyPrompt(
  batch: FixAttempt[],
  context: ReviewContext,
): { system: string; user: string } {
  const system = [
    'You verify code fixes. For each fix, determine if it resolves the original issue',
    'without introducing new problems. Return JSON only.',
  ].join(' ');

  const fixSummaries = batch.map((fix) => ({
    findingId: fix.findingId,
    severity: fix.finding.severity,
    summary: fix.finding.summary,
    location: fix.finding.location,
    suggestion: fix.finding.suggestion,
    patch: fix.patch,
    explanation: fix.explanation,
  }));

  const user = [
    'For each fix below, evaluate:',
    '1. Does the patch actually resolve the described issue?',
    '2. Does it introduce any new bugs, security issues, or regressions?',
    '3. Is the fix minimal and correct?',
    '',
    `PR: ${context.pr.title} (#${context.pr.number})`,
    '',
    `Fixes:\n${JSON.stringify(fixSummaries, null, 2)}`,
    '',
    'Return exactly: [{"findingId":"id","passed":true/false,"issues":["any issues"]}]',
  ].join('\n');

  return { system, user };
}

export async function verifyFixes(
  fixes: FixAttempt[],
  context: ReviewContext,
  llm: VerifyLLM,
): Promise<VerificationResult[]> {
  const applicable = fixes.filter((f) => f.status === 'applied' || f.status === 'pending');
  if (applicable.length === 0) return [];

  const results: VerificationResult[] = [];

  for (let i = 0; i < applicable.length; i += BATCH_SIZE) {
    const batch = applicable.slice(i, i + BATCH_SIZE);
    const { system, user } = buildVerifyPrompt(batch, context);

    try {
      const raw = await llm.complete(system, user);
      const parsed = parseVerifyResponse(raw);
      const byId = new Map(parsed.map((r) => [r.findingId, r]));

      for (const fix of batch) {
        const result = byId.get(fix.findingId);
        results.push(
          result ?? { findingId: fix.findingId, passed: false, issues: ['Verification response missing for this fix'] },
        );
      }
    } catch {
      // On failure, mark all in batch as failed
      for (const fix of batch) {
        results.push({ findingId: fix.findingId, passed: false, issues: ['Verification call failed'] });
      }
    }
  }

  return results;
}
