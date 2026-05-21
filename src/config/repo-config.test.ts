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
});
