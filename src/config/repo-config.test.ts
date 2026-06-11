import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadRepoConfig } from './repo-config.js';

const TEST_DIR = join(tmpdir(), `agentreview-test-${Date.now()}`);

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('loadRepoConfig', () => {
  it('returns null when file is missing', async () => {
    const result = await loadRepoConfig(TEST_DIR);
    expect(result).toBeNull();
  });

  it('loads a valid .agentreview.yml with all fields', async () => {
    const yaml = `
lenses: [security, quality]
fail-on: HIGH
model: claude-sonnet-4-20250514
validate: true
min-confidence: 50
codebase-context: true
codebase-budget: 12000
ignore:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "migrations/**"
scan:
  focus: [auth, secrets]
  redact: true
  max-files: 100
`;
    await writeFile(join(TEST_DIR, '.agentreview.yml'), yaml);

    const config = await loadRepoConfig(TEST_DIR);
    expect(config).not.toBeNull();
    expect(config!.lenses).toEqual(['security', 'quality']);
    expect(config!.failOn).toBe('HIGH');
    expect(config!.model).toBe('claude-sonnet-4-20250514');
    expect(config!.validate).toBe(true);
    expect(config!.minConfidence).toBe(50);
    expect(config!.codebaseContext).toBe(true);
    expect(config!.codebaseBudget).toBe(12000);
    expect(config!.ignore).toEqual(['**/*.test.ts', '**/*.spec.ts', 'migrations/**']);
    expect(config!.scan).toEqual({ focus: ['auth', 'secrets'], redact: true, maxFiles: 100 });
  });

  it('all fields are optional', async () => {
    await writeFile(join(TEST_DIR, '.agentreview.yml'), '{}');
    const config = await loadRepoConfig(TEST_DIR);
    expect(config).not.toBeNull();
    expect(config).toEqual({});
  });

  it('warns on unknown keys', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(join(TEST_DIR, '.agentreview.yml'), 'unknown-key: true\nlenses: [security]');
    const config = await loadRepoConfig(TEST_DIR);
    expect(config).not.toBeNull();
    expect(config!.lenses).toEqual(['security']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown key "unknown-key"'));
    warnSpy.mockRestore();
  });

  it('warns on unknown scan keys', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(join(TEST_DIR, '.agentreview.yml'), 'scan:\n  focus: [auth]\n  badkey: true');
    const config = await loadRepoConfig(TEST_DIR);
    expect(config!.scan!.focus).toEqual(['auth']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown key "badkey"'));
    warnSpy.mockRestore();
  });

  it('handles ignore patterns as string arrays', async () => {
    await writeFile(join(TEST_DIR, '.agentreview.yml'), 'ignore:\n  - "*.md"\n  - "dist/**"');
    const config = await loadRepoConfig(TEST_DIR);
    expect(config!.ignore).toEqual(['*.md', 'dist/**']);
  });

  it('returns null for non-object YAML', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(join(TEST_DIR, '.agentreview.yml'), '"just a string"');
    const config = await loadRepoConfig(TEST_DIR);
    expect(config).toBeNull();
    warnSpy.mockRestore();
  });

  it('parses scan section correctly with partial fields', async () => {
    await writeFile(join(TEST_DIR, '.agentreview.yml'), 'scan:\n  redact: false');
    const config = await loadRepoConfig(TEST_DIR);
    expect(config!.scan).toEqual({ redact: false });
  });

  describe('hipaa config', () => {
    it('loads a full hipaa section with all fields', async () => {
      const yaml = `
hipaa:
  baa-covered: ["api.openai.com", "*.anthropic.com"]
  no-baa: ["analytics.example.com"]
  phi-sources: ["src/services/patient*", "src/models/record*"]
  phi-fields: ["mrn", "ssn"]
  scanners:
    plaintext-logging: true
    third-party-egress: false
  flow-analysis: true
  flow-max-depth: 8
  flow-max-paths: 30
  flow-max-files: 250
  flow-pr-hop-depth: 3
  flow-safe-patterns:
    - pattern: "redact("
      type: sanitizer
    - pattern: "pick("
      type: projection
`;
      await writeFile(join(TEST_DIR, '.agentreview.yml'), yaml);

      const config = await loadRepoConfig(TEST_DIR);
      expect(config).not.toBeNull();
      expect(config!.hipaa).toEqual({
        baaCovered: ['api.openai.com', '*.anthropic.com'],
        noBaa: ['analytics.example.com'],
        phiSources: ['src/services/patient*', 'src/models/record*'],
        phiFields: ['mrn', 'ssn'],
        scanners: { 'plaintext-logging': true, 'third-party-egress': false },
        flowAnalysis: true,
        flowMaxDepth: 8,
        flowMaxPaths: 30,
        flowMaxFiles: 250,
        flowPrHopDepth: 3,
        flowSafePatterns: [
          { pattern: 'redact(', type: 'sanitizer' },
          { pattern: 'pick(', type: 'projection' },
        ],
      });
    });

    it('warns on unknown hipaa keys', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await writeFile(join(TEST_DIR, '.agentreview.yml'), 'hipaa:\n  baa-covered: ["api.x.com"]\n  bogus-key: true');
      const config = await loadRepoConfig(TEST_DIR);
      expect(config!.hipaa!.baaCovered).toEqual(['api.x.com']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown key "bogus-key"'));
      warnSpy.mockRestore();
    });

    it('ignores hipaa section when it is not an object', async () => {
      await writeFile(join(TEST_DIR, '.agentreview.yml'), 'hipaa: true');
      const config = await loadRepoConfig(TEST_DIR);
      expect(config).not.toBeNull();
      expect(config!.hipaa).toBeUndefined();
    });

    it('handles partial hipaa section (just baa-covered)', async () => {
      await writeFile(join(TEST_DIR, '.agentreview.yml'), 'hipaa:\n  baa-covered: ["api.anthropic.com"]');
      const config = await loadRepoConfig(TEST_DIR);
      expect(config!.hipaa).toEqual({ baaCovered: ['api.anthropic.com'] });
    });

    it('filters invalid flow-safe-patterns entries (missing pattern or type)', async () => {
      const yaml = `
hipaa:
  flow-safe-patterns:
    - pattern: "redact("
      type: sanitizer
    - pattern: "noType("
    - type: projection
    - pattern: 123
      type: sanitizer
    - "not-an-object"
`;
      await writeFile(join(TEST_DIR, '.agentreview.yml'), yaml);
      const config = await loadRepoConfig(TEST_DIR);
      expect(config!.hipaa!.flowSafePatterns).toEqual([
        { pattern: 'redact(', type: 'sanitizer' },
      ]);
    });

    it('keeps only boolean values in scanners with mixed types', async () => {
      const yaml = `
hipaa:
  scanners:
    plaintext-logging: true
    third-party-egress: false
    bad-string: "yes"
    bad-number: 1
`;
      await writeFile(join(TEST_DIR, '.agentreview.yml'), yaml);
      const config = await loadRepoConfig(TEST_DIR);
      expect(config!.hipaa!.scanners).toEqual({
        'plaintext-logging': true,
        'third-party-egress': false,
      });
    });
  });
});
