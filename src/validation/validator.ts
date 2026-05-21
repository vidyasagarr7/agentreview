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

  return findings.map((finding) => {
    // Deterministic findings skip validation — always confirmed
    if (finding.deterministic) {
      return { ...finding, disposition: 'confirmed' as FindingDisposition };
    }
    return {
      ...finding,
      disposition: dispositionForScore(finding.confidenceScore, minConfidence),
    };
  });
}

export async function validateAgentResults(
  results: AgentResult[],
  context: ReviewContext,
  llm: ValidationLLM,
  options: ValidationOptions = {}
): Promise<AgentResult[]> {
  const allFindings = results.flatMap((result) => (Array.isArray(result.findings) ? result.findings : []));
  if (allFindings.length === 0) return results;

  // Separate deterministic findings — they skip LLM scoring entirely
  const llmFindings = allFindings.filter((f) => !f.deterministic);
  const deterministicFindings = allFindings.filter((f) => f.deterministic);

  // Score only non-deterministic findings via LLM
  const scoredLlm = llmFindings.length > 0
    ? applyValidationGate(await scoreFindings(llmFindings, context, llm), options)
    : [];

  // Deterministic findings are always confirmed
  const scoredDeterministic = deterministicFindings.map((f) => ({
    ...f,
    disposition: 'confirmed' as FindingDisposition,
  }));

  const byId = new Map(
    [...scoredLlm, ...scoredDeterministic].map((finding) => [finding.id, finding]),
  );

  return results.map((result) => {
    if (!Array.isArray(result.findings)) return result;
    return {
      ...result,
      findings: result.findings.map((finding) => byId.get(finding.id) ?? finding),
    };
  });
}
