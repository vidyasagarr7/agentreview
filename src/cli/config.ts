import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import type { LLMConfig, ModelConfig, FindingSeverity } from '../types/index.js';

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
  'claude-sonnet-4-20250514': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
};

const SUPPORTED_PROVIDERS = new Set(['openai', 'anthropic']);

function detectProvider(model: string): 'openai' | 'anthropic' {
  if (model.startsWith('claude')) return 'anthropic';
  return 'openai';
}

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
    const model = modelOverride ?? process.env.AGENTREVIEW_MODEL ?? 'gpt-4o';
    const timeout = parseInt(process.env.AGENTREVIEW_TIMEOUT ?? '60', 10);

    // Auto-detect provider from model name, or use explicit LLM_PROVIDER
    const rawProvider = process.env.LLM_PROVIDER ?? detectProvider(model);

    if (!SUPPORTED_PROVIDERS.has(rawProvider)) {
      throw new ConfigError(
        `LLM provider "${rawProvider}" is not supported. ` +
        `Use "openai" or "anthropic". Set LLM_PROVIDER=openai or LLM_PROVIDER=anthropic.`
      );
    }

    const provider = rawProvider as 'openai' | 'anthropic';

    // Resolve API key based on provider
    const apiKey = provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;

    if (!apiKey) {
      const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      throw new ConfigError(
        `${envVar} not found.\n\n` +
        `Set the ${envVar} environment variable:\n` +
        `  export ${envVar}=...\n\n` +
        `Or add ${envVar}=... to a .env file in your current directory.`
      );
    }

    return {
      provider,
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

  getTimeout(): number {
    const val = process.env.AGENTREVIEW_TIMEOUT;
    return val ? parseInt(val, 10) : 60;
  }

  getDefaultLenses(): string {
    return process.env.AGENTREVIEW_LENSES ?? 'all';
  }

  getDefaultFormat(): string {
    return process.env.AGENTREVIEW_FORMAT ?? 'markdown';
  }

  /**
   * Parse ensemble model specs from a comma-separated string.
   * Format: "claude-sonnet-4-20250514,gpt-4o" or "anthropic:claude-sonnet-4-20250514,openai:gpt-4o"
   * Auto-detects provider from model name if not specified.
   */
  parseEnsembleModels(spec: string): ModelConfig[] {
    return spec.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      let provider: 'openai' | 'anthropic';
      let model: string;

      if (entry.includes(':')) {
        const [p, m] = entry.split(':', 2);
        provider = p as 'openai' | 'anthropic';
        model = m;
      } else {
        model = entry;
        provider = detectProvider(model);
      }

      const apiKey = provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.OPENAI_API_KEY;

      if (!apiKey) {
        const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
        throw new ConfigError(`${envVar} required for ensemble model "${model}"`);
      }

      return { provider, model, apiKey, label: model };
    });
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
