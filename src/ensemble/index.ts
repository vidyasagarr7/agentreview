import { runEnsembleReview } from './orchestrator.js';
import { normalizeFindings } from './normalizer.js';
import { mergeFindings } from './merger.js';
import type { EnsembleConfig, ReviewContext, Lens, EnsembleResult } from '../types/index.js';

export async function runEnsemble(
  config: EnsembleConfig,
  lenses: Lens[],
  context: ReviewContext,
  options?: { verbose?: boolean },
): Promise<EnsembleResult> {
  const verbose = options?.verbose ?? false;

  // Run all models in parallel
  const modelResults = await runEnsembleReview(
    config.models,
    lenses,
    context,
    { verbose, timeoutMs: config.timeout * 1000 },
  );

  // Normalize findings per model into ModelFinding[]
  const allNormalized = modelResults.map(result =>
    normalizeFindings(result.findings, result.label),
  );

  // Merge across models
  const mergedFindings = mergeFindings(allNormalized, {
    strategy: config.strategy,
    totalModels: config.models.length,
  });

  // Compute stats
  const modelsRun = modelResults.length;
  const modelsSucceeded = modelResults.filter(r => !r.error).length;
  const totalRawFindings = allNormalized.reduce((sum, arr) => sum + arr.length, 0);
  const totalModels = config.models.length;

  const unanimousFindings = mergedFindings.filter(f => f.agreementCount === totalModels).length;
  const majorityFindings = mergedFindings.filter(f => f.agreementCount > 1 && f.agreementCount < totalModels).length;
  const singleSourceFindings = mergedFindings.filter(f => f.agreementCount === 1).length;

  return {
    modelResults,
    mergedFindings,
    stats: {
      modelsRun,
      modelsSucceeded,
      totalRawFindings,
      mergedFindings: mergedFindings.length,
      unanimousFindings,
      majorityFindings,
      singleSourceFindings,
    },
  };
}
