import * as core from '@actions/core';
import * as fs from 'fs';
import type { LLMConfig, FindingSeverity } from '../../src/types/index.js';
import { SEVERITY_ORDER } from '../../src/types/index.js';

export interface ActionInputs {
  llmConfig: LLMConfig;
  lenses: string[] | 'all';
  failOn?: FindingSeverity;
  validate: boolean;
  minConfidence: number;
  codebaseContext: boolean;
  codebaseBudget: number;
  verbose: boolean;
  customLensesDir?: string;
  githubToken: string;
  prNumber?: number;
  commentMode: 'full' | 'summary' | 'collapsed';
}

export function parseInputs(): ActionInputs {
  // --- API key & provider resolution ---
  const anthropicKey = core.getInput('anthropic-api-key');
  const openaiKey = core.getInput('openai-api-key');

  if (!anthropicKey && !openaiKey) {
    throw new Error(
      'No API key provided. Set either anthropic-api-key or openai-api-key.',
    );
  }

  // Anthropic wins when both are provided
  const provider: 'anthropic' | 'openai' = anthropicKey ? 'anthropic' : 'openai';
  const apiKey = anthropicKey || openaiKey;

  // --- Model ---
  const model = core.getInput('model') || (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');

  // Cross-provider validation
  if ((model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) && provider === 'anthropic') {
    throw new Error(
      `Model "${model}" is an OpenAI model but the resolved provider is anthropic. ` +
      'Provide openai-api-key instead of anthropic-api-key for OpenAI models.',
    );
  }
  if (model.startsWith('claude') && provider === 'openai') {
    throw new Error(
      `Model "${model}" is an Anthropic model but the resolved provider is openai. ` +
      'Provide anthropic-api-key instead of openai-api-key for Anthropic models.',
    );
  }

  // Provider-aware context tokens
  const contextTokens = provider === 'anthropic' ? 200000 : 128000;

  const llmConfig: LLMConfig = {
    provider,
    model,
    apiKey,
    timeout: 120,
    contextTokens,
  };

  // --- Lenses ---
  const lensesRaw = core.getInput('lenses') || 'all';
  const lenses: string[] | 'all' =
    lensesRaw === 'all'
      ? 'all'
      : lensesRaw.split(',').map((l) => l.trim()).filter(Boolean);

  // --- fail-on ---
  const failOnRaw = core.getInput('fail-on');
  let failOn: FindingSeverity | undefined;
  if (failOnRaw) {
    if (!SEVERITY_ORDER.includes(failOnRaw as FindingSeverity)) {
      throw new Error(
        `Invalid fail-on severity "${failOnRaw}". Must be one of: ${SEVERITY_ORDER.join(', ')}`,
      );
    }
    failOn = failOnRaw as FindingSeverity;
  }

  // --- Booleans ---
  const validate = core.getBooleanInput('validate');
  const verbose = core.getBooleanInput('verbose');
  const codebaseContext = core.getBooleanInput('codebase-context');

  // --- Numeric ---
  const minConfidenceRaw = core.getInput('min-confidence');
  const minConfidence = minConfidenceRaw ? parseInt(minConfidenceRaw, 10) : 40;

  const codebaseBudgetRaw = core.getInput('codebase-budget');
  const codebaseBudget = codebaseBudgetRaw ? parseInt(codebaseBudgetRaw, 10) : 8000;

  // --- custom-lenses-dir ---
  const customLensesDir = core.getInput('custom-lenses-dir') || undefined;
  if (customLensesDir && !fs.existsSync(customLensesDir)) {
    throw new Error(
      `custom-lenses-dir "${customLensesDir}" does not exist. ` +
      'This usually means you need to add actions/checkout as a prior step ' +
      'so the repository files are available.',
    );
  }

  // --- GitHub token ---
  const githubToken = core.getInput('github-token', { required: true });

  // --- PR number ---
  const prNumberRaw = core.getInput('pr-number');
  const prNumber = prNumberRaw ? parseInt(prNumberRaw, 10) : undefined;

  // --- comment-mode ---
  const commentModeRaw = core.getInput('comment-mode') || 'full';
  const validCommentModes = ['full', 'summary', 'collapsed'] as const;
  if (!validCommentModes.includes(commentModeRaw as typeof validCommentModes[number])) {
    throw new Error(
      `Invalid comment-mode "${commentModeRaw}". Must be one of: ${validCommentModes.join(', ')}`,
    );
  }
  const commentMode = commentModeRaw as 'full' | 'summary' | 'collapsed';

  return {
    llmConfig,
    lenses,
    failOn,
    validate,
    minConfidence,
    codebaseContext,
    codebaseBudget,
    verbose,
    customLensesDir,
    githubToken,
    prNumber,
    commentMode,
  };
}
