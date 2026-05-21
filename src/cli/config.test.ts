import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigManager, ConfigError } from './config.js';

describe('ConfigManager', () => {
  let config: ConfigManager;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    config = new ConfigManager();
    // Clear relevant env vars
    delete process.env.GITHUB_TOKEN;
    delete process.env.AGENTREVIEW_MODEL;
    delete process.env.AGENTREVIEW_TIMEOUT;
    delete process.env.AGENTREVIEW_FORMAT;
    delete process.env.AGENTREVIEW_LENSES;
    delete process.env.AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY;
    delete process.env.AGENTREVIEW_FAIL_ON;
    delete process.env.LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getGitHubToken', () => {
    it('returns token from GITHUB_TOKEN env', () => {
      process.env.GITHUB_TOKEN = 'ghp_test123';
      expect(config.getGitHubToken()).toBe('ghp_test123');
    });

    it('throws ConfigError if GITHUB_TOKEN is missing', () => {
      expect(() => config.getGitHubToken()).toThrow(ConfigError);
      expect(() => config.getGitHubToken()).toThrow('GitHub token not found');
    });
  });

  describe('getLLMConfig', () => {
    it('builds correct LLMConfig with defaults (openai/gpt-4o)', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const llm = config.getLLMConfig();
      expect(llm).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
        timeout: 60,
        contextTokens: 128000,
      });
    });

    it('uses model override parameter', () => {
      process.env.ANTHROPIC_API_KEY = 'ant-key';
      const llm = config.getLLMConfig('claude-sonnet-4-20250514');
      expect(llm.provider).toBe('anthropic');
      expect(llm.model).toBe('claude-sonnet-4-20250514');
      expect(llm.apiKey).toBe('ant-key');
    });

    it('uses AGENTREVIEW_MODEL env var', () => {
      process.env.AGENTREVIEW_MODEL = 'gpt-4';
      process.env.OPENAI_API_KEY = 'sk-test';
      const llm = config.getLLMConfig();
      expect(llm.model).toBe('gpt-4');
      expect(llm.contextTokens).toBe(8192);
    });

    it('uses AGENTREVIEW_TIMEOUT env var', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.AGENTREVIEW_TIMEOUT = '120';
      const llm = config.getLLMConfig();
      expect(llm.timeout).toBe(120);
    });

    it('throws if API key is missing for detected provider', () => {
      expect(() => config.getLLMConfig('gpt-4o')).toThrow(ConfigError);
      expect(() => config.getLLMConfig('gpt-4o')).toThrow('OPENAI_API_KEY');
    });

    it('throws if API key is missing for anthropic provider', () => {
      expect(() => config.getLLMConfig('claude-sonnet-4-20250514')).toThrow('ANTHROPIC_API_KEY');
    });

    it('respects explicit LLM_PROVIDER env var', () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.ANTHROPIC_API_KEY = 'ant-key';
      const llm = config.getLLMConfig('some-custom-model');
      expect(llm.provider).toBe('anthropic');
    });

    it('throws for unsupported provider', () => {
      process.env.LLM_PROVIDER = 'cohere';
      expect(() => config.getLLMConfig()).toThrow('not supported');
    });

    it('returns default context tokens for unknown model', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const llm = config.getLLMConfig('some-unknown-model');
      expect(llm.contextTokens).toBe(128000); // DEFAULT_MODEL_CONTEXT
    });
  });

  describe('getDefaultFormat', () => {
    it('defaults to markdown', () => {
      expect(config.getDefaultFormat()).toBe('markdown');
    });

    it('reads from AGENTREVIEW_FORMAT', () => {
      process.env.AGENTREVIEW_FORMAT = 'json';
      expect(config.getDefaultFormat()).toBe('json');
    });
  });

  describe('getDefaultLenses', () => {
    it('defaults to all', () => {
      expect(config.getDefaultLenses()).toBe('all');
    });

    it('reads from AGENTREVIEW_LENSES', () => {
      process.env.AGENTREVIEW_LENSES = 'security,quality';
      expect(config.getDefaultLenses()).toBe('security,quality');
    });
  });

  describe('getTimeout', () => {
    it('defaults to 60', () => {
      expect(config.getTimeout()).toBe(60);
    });

    it('reads from AGENTREVIEW_TIMEOUT', () => {
      process.env.AGENTREVIEW_TIMEOUT = '90';
      expect(config.getTimeout()).toBe(90);
    });
  });

  describe('hasAcknowledgedDataPolicy', () => {
    it('returns false when not set', () => {
      expect(config.hasAcknowledgedDataPolicy()).toBe(false);
    });

    it('returns true when set to 1', () => {
      process.env.AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY = '1';
      expect(config.hasAcknowledgedDataPolicy()).toBe(true);
    });

    it('returns false for other values', () => {
      process.env.AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY = 'true';
      expect(config.hasAcknowledgedDataPolicy()).toBe(false);
    });
  });

  describe('getFailOnSeverity', () => {
    it('returns undefined when not set', () => {
      expect(config.getFailOnSeverity()).toBeUndefined();
    });

    it('returns valid severity', () => {
      process.env.AGENTREVIEW_FAIL_ON = 'HIGH';
      expect(config.getFailOnSeverity()).toBe('HIGH');
    });

    it('returns undefined for invalid severity', () => {
      process.env.AGENTREVIEW_FAIL_ON = 'EXTREME';
      expect(config.getFailOnSeverity()).toBeUndefined();
    });
  });

  describe('parseEnsembleModels', () => {
    it('parses comma-separated models with auto-detected providers', () => {
      process.env.ANTHROPIC_API_KEY = 'ant-key';
      process.env.OPENAI_API_KEY = 'oai-key';
      const models = config.parseEnsembleModels('claude-sonnet-4-20250514,gpt-4o');
      expect(models).toEqual([
        { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'ant-key', label: 'claude-sonnet-4-20250514' },
        { provider: 'openai', model: 'gpt-4o', apiKey: 'oai-key', label: 'gpt-4o' },
      ]);
    });

    it('parses explicit provider:model format', () => {
      process.env.ANTHROPIC_API_KEY = 'ant-key';
      const models = config.parseEnsembleModels('anthropic:claude-sonnet-4-20250514');
      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe('anthropic');
      expect(models[0].model).toBe('claude-sonnet-4-20250514');
    });

    it('throws if API key missing for ensemble model', () => {
      expect(() => config.parseEnsembleModels('claude-sonnet-4-20250514')).toThrow('ANTHROPIC_API_KEY');
    });
  });
});
