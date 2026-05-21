import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient, LLMError, type LLMCompleteOptions } from './client.js';
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

// Mock the Google GenAI module
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: vi.fn(),
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

  it('passes maxTokens to OpenAI provider when specified', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockResolvedValueOnce({
      choices: [{ message: { content: 'result' } }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const client = new LLMClient(testConfig);
    const result = await client.complete('system', 'user', undefined, { maxTokens: 8192 });
    expect(result).toBe('result');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(8192);
  });

  it('does not include max_tokens for OpenAI when no options provided', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockResolvedValueOnce({
      choices: [{ message: { content: 'result' } }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const client = new LLMClient(testConfig);
    await client.complete('system', 'user');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBeUndefined();
  });

  it('passes maxTokens to Anthropic provider when specified', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const mockCreate = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text', text: 'result' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: mockCreate },
    }));

    const anthropicConfig: LLMConfig = { ...testConfig, provider: 'anthropic' };
    const client = new LLMClient(anthropicConfig);
    const result = await client.complete('system', 'user', undefined, { maxTokens: 8192 });
    expect(result).toBe('result');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(8192);
  });

  it('defaults Anthropic max_tokens to 4096 when no options provided', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const mockCreate = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text', text: 'result' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: mockCreate },
    }));

    const anthropicConfig: LLMConfig = { ...testConfig, provider: 'anthropic' };
    const client = new LLMClient(anthropicConfig);
    await client.complete('system', 'user');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(4096);
  });

  it('Gemini provider creates client and calls generateContent', async () => {
    const { GoogleGenAI } = await import('@google/genai');
    const mockGenerateContent = vi.fn().mockResolvedValueOnce({
      text: 'gemini result',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GoogleGenAI as any).mockImplementation(() => ({
      models: { generateContent: mockGenerateContent },
    }));

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    const result = await client.complete('system', 'user');
    expect(result).toBe('gemini result');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.model).toBe('gemini-2.5-flash');
    expect(callArgs.config.systemInstruction).toBe('system');
    expect(callArgs.contents).toBe('user');
  });

  it('defaults Gemini maxOutputTokens to 4096 when no options provided', async () => {
    const { GoogleGenAI } = await import('@google/genai');
    const mockGenerateContent = vi.fn().mockResolvedValueOnce({
      text: 'result',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GoogleGenAI as any).mockImplementation(() => ({
      models: { generateContent: mockGenerateContent },
    }));

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    await client.complete('system', 'user');
    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.config.maxOutputTokens).toBe(4096);
  });

  it('passes custom maxTokens to Gemini provider', async () => {
    const { GoogleGenAI } = await import('@google/genai');
    const mockGenerateContent = vi.fn().mockResolvedValueOnce({
      text: 'result',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GoogleGenAI as any).mockImplementation(() => ({
      models: { generateContent: mockGenerateContent },
    }));

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    const result = await client.complete('system', 'user', undefined, { maxTokens: 8192 });
    expect(result).toBe('result');
    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.config.maxOutputTokens).toBe(8192);
  });

  it('throws LLMError on empty Gemini response', async () => {
    const { GoogleGenAI } = await import('@google/genai');
    const mockGenerateContent = vi.fn().mockResolvedValueOnce({
      text: '',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GoogleGenAI as any).mockImplementation(() => ({
      models: { generateContent: mockGenerateContent },
    }));

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(LLMError);
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
