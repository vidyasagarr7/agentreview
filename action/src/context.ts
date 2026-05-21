import * as github from '@actions/github';
import * as core from '@actions/core';

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
}

export function extractPRContext(inputs: {
  githubToken: string;
  prNumber?: number;
}): PRContext {
  const { owner, repo } = github.context.repo;
  const eventName = github.context.eventName;

  let prNumber: number | undefined;

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    prNumber = github.context.payload.pull_request?.number;
    core.debug(`Detected ${eventName} event, PR #${prNumber}`);
  }

  // Allow input override for any event
  if (inputs.prNumber) {
    prNumber = inputs.prNumber;
    core.debug(`Using pr-number input override: #${prNumber}`);
  }

  if (!prNumber) {
    throw new Error(
      "AgentReview requires a pull_request event or the 'pr-number' input",
    );
  }

  return { owner, repo, prNumber, token: inputs.githubToken };
}
