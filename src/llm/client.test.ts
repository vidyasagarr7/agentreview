import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient, LLMError } from './client.js';
import type { LLMConfig } from '../types/index.js';

const testConfig: LLMConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'test-key',
  timeout: 30,
  contextTokens: 128000,
};

// Mock the OpenAI module
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

// Mock the Anthropic module
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

describe('LLMClient', () => {
  it('returns content on success', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockResolvedValueOnce({
      choices: [{ message: { content: '["finding1"]' } }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const client = new LLMClient(testConfig);
    const result = await client.complete('system', 'user');
    expect(result).toBe('["finding1"]');
  });

  it('throws LLMError on 401 without retry', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(LLMError);
    expect(mockCreate).toHaveBeenCalledTimes(1); // No retry
  });

  it('throws LLMError on 404 model not found', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 404, message: 'Model not found' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(/model not found/i);
  });

  it('retries on 429 and throws after max attempts', async () => {
    vi.useFakeTimers();
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 429, message: 'Rate limit' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const client = new LLMClient(testConfig);

    // Start the promise and run timers concurrently
    const promise = client.complete('system', 'user');
    // Attach early handler to prevent PromiseRejectionHandledWarning from fake timer scheduling
    promise.catch(() => undefined);

    // Advance timers multiple times to bypass sleep
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10000);
    }

    await expect(promise).rejects.toThrow(LLMError);
    expect(mockCreate).toHaveBeenCalledTimes(3); // 3 attempts
    vi.useRealTimers();
  });
});
