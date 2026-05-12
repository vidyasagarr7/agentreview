import type { ModelConfig, ReviewContext, AgentFinding, AgentResult, Lens } from '../types/index.js';
import { LLMClient } from '../llm/client.js';
import { dispatchAgents } from '../agents/dispatcher.js';

export interface ModelReviewResult {
  label: string;
  model: string;
  findings: AgentFinding[];
  error?: string;
  durationMs: number;
}

export async function runEnsembleReview(
  models: ModelConfig[],
  lenses: Lens[],
  context: ReviewContext,
  options?: { verbose?: boolean; timeoutMs?: number },
): Promise<ModelReviewResult[]> {
  const verbose = options?.verbose ?? false;
  const timeoutMs = options?.timeoutMs ?? 120000;

  const tasks = models.map(async (modelConfig): Promise<ModelReviewResult> => {
    const start = Date.now();
    const llmClient = new LLMClient({
      provider: modelConfig.provider,
      model: modelConfig.model,
      apiKey: modelConfig.apiKey,
      timeout: timeoutMs / 1000,
      contextTokens: 128000,
    });

    const settled = await Promise.allSettled([
      dispatchAgents(lenses, context, llmClient, { verbose, timeoutMs }),
    ]);

    const durationMs = Date.now() - start;
    const result = settled[0];

    if (result.status === 'fulfilled') {
      const agentResults: AgentResult[] = result.value;
      const findings: AgentFinding[] = agentResults.flatMap((r) =>
        Array.isArray(r.findings) ? r.findings : []
      );
      return {
        label: modelConfig.label,
        model: modelConfig.model,
        findings,
        durationMs,
      };
    } else {
      const error =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      return {
        label: modelConfig.label,
        model: modelConfig.model,
        findings: [],
        error,
        durationMs,
      };
    }
  });

  return Promise.all(tasks);
}
