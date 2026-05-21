import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { scanCodebase } from './orchestrator.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../test/fixtures/vulnerable-app');

/**
 * Mock LLM that returns realistic findings based on the domain prompt content.
 * The orchestrator calls buildScanPrompt which embeds domain-specific system prompts,
 * so we pattern-match on those to return appropriate findings.
 */
function createMockLLM() {
  const complete = vi.fn().mockImplementation(async (system: string, _user: string) => {
    // Auth domain — matches A01, auth, login keywords in the system prompt
    if (system.includes('A01') || system.includes('authentication') || system.includes('auth')) {
      return JSON.stringify([
        {
          id: 'auth-001',
          severity: 'CRITICAL',
          category: 'Hardcoded Credentials',
          location: 'src/auth/login.ts:3',
          summary: 'Admin password hardcoded in source',
          detail: 'ADMIN_PASSWORD is set to a string literal.',
          suggestion: 'Use environment variables or a secrets manager.',
        },
      ]);
    }

    // Secrets domain
    if (system.includes('secret') || system.includes('credential') || system.includes('Exposed')) {
      return JSON.stringify([
        {
          id: 'sec-001',
          severity: 'CRITICAL',
          category: 'Exposed Secret',
          location: '.env:1',
          summary: 'AWS access key in .env file',
          detail: 'AWS key found committed to repository.',
          suggestion: 'Remove and rotate the key.',
        },
      ]);
    }

    // Injection domain
    if (system.includes('injection') || system.includes('SQL') || system.includes('A03')) {
      return JSON.stringify([
        {
          id: 'inj-001',
          severity: 'HIGH',
          category: 'SQL Injection',
          location: 'src/routes/users.ts:9',
          summary: 'SQL query built with string concatenation',
          detail: 'User input directly interpolated into SQL query.',
          suggestion: 'Use parameterized queries.',
        },
      ]);
    }

    // Crypto domain
    if (system.includes('crypto') || system.includes('MD5') || system.includes('hash')) {
      return JSON.stringify([
        {
          id: 'cry-001',
          severity: 'HIGH',
          category: 'Weak Hashing',
          location: 'src/crypto/hasher.ts:4',
          summary: 'MD5 used for password hashing',
          detail: 'MD5 is cryptographically broken.',
          suggestion: 'Use bcrypt or argon2.',
        },
      ]);
    }

    // Config domain (Dockerfile, docker-compose, etc.)
    if (system.includes('config') || system.includes('Docker') || system.includes('infrastructure')) {
      return JSON.stringify([
        {
          id: 'cfg-001',
          severity: 'MEDIUM',
          category: 'Container Misconfiguration',
          location: 'Dockerfile:1',
          summary: 'Running as root in container',
          detail: 'No USER directive found; container runs as root by default.',
          suggestion: 'Add a non-root USER directive.',
        },
      ]);
    }

    // Deps domain
    if (system.includes('dep') || system.includes('package') || system.includes('supply chain')) {
      return JSON.stringify([
        {
          id: 'dep-001',
          severity: 'LOW',
          category: 'Outdated Dependency',
          location: 'package.json:1',
          summary: 'No lockfile present',
          detail: 'Without a lockfile, dependency resolution is non-deterministic.',
          suggestion: 'Commit a package-lock.json or yarn.lock.',
        },
      ]);
    }

    // Default — no findings
    return '[]';
  });

  return { complete };
}

describe('scanCodebase integration (vulnerable-app fixture)', () => {
  it('discovers files, dispatches to LLM, and aggregates findings', async () => {
    const mockLLM = createMockLLM();
    const onProgress = vi.fn();

    const result = await scanCodebase(
      FIXTURE_DIR,
      {
        maxConcurrency: 2,
        budgetTokens: 50000,
        timeout: 30,
        validate: false,
        verbose: false,
        redact: false,
        onProgress,
      },
      mockLLM as any,
      {},
    );

    // Basic file discovery
    expect(result.filesDiscovered).toBeGreaterThan(0);
    expect(result.filesScanned).toBeGreaterThan(0);

    // Findings returned from mock LLM
    expect(result.findings.length).toBeGreaterThan(0);

    // Coverage includes at least 2 different domains
    const domainsWithFindings = result.coverage
      .filter((c) => c.findings > 0)
      .map((c) => c.domain);
    expect(domainsWithFindings.length).toBeGreaterThanOrEqual(2);

    // Findings reference correct file paths
    const allLocations = result.findings.map((f) => f.location);
    const knownPatterns = ['login.ts', '.env', 'users.ts', 'hasher.ts', 'Dockerfile', 'package.json', 'database.ts'];
    const matchesKnown = allLocations.some((loc) =>
      knownPatterns.some((pattern) => loc.includes(pattern)),
    );
    expect(matchesKnown).toBe(true);

    // Stats.bySeverity has CRITICAL and/or HIGH entries
    const { bySeverity } = result.stats;
    expect(bySeverity.CRITICAL + bySeverity.HIGH).toBeGreaterThan(0);

    // scannedAt is a valid ISO date string
    expect(new Date(result.scannedAt).toISOString()).toBe(result.scannedAt);

    // Progress callbacks fired
    expect(onProgress).toHaveBeenCalled();
    // Should have both 'started' and 'completed' events
    const startedCalls = onProgress.mock.calls.filter(
      ([, status]: [string, string]) => status === 'started',
    );
    const completedCalls = onProgress.mock.calls.filter(
      ([, status]: [string, string]) => status === 'completed',
    );
    expect(startedCalls.length).toBeGreaterThan(0);
    expect(completedCalls.length).toBeGreaterThan(0);

    // LLM was actually called
    expect(mockLLM.complete).toHaveBeenCalled();
  });

  it('redacts secrets before sending to LLM', async () => {
    const mockLLM = createMockLLM();

    await scanCodebase(
      FIXTURE_DIR,
      {
        maxConcurrency: 2,
        budgetTokens: 50000,
        timeout: 30,
        validate: false,
        verbose: false,
        redact: true,
      },
      mockLLM as any,
      {},
    );

    // Verify the mock LLM was called and check that redactable patterns
    // (AWS access key ID, connection strings) were scrubbed
    expect(mockLLM.complete).toHaveBeenCalled();

    for (const call of mockLLM.complete.mock.calls) {
      const userPrompt: string = call[1];
      // The raw AWS Access Key ID (AKIA...) from the .env fixture should be redacted
      expect(userPrompt).not.toContain('AKIAIOSFODNN7EXAMPLE');
      // Postgres connection string should be redacted
      expect(userPrompt).not.toContain('postgres://admin:secretpass@db.example.com');
      // Redaction placeholders should appear in the secrets chunk
      if (userPrompt.includes('.env')) {
        expect(userPrompt).toContain('[REDACTED_AWS_KEY]');
        expect(userPrompt).toContain('[REDACTED_CONN_STRING]');
      }
    }
  });

  it('respects --focus to scan only auth-domain files', async () => {
    const mockLLM = createMockLLM();

    const result = await scanCodebase(
      FIXTURE_DIR,
      {
        maxConcurrency: 2,
        budgetTokens: 50000,
        timeout: 30,
        validate: false,
        verbose: false,
        redact: false,
        focus: ['auth'],
      },
      mockLLM as any,
      {},
    );

    // Only auth-domain files should be scanned
    // The fixture has src/auth/login.ts → domain 'auth'
    expect(result.filesScanned).toBeGreaterThan(0);

    // All chunks should be in the auth domain
    for (const chunk of result.chunks) {
      expect(chunk.domain).toBe('auth');
    }

    // Coverage should only include auth
    for (const entry of result.coverage) {
      expect(entry.domain).toBe('auth');
    }

    // filesDiscovered may be less than total fixture files since focus filters at discovery
    // The non-auth files (routes, crypto, config, .env, etc.) should be excluded
    expect(result.filesDiscovered).toBeLessThan(7); // 7 total files in fixture
  });
});
