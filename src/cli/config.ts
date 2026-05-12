import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import type { LLMConfig, FindingSeverity } from '../types/index.js';

// Load .env from current working directory
loadDotenv({ path: resolve(process.cwd(), '.env') });

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4-turbo-preview': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
};

const DEFAULT_MODEL_CONTEXT = 128000;

export class ConfigManager {
  getGitHubToken(): string {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new ConfigError(
        'GitHub token not found.\n\n' +
        'Set the GITHUB_TOKEN environment variable:\n' +
        '  export GITHUB_TOKEN=ghp_...\n\n' +
        'Or add GITHUB_TOKEN=ghp_... to a .env file in your current directory.\n\n' +
        'Create a token at: https://github.com/settings/tokens\n' +
        'Required scopes: repo (for private repos) or public_repo (for public repos)'
      );
    }
    return token;
  }

  getLLMConfig(modelOverride?: string): LLMConfig {
    const rawProvider = process.env.LLM_PROVIDER ?? 'openai';
    const model = modelOverride ?? process.env.AGENTREVIEW_MODEL ?? 'gpt-4o';
    const timeout = parseInt(process.env.AGENTREVIEW_TIMEOUT ?? '60', 10);

    // Only OpenAI is supported in v1.
    if (rawProvider !== 'openai') {
      throw new ConfigError(
        `LLM provider "${rawProvider}" is not supported in v1. ` +
        `Only "openai" is available. Anthropic support is planned for v2.\n` +
        `Set LLM_PROVIDER=openai (or leave unset).`
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ConfigError(
        'OpenAI API key not found.\n\n' +
        'Set the OPENAI_API_KEY environment variable:\n' +
        '  export OPENAI_API_KEY=sk-...\n\n' +
        'Or add OPENAI_API_KEY=sk-... to a .env file in your current directory.'
      );
    }

    return {
      provider: 'openai',
      model,
      apiKey,
      timeout,
      contextTokens: this.getModelContextTokens(model),
    };
  }

  getModelContextTokens(model: string): number {
    return MODEL_CONTEXT_TOKENS[model] ?? DEFAULT_MODEL_CONTEXT;
  }

  hasAcknowledgedDataPolicy(): boolean {
    return process.env.AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY === '1';
  }

  getDefaultLenses(): string {
    return process.env.AGENTREVIEW_LENSES ?? 'all';
  }

  getDefaultFormat(): string {
    return process.env.AGENTREVIEW_FORMAT ?? 'markdown';
  }

  getFailOnSeverity(): FindingSeverity | undefined {
    const val = process.env.AGENTREVIEW_FAIL_ON;
    const valid = new Set<FindingSeverity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
    if (val && valid.has(val as FindingSeverity)) {
      return val as FindingSeverity;
    }
    return undefined;
  }
}
