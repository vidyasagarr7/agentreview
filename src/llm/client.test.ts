import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient, LLMError, sleep, type LLMCompleteOptions } from './client.js';
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
    default: vi.fn().mockImplementation(function () {
      return {
        chat: {
          completions: {
            create: vi.fn(),
          },
        },
      };
    }),
  };
});

// Mock the Anthropic module
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        messages: {
          create: vi.fn(),
        },
      };
    }),
  };
});

// Mock the Google GenAI module
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(function () {
      return {
        models: {
          generateContent: vi.fn(),
        },
      };
    }),
  };
});

describe('LLMClient', () => {
  it('returns content on success', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockResolvedValueOnce({
      choices: [{ message: { content: '["finding1"]' } }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    const result = await client.complete('system', 'user');
    expect(result).toBe('["finding1"]');
  });

  it('throws LLMError on 401 without retry', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(LLMError);
    expect(mockCreate).toHaveBeenCalledTimes(1); // No retry
  });

  it('throws LLMError on 404 model not found', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 404, message: 'Model not found' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(/model not found/i);
  });

  it('passes maxTokens to OpenAI provider when specified', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockResolvedValueOnce({
      choices: [{ message: { content: 'result' } }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

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
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

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
    (Anthropic as any).mockImplementation(function () {
      return { messages: { create: mockCreate } };
    });

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
    (Anthropic as any).mockImplementation(function () {
      return { messages: { create: mockCreate } };
    });

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
    (GoogleGenAI as any).mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    });

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
    (GoogleGenAI as any).mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    });

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
    (GoogleGenAI as any).mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    });

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
    (GoogleGenAI as any).mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    });

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(LLMError);
  });

  it('retries on 429 and throws after max attempts', async () => {
    vi.useFakeTimers();
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 429, message: 'Rate limit' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

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

  it('retries on 503 then succeeds on second attempt', async () => {
    vi.useFakeTimers();
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn()
      .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'recovered' } }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    const promise = client.complete('system', 'user');
    promise.catch(() => undefined);

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10000);
    }

    const result = await promise;
    expect(result).toBe('recovered');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws LLMError on 403 auth failure without retry', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 403, message: 'Forbidden' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(/authentication failed.*403/i);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws LLMError on 400 non-retryable without retry', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 400, message: 'Bad Request' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(/400.*Bad Request/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws on unknown non-retryable status code without retry', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockRejectedValue({ status: 422, message: 'Unprocessable' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(/422.*Unprocessable/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws immediately when signal is already aborted before call', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const controller = new AbortController();
    controller.abort();

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user', controller.signal)).rejects.toThrow(/cancelled/);
    expect(mockCreate).toHaveBeenCalledTimes(0);
  });

  it('throws when abort signal fires during provider call', async () => {
    const OpenAI = (await import('openai')).default;
    const controller = new AbortController();
    const mockCreate = vi.fn().mockImplementation(() => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      controller.abort();
      return Promise.reject(err);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user', controller.signal)).rejects.toThrow(/cancelled/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('respects retry-after header on 429 responses', async () => {
    vi.useFakeTimers();
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn()
      .mockRejectedValueOnce({ status: 429, message: 'Rate limit', headers: { 'retry-after': '5' } })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    const promise = client.complete('system', 'user');
    promise.catch(() => undefined);

    // The retry-after header says 5 seconds = 5000ms + jitter(500)
    // Advance enough to cover that
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10000);
    }

    const result = await promise;
    expect(result).toBe('ok');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws on unsupported provider in createProvider', () => {
    const badConfig: LLMConfig = { ...testConfig, provider: 'unsupported' as any };
    expect(() => new LLMClient(badConfig)).toThrow(/not supported/);
  });

  it('throws LLMError on empty OpenAI response', async () => {
    const OpenAI = (await import('openai')).default;
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '' } }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OpenAI as any).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = new LLMClient(testConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(/empty response/);
  });

  it('throws LLMError on empty Anthropic response', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'image', text: '' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Anthropic as any).mockImplementation(function () {
      return { messages: { create: mockCreate } };
    });

    const anthropicConfig: LLMConfig = { ...testConfig, provider: 'anthropic' };
    const client = new LLMClient(anthropicConfig);
    await expect(client.complete('system', 'user')).rejects.toThrow(/empty response/);
  });

  it('Gemini provider cancels on abort signal', async () => {
    const { GoogleGenAI } = await import('@google/genai');
    const controller = new AbortController();
    controller.abort();
    const mockGenerateContent = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GoogleGenAI as any).mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    });

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    await expect(client.complete('system', 'user', controller.signal)).rejects.toThrow(/cancelled/);
  });

  it('Gemini provider succeeds with non-aborted signal (if signal branch)', async () => {
    const { GoogleGenAI } = await import('@google/genai');
    const mockGenerateContent = vi.fn().mockResolvedValueOnce({
      text: 'gemini with signal',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GoogleGenAI as any).mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    });

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    const controller = new AbortController();
    const result = await client.complete('system', 'user', controller.signal);
    expect(result).toBe('gemini with signal');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('Gemini provider rejects when signal aborts during pending request', async () => {
    const { GoogleGenAI } = await import('@google/genai');
    const controller = new AbortController();
    const mockGenerateContent = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GoogleGenAI as any).mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent } };
    });

    const geminiConfig: LLMConfig = { ...testConfig, provider: 'google', model: 'gemini-2.5-flash' };
    const client = new LLMClient(geminiConfig);
    const promise = client.complete('system', 'user', controller.signal);
    // Abort after the call has started — hits the abort listener in the Promise.race
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);
  });
});

describe('sleep', () => {
  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(10000, controller.signal)).rejects.toThrow('Aborted');
  });

  it('rejects when signal aborts during sleep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleep(10000, controller.signal);
    promise.catch(() => undefined);
    controller.abort();
    await expect(promise).rejects.toThrow('Aborted');
    vi.useRealTimers();
  });

  it('resolves after delay with no signal', async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
