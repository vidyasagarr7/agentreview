import OpenAI from 'openai';
import type { LLMConfig } from '../types/index.js';

export class LLMError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LLMError';
  }
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  // Add ±25% random jitter
  return ms * (0.75 + Math.random() * 0.5);
}

export class LLMClient {
  private client: OpenAI;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      timeout: config.timeout * 1000,
    });
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const maxAttempts = 3;
    const baseDelayMs = 1000;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1, // Low temperature for consistent structured output
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new LLMError('LLM returned empty response');
        }

        return content;
      } catch (err: unknown) {
        lastError = err;

        // Check if it's an OpenAI API error with a status code
        const apiError = err as { status?: number; message?: string; headers?: Record<string, string> };

        if (apiError.status && NON_RETRYABLE_STATUS_CODES.has(apiError.status)) {
          // Don't retry auth/bad request errors
          if (apiError.status === 401 || apiError.status === 403) {
            throw new LLMError(
              `LLM authentication failed (${apiError.status}). Check your API key.\n` +
              `Set OPENAI_API_KEY environment variable.`
            );
          }
          if (apiError.status === 404) {
            throw new LLMError(
              `LLM model not found: "${this.config.model}". ` +
              `Check that this model is available in your account. ` +
              `Try --model gpt-4-turbo or --model gpt-4o.`
            );
          }
          throw new LLMError(`LLM request failed (${apiError.status}): ${apiError.message}`);
        }

        if (apiError.status && !RETRYABLE_STATUS_CODES.has(apiError.status)) {
          // Non-retryable unknown status
          throw new LLMError(`LLM request failed (${apiError.status}): ${apiError.message}`);
        }

        // Check for Retry-After header on 429
        let delayMs = jitter(baseDelayMs * Math.pow(2, attempt - 1));
        if (apiError.status === 429 && apiError.headers?.['retry-after']) {
          const retryAfter = parseInt(apiError.headers['retry-after'], 10);
          if (!isNaN(retryAfter)) {
            delayMs = retryAfter * 1000 + jitter(500);
          }
        }

        if (attempt < maxAttempts) {
          await sleep(delayMs);
        }
      }
    }

    const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new LLMError(`LLM request failed after ${maxAttempts} attempts: ${errMsg}`, lastError);
  }
}
