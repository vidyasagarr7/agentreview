import * as core from '@actions/core';
import { parseInputs } from './inputs.js';
import { extractPRContext } from './context.js';
import { runReview } from './run.js';
import { postResults } from './post-results.js';
import { setOutputs } from './outputs.js';
import type { ReviewResult } from './outputs.js';

async function main(): Promise<void> {
  try {
    core.info('🔍 AgentReview starting...');

    const inputs = parseInputs();
    core.info(`Model: ${inputs.llmConfig.model} | Lenses: ${Array.isArray(inputs.lenses) ? inputs.lenses.join(', ') : inputs.lenses}`);

    const prContext = extractPRContext(inputs);
    core.info(`Reviewing PR #${prContext.prNumber} in ${prContext.owner}/${prContext.repo}`);

    const reviewResult = await runReview(inputs, prContext);
    core.info(`Review complete: ${reviewResult.findings.length} finding(s)`);

    const postResult = await postResults(
      reviewResult.report,
      prContext,
      inputs.commentMode,
      reviewResult.stats,
    );
    core.info(`Comment ${postResult.created ? 'created' : 'updated'}: #${postResult.commentId}`);

    const result: ReviewResult = {
      report: reviewResult.report,
      findings: reviewResult.findings,
      stats: reviewResult.stats,
      commentId: postResult.commentId,
      shouldFail: reviewResult.shouldFail,
    };

    setOutputs(result);

    if (result.shouldFail) {
      core.setFailed(`AgentReview: findings at or above ${inputs.failOn} severity detected`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`AgentReview failed: ${message}`);
  }
}

main();
