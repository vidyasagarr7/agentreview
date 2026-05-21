import * as core from '@actions/core';
import type { ActionInputs } from './inputs.js';
import type { PRContext } from './context.js';
import type {
  AgentFinding,
  FindingSeverity,
  FindingStats,
  ReviewConfidence,
} from '../../src/types/index.js';
import { SEVERITY_ORDER } from '../../src/types/index.js';
import { GitHubClient } from '../../src/github/client.js';
import { buildReviewContext } from '../../src/github/context-builder.js';
import { buildCodebaseContext } from '../../src/codebase/orchestrator.js';
import { LensRegistry } from '../../src/lenses/registry.js';
import { LLMClient } from '../../src/llm/client.js';
import { dispatchAgents } from '../../src/agents/dispatcher.js';
import { validateAgentResults } from '../../src/validation/validator.js';
import { consolidate } from '../../src/report/consolidator.js';
import { render } from '../../src/report/renderer.js';
import { loadRepoConfig } from '../../src/config/repo-config.js';

export interface ActionReviewResult {
  report: string;
  findings: AgentFinding[];
  stats: FindingStats;
  shouldFail: boolean;
  confidence: ReviewConfidence;
}

/**
 * Check whether any finding meets or exceeds the fail-on severity threshold.
 * SEVERITY_ORDER is ordered CRITICAL → INFO, so lower index = higher severity.
 */
function shouldFailOnFindings(
  findings: AgentFinding[],
  failOn: FindingSeverity,
): boolean {
  const thresholdIndex = SEVERITY_ORDER.indexOf(failOn);
  return findings.some(
    (f) => SEVERITY_ORDER.indexOf(f.severity) <= thresholdIndex,
  );
}

export async function runReview(
  inputs: ActionInputs,
  prContext: PRContext,
): Promise<ActionReviewResult> {
  // 1. Create GitHub client and fetch PR
  const gh = new GitHubClient(prContext.token);
  core.info(`Fetching PR #${prContext.prNumber} from ${prContext.owner}/${prContext.repo}...`);
  const pr = await gh.getPR(prContext.owner, prContext.repo, prContext.prNumber);
  core.info(`PR "${pr.title}" — ${pr.files.length} files, +${pr.additions}/-${pr.deletions}`);

  // 2. Create LLM client
  const llm = new LLMClient(inputs.llmConfig);

  // 3. Resolve lenses
  const registry = new LensRegistry();
  if (inputs.customLensesDir) {
    const custom = await registry.loadCustomLenses(inputs.customLensesDir);
    core.info(`Loaded ${custom.length} custom lens(es) from ${inputs.customLensesDir}`);
  }
  const lenses = registry.resolveLenses(inputs.lenses);
  core.info(`Running ${lenses.length} lens(es): ${lenses.map((l) => l.id).join(', ')}`);

  // 4. Load per-repo config (if workspace is checked out)
  const repoConfig = await loadRepoConfig(process.cwd());
  if (repoConfig) {
    core.info('Loaded .agentreview.yml from repository root');
    // Merge repo config with Action inputs (Action inputs take priority)
    if (!inputs.failOn && repoConfig.failOn) {
      inputs.failOn = repoConfig.failOn as FindingSeverity;
    }
    if (repoConfig.validate !== undefined && inputs.validate === true) {
      // Only apply repo config if Action input wasn't explicitly set
      // (Action defaults are true, so we can't distinguish — repo config is advisory)
    }
    if (repoConfig.minConfidence !== undefined && inputs.minConfidence === 40) {
      inputs.minConfidence = repoConfig.minConfidence;
    }
    if (repoConfig.codebaseBudget !== undefined && inputs.codebaseBudget === 8000) {
      inputs.codebaseBudget = repoConfig.codebaseBudget;
    }
  }

  // Determine ignore patterns from repo config
  const ignorePatterns = repoConfig?.ignore;

  // 4. Build review context
  const reviewContext = buildReviewContext(
    pr,
    pr.diff,
    pr.files,
    inputs.llmConfig.contextTokens,
    { ignore: ignorePatterns },
  );

  // 5. Optionally build codebase context
  if (inputs.codebaseContext) {
    core.info('Building codebase context...');
    const codebase = await buildCodebaseContext(pr, gh, {
      enabled: true,
      budgetTokens: inputs.codebaseBudget,
    });
    if (codebase) {
      reviewContext.codebase = codebase;
      core.info(`Codebase context: ${codebase.estimatedTokens} tokens, ${codebase.filesAnalyzed} files analyzed`);
    } else {
      core.warning('Codebase context could not be built — proceeding without it');
    }
  }

  // 6. Dispatch agents
  core.info('Dispatching review agents...');
  let results = await dispatchAgents(lenses, reviewContext, llm, {
    verbose: inputs.verbose,
    timeoutMs: inputs.llmConfig.timeout * 1000,
    onProgress: (lensId, status, durationMs) => {
      if (status === 'started') {
        core.info(`  [${lensId}] started`);
      } else if (status === 'completed') {
        core.info(`  [${lensId}] completed in ${((durationMs ?? 0) / 1000).toFixed(1)}s`);
      } else {
        core.warning(`  [${lensId}] failed after ${((durationMs ?? 0) / 1000).toFixed(1)}s`);
      }
    },
  });

  // 7. Optionally validate
  if (inputs.validate) {
    core.info('Validating findings...');
    results = await validateAgentResults(results, reviewContext, llm, {
      minConfidence: inputs.minConfidence,
    });
  }

  // 8. Consolidate and render
  const report = consolidate(
    results,
    pr,
    false,
    reviewContext.skippedFiles ?? [],
  );
  const rendered = render(report, 'markdown');

  // 9. Determine shouldFail
  const shouldFail = inputs.failOn
    ? shouldFailOnFindings(report.findings, inputs.failOn)
    : false;

  core.info(`Review complete — ${report.stats.total} finding(s), confidence: ${report.confidence}`);

  return {
    report: rendered,
    findings: report.findings,
    stats: report.stats,
    shouldFail,
    confidence: report.confidence,
  };
}
