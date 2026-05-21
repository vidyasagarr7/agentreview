import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseInputs } from './inputs.js';

// Mock @actions/core
vi.mock('@actions/core', () => {
  const inputs: Record<string, string> = {};
  const booleanInputs: Record<string, boolean> = {};
  return {
    getInput: vi.fn((name: string, opts?: { required?: boolean }) => {
      const val = inputs[name] ?? '';
      if (opts?.required && !val) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return val;
    }),
    getBooleanInput: vi.fn((name: string) => {
      return booleanInputs[name] ?? false;
    }),
    __setInputs: (vals: Record<string, string>) => {
      Object.keys(inputs).forEach((k) => delete inputs[k]);
      Object.assign(inputs, vals);
    },
    __setBooleanInputs: (vals: Record<string, boolean>) => {
      Object.keys(booleanInputs).forEach((k) => delete booleanInputs[k]);
      Object.assign(booleanInputs, vals);
    },
  };
});

// Import the mock helpers after vi.mock
import * as core from '@actions/core';
const mockCore = core as unknown as {
  getInput: ReturnType<typeof vi.fn>;
  getBooleanInput: ReturnType<typeof vi.fn>;
  __setInputs: (vals: Record<string, string>) => void;
  __setBooleanInputs: (vals: Record<string, boolean>) => void;
};

function setInputs(
  inputs: Record<string, string>,
  booleans: Record<string, boolean> = {},
) {
  mockCore.__setInputs({
    'github-token': 'ghp_test123',
    ...inputs,
  });
  mockCore.__setBooleanInputs(booleans);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockCore.__setInputs({});
  mockCore.__setBooleanInputs({});
});

describe('parseInputs', () => {
  describe('API key resolution', () => {
    it('uses Anthropic when anthropic-api-key is provided', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.llmConfig.provider).toBe('anthropic');
      expect(result.llmConfig.apiKey).toBe('sk-ant-test');
      expect(result.llmConfig.model).toBe('claude-sonnet-4-20250514');
    });

    it('uses OpenAI when openai-api-key is provided', () => {
      setInputs({ 'openai-api-key': 'sk-openai-test' });
      const result = parseInputs();
      expect(result.llmConfig.provider).toBe('openai');
      expect(result.llmConfig.apiKey).toBe('sk-openai-test');
      expect(result.llmConfig.model).toBe('gpt-4o');
    });

    it('throws when no API key is provided', () => {
      setInputs({});
      expect(() => parseInputs()).toThrow('No API key provided');
    });

    it('Anthropic wins when both keys are provided', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        'openai-api-key': 'sk-openai-test',
      });
      const result = parseInputs();
      expect(result.llmConfig.provider).toBe('anthropic');
      expect(result.llmConfig.apiKey).toBe('sk-ant-test');
    });
  });

  describe('model-provider cross-validation', () => {
    it('throws when gpt model is used with anthropic provider', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        model: 'gpt-4o',
      });
      expect(() => parseInputs()).toThrow('OpenAI model');
    });

    it('throws when o1 model is used with anthropic provider', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        model: 'o1-preview',
      });
      expect(() => parseInputs()).toThrow('OpenAI model');
    });

    it('throws when o3 model is used with anthropic provider', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        model: 'o3-mini',
      });
      expect(() => parseInputs()).toThrow('OpenAI model');
    });

    it('throws when claude model is used with openai provider', () => {
      setInputs({
        'openai-api-key': 'sk-openai-test',
        model: 'claude-sonnet-4-20250514',
      });
      expect(() => parseInputs()).toThrow('Anthropic model');
    });
  });

  describe('context tokens', () => {
    it('sets 200000 for Anthropic provider', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.llmConfig.contextTokens).toBe(200000);
    });

    it('sets 128000 for OpenAI provider', () => {
      setInputs({ 'openai-api-key': 'sk-openai-test' });
      const result = parseInputs();
      expect(result.llmConfig.contextTokens).toBe(128000);
    });
  });

  describe('fail-on validation', () => {
    it('accepts valid severity', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        'fail-on': 'HIGH',
      });
      const result = parseInputs();
      expect(result.failOn).toBe('HIGH');
    });

    it('throws on invalid fail-on value', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        'fail-on': 'EXTREME',
      });
      expect(() => parseInputs()).toThrow('Invalid fail-on severity');
    });

    it('returns undefined when fail-on is not set', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.failOn).toBeUndefined();
    });
  });

  describe('lenses parsing', () => {
    it('returns "all" when lenses is "all"', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test', lenses: 'all' });
      const result = parseInputs();
      expect(result.lenses).toBe('all');
    });

    it('defaults to "all" when not set', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.lenses).toBe('all');
    });

    it('parses comma-separated lenses', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        lenses: 'security, quality, architecture',
      });
      const result = parseInputs();
      expect(result.lenses).toEqual(['security', 'quality', 'architecture']);
    });
  });

  describe('boolean inputs', () => {
    it('parses validate, verbose, and codebase-context', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' }, {
        validate: true,
        verbose: true,
        'codebase-context': true,
      });
      const result = parseInputs();
      expect(result.validate).toBe(true);
      expect(result.verbose).toBe(true);
      expect(result.codebaseContext).toBe(true);
    });

    it('defaults booleans to false', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.validate).toBe(false);
      expect(result.verbose).toBe(false);
      expect(result.codebaseContext).toBe(false);
    });
  });

  describe('pr-number', () => {
    it('parses as integer when provided', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        'pr-number': '42',
      });
      const result = parseInputs();
      expect(result.prNumber).toBe(42);
    });

    it('is undefined when not set', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.prNumber).toBeUndefined();
    });
  });

  describe('comment-mode', () => {
    it('defaults to full', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.commentMode).toBe('full');
    });

    it('accepts summary', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        'comment-mode': 'summary',
      });
      const result = parseInputs();
      expect(result.commentMode).toBe('summary');
    });

    it('accepts collapsed', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        'comment-mode': 'collapsed',
      });
      const result = parseInputs();
      expect(result.commentMode).toBe('collapsed');
    });

    it('throws on invalid comment-mode', () => {
      setInputs({
        'anthropic-api-key': 'sk-ant-test',
        'comment-mode': 'inline',
      });
      expect(() => parseInputs()).toThrow('Invalid comment-mode');
    });
  });

  describe('timeout', () => {
    it('sets timeout to 120 seconds', () => {
      setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      const result = parseInputs();
      expect(result.llmConfig.timeout).toBe(120);
    });
  });

  describe('github-token', () => {
    it('requires github-token', () => {
      mockCore.__setInputs({ 'anthropic-api-key': 'sk-ant-test' });
      mockCore.__setBooleanInputs({});
      expect(() => parseInputs()).toThrow('github-token');
    });
  });
});
