import { describe, it, expect } from 'vitest';
import {
  buildBaaRegistry,
  classifyEndpoint,
  DEFAULT_BAA_COVERED,
  DEFAULT_NO_BAA,
} from './baa-registry.js';

describe('buildBaaRegistry', () => {
  it('builds registry with defaults only when no config provided', () => {
    const registry = buildBaaRegistry();
    expect(registry.covered.length).toBeGreaterThan(0);
    expect(registry.noBaa.length).toBeGreaterThan(0);
    // All defaults should be present (lowercased)
    for (const d of DEFAULT_BAA_COVERED) {
      expect(registry.covered).toContain(d.toLowerCase());
    }
    for (const d of DEFAULT_NO_BAA) {
      expect(registry.noBaa).toContain(d.toLowerCase());
    }
  });

  it('builds registry with defaults when config is empty', () => {
    const registry = buildBaaRegistry({});
    expect(registry.covered.length).toBe(DEFAULT_BAA_COVERED.length);
    expect(registry.noBaa.length).toBe(DEFAULT_NO_BAA.length);
  });

  it('merges user baaCovered with defaults', () => {
    const registry = buildBaaRegistry({
      baaCovered: ['*.custom-health.com'],
    });
    expect(registry.covered).toContain('*.custom-health.com');
    // Defaults still present
    expect(registry.covered).toContain('*.amazonaws.com');
  });

  it('merges user noBaa with defaults', () => {
    const registry = buildBaaRegistry({
      noBaa: ['*.sketchy-api.com'],
    });
    expect(registry.noBaa).toContain('*.sketchy-api.com');
    // Defaults still present
    expect(registry.noBaa).toContain('api.openai.com');
  });

  it('user override moves domain from noBaa to covered', () => {
    // api.openai.com is in DEFAULT_NO_BAA — move it to covered
    const registry = buildBaaRegistry({
      baaCovered: ['api.openai.com'],
    });
    expect(registry.covered).toContain('api.openai.com');
    expect(registry.noBaa).not.toContain('api.openai.com');
  });

  it('user noBaa override moves domain from covered to noBaa', () => {
    // *.amazonaws.com is in DEFAULT_BAA_COVERED — move it to noBaa
    const registry = buildBaaRegistry({
      noBaa: ['*.amazonaws.com'],
    });
    expect(registry.noBaa).toContain('*.amazonaws.com');
    expect(registry.covered).not.toContain('*.amazonaws.com');
  });
});

describe('classifyEndpoint', () => {
  const registry = buildBaaRegistry();

  it('classifies covered domain as covered', () => {
    expect(classifyEndpoint('s3.amazonaws.com', registry)).toBe('covered');
  });

  it('classifies noBaa domain as no-baa', () => {
    expect(classifyEndpoint('api.openai.com', registry)).toBe('no-baa');
  });

  it('classifies unknown domain as unknown', () => {
    expect(classifyEndpoint('api.totally-random.xyz', registry)).toBe('unknown');
  });

  it('handles full URLs', () => {
    expect(classifyEndpoint('https://s3.amazonaws.com/bucket/key', registry)).toBe('covered');
    expect(classifyEndpoint('https://api.openai.com/v1/chat', registry)).toBe('no-baa');
  });

  it('glob matching works for subdomains', () => {
    expect(classifyEndpoint('us-east-1.amazonaws.com', registry)).toBe('covered');
    expect(classifyEndpoint('console.azure.com', registry)).toBe('covered');
    expect(classifyEndpoint('api.sentry.io', registry)).toBe('no-baa');
    expect(classifyEndpoint('us.sentry.io', registry)).toBe('no-baa');
  });

  it('exact match works for non-wildcard patterns', () => {
    expect(classifyEndpoint('api.openai.com', registry)).toBe('no-baa');
  });

  it('is case-insensitive', () => {
    expect(classifyEndpoint('S3.AMAZONAWS.COM', registry)).toBe('covered');
    expect(classifyEndpoint('API.OPENAI.COM', registry)).toBe('no-baa');
  });
});
