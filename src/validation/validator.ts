import type { AgentFinding, AgentResult, FindingDisposition, ReviewContext } from '../types/index.js';
import type { LLMClient } from '../llm/client.js';
import { scoreFindings } from './scorer.js';

type ValidationLLM = Pick<LLMClient, 'complete'>;

export interface ValidationOptions {
  minConfidence?: number;
}

function dispositionForScore(score: number | undefined, minConfidence: number): FindingDisposition {
  if (score === undefined) return 'unvalidated';
  if (score < minConfidence || score < 40) return 'disproven';
  if (score < 60) return 'uncertain';
  return 'confirmed';
}

export function applyValidationGate(
  findings: AgentFinding[],
  options: ValidationOptions = {}
): AgentFinding[] {
  const minConfidence = options.minConfidence ?? 40;

  return findings.map((finding) => ({
    ...finding,
    disposition: dispositionForScore(finding.confidenceScore, minConfidence),
  }));
}

export async function validateAgentResults(
  results: AgentResult[],
  context: ReviewContext,
  llm: ValidationLLM,
  options: ValidationOptions = {}
): Promise<AgentResult[]> {
  const findings = results.flatMap((result) => (Array.isArray(result.findings) ? result.findings : []));
  if (findings.length === 0) return results;

  const scored = applyValidationGate(
    await scoreFindings(findings, context, llm),
    options
  );
  const byId = new Map(scored.map((finding) => [finding.id, finding]));

  return results.map((result) => {
    if (!Array.isArray(result.findings)) return result;
    return {
      ...result,
      findings: result.findings.map((finding) => byId.get(finding.id) ?? finding),
    };
  });
}
