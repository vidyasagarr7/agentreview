import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { LLMConfig } from '../types/index.js';

export class LLMError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LLMError';
  }
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}

interface LLMProvider {
  complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string>;
}

class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  constructor(private config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      timeout: config.timeout * 1000,
    });
  }

  async complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
      },
      { signal }
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new LLMError('LLM returned empty response');
    }
    return content;
  }
}

class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  constructor(private config: LLMConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      timeout: config.timeout * 1000,
    });
  }

  async complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const response = await this.client.messages.create(
      {
        model: this.config.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
      },
      { signal }
    );

    const block = response.content[0];
    if (!block || block.type !== 'text' || !block.text) {
      throw new LLMError('LLM returned empty response');
    }
    return block.text;
  }
}

function createProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    default:
      throw new LLMError(
        `Provider "${config.provider}" is not supported. ` +
        `Use "openai" or "anthropic". Set LLM_PROVIDER=openai or LLM_PROVIDER=anthropic.`
      );
  }
}

export class LLMClient {
  private provider: LLMProvider;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.provider = createProvider(config);
  }

  async complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const maxAttempts = 3;
    const baseDelayMs = 1000;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        throw new LLMError('LLM request was cancelled');
      }

      try {
        return await this.provider.complete(systemPrompt, userPrompt, signal);
      } catch (err: unknown) {
        lastError = err;

        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw new LLMError('LLM request was cancelled');
        }

        const apiError = err as { status?: number; message?: string; headers?: Record<string, string> };

        if (apiError.status && NON_RETRYABLE_STATUS_CODES.has(apiError.status)) {
          if (apiError.status === 401 || apiError.status === 403) {
            throw new LLMError(
              `LLM authentication failed (${apiError.status}). Check your API key.\n` +
              `Provider: ${this.config.provider}`
            );
          }
          if (apiError.status === 404) {
            throw new LLMError(
              `LLM model not found: "${this.config.model}". ` +
              `Check that this model is available in your account.`
            );
          }
          throw new LLMError(`LLM request failed (${apiError.status}): ${apiError.message}`);
        }

        if (apiError.status && !RETRYABLE_STATUS_CODES.has(apiError.status)) {
          throw new LLMError(`LLM request failed (${apiError.status}): ${apiError.message}`);
        }

        let delayMs = jitter(baseDelayMs * Math.pow(2, attempt - 1));
        if (apiError.status === 429 && apiError.headers?.['retry-after']) {
          const retryAfter = parseInt(apiError.headers['retry-after'], 10);
          if (!isNaN(retryAfter)) {
            delayMs = retryAfter * 1000 + jitter(500);
          }
        }

        if (attempt < maxAttempts) {
          await sleep(delayMs, signal);
        }
      }
    }

    const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new LLMError(`LLM request failed after ${maxAttempts} attempts: ${errMsg}`, lastError);
  }
}
