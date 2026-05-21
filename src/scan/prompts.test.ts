import { describe, it, expect } from 'vitest';
import { buildScanPrompt, domainPrompts } from './prompts.js';
import { parseFindings } from '../llm/parse-findings.js';
import type { ScanChunk, SecurityDomain } from './types.js';

const ALL_DOMAINS: SecurityDomain[] = [
  'auth',
  'secrets',
  'injection',
  'config',
  'deps',
  'crypto',
  'data-flow',
  'general',
];

function makeChunk(domain: SecurityDomain, files?: ScanChunk['files']): ScanChunk {
  return {
    id: `test-${domain}-001`,
    domain,
    files: files ?? [
      {
        path: 'src/example.ts',
        content: 'const x = 1;\nconst y = 2;\nexport { x, y };',
        priority: 1,
        estimatedTokens: 20,
      },
    ],
    estimatedTokens: 20,
    focusPrompt: `Analyze for ${domain} issues`,
  };
}

describe('domainPrompts', () => {
  it.each(ALL_DOMAINS)('domain "%s" has a non-empty prompt', (domain) => {
    expect(domainPrompts[domain]).toBeDefined();
    expect(domainPrompts[domain].length).toBeGreaterThan(100);
  });

  it('auth prompt contains OWASP A01 and A07 references', () => {
    expect(domainPrompts.auth).toContain('A01');
    expect(domainPrompts.auth).toContain('A07');
  });

  it('secrets prompt mentions AWS key prefix AKIA and GitHub token prefix ghp_', () => {
    expect(domainPrompts.secrets).toContain('AKIA');
    expect(domainPrompts.secrets).toContain('ghp_');
  });

  it('injection prompt covers SQL, command, and XSS injection types', () => {
    expect(domainPrompts.injection).toContain('SQL');
    expect(domainPrompts.injection).toContain('Command Injection');
    expect(domainPrompts.injection).toContain('XSS');
  });

  it('crypto prompt covers MD5, SHA1, DES, and RC4', () => {
    expect(domainPrompts.crypto).toContain('MD5');
    expect(domainPrompts.crypto).toContain('SHA1');
    expect(domainPrompts.crypto).toContain('DES');
    expect(domainPrompts.crypto).toContain('RC4');
  });

  it('config prompt covers Docker and Terraform', () => {
    expect(domainPrompts.config).toContain('Docker');
    expect(domainPrompts.config).toContain('Terraform');
  });

  it('every domain prompt instructs to return [] if no issues', () => {
    for (const domain of ALL_DOMAINS) {
      expect(domainPrompts[domain]).toContain('Return [] if no issues found');
    }
  });

  it('every domain prompt instructs to return ONLY a JSON array', () => {
    for (const domain of ALL_DOMAINS) {
      expect(domainPrompts[domain]).toContain('Return ONLY a JSON array');
    }
  });
});

describe('buildScanPrompt', () => {
  it('returns { system, user } with file contents embedded', () => {
    const chunk = makeChunk('auth', [
      {
        path: 'src/auth/login.ts',
        content: 'function login(user: string, pass: string) {\n  return db.query(user);\n}',
        priority: 1,
        estimatedTokens: 30,
      },
    ]);
    const meta = { target: 'myorg/myrepo', branch: 'main' };
    const result = buildScanPrompt(chunk, meta);

    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('user');
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');

    // system prompt should be the auth domain prompt
    expect(result.system).toBe(domainPrompts.auth);

    // user prompt should contain file contents with line numbers
    expect(result.user).toContain('src/auth/login.ts');
    expect(result.user).toContain('1 | function login');
    expect(result.user).toContain('2 |   return db.query');

    // user prompt should contain metadata
    expect(result.user).toContain('myorg/myrepo');
    expect(result.user).toContain('main');
    expect(result.user).toContain('auth');
  });

  it('embeds multiple files in the user prompt', () => {
    const chunk = makeChunk('secrets', [
      { path: 'config.ts', content: 'export const KEY = "test";', priority: 1, estimatedTokens: 10 },
      { path: '.env', content: 'DB_PASS=hunter2', priority: 2, estimatedTokens: 5 },
    ]);
    const result = buildScanPrompt(chunk, { target: 'org/repo', branch: 'dev' });

    expect(result.user).toContain('config.ts');
    expect(result.user).toContain('.env');
    expect(result.user).toContain('DB_PASS=hunter2');
    expect(result.user).toContain('Files to Analyze (2)');
  });

  it('uses the correct domain prompt for each domain', () => {
    for (const domain of ALL_DOMAINS) {
      const chunk = makeChunk(domain);
      const result = buildScanPrompt(chunk, { target: 'test', branch: 'main' });
      expect(result.system).toBe(domainPrompts[domain]);
    }
  });
});

describe('parseFindings compatibility', () => {
  it('mock LLM response matching prompt output format parses successfully', () => {
    const mockLlmResponse = JSON.stringify([
      {
        id: 'sec-001',
        severity: 'CRITICAL',
        category: 'Hardcoded Secret',
        location: 'src/config.ts:42',
        summary: 'AWS access key hardcoded in source',
        detail:
          'Line 42 contains a hardcoded AWS access key (AKIA...). This credential is committed to version history and trivially extractable.',
        suggestion:
          'Remove the key, rotate it immediately, and use environment variables or AWS Secrets Manager.',
      },
      {
        id: 'sec-002',
        severity: 'HIGH',
        category: 'SQL Injection',
        location: 'src/db/query.ts:15',
        summary: 'User input concatenated into SQL query',
        detail:
          'The function builds a SQL query using string concatenation with user-supplied input, allowing SQL injection.',
        suggestion: 'Use parameterized queries or prepared statements instead of string concatenation.',
      },
      {
        id: 'sec-003',
        severity: 'MEDIUM',
        category: 'Missing Rate Limiting',
        location: 'src/api/login.ts:8',
        summary: 'Login endpoint has no rate limiting',
        detail: 'The login endpoint accepts unlimited authentication attempts, enabling brute-force attacks.',
        suggestion: 'Implement rate limiting (e.g., express-rate-limit) with exponential backoff after failed attempts.',
      },
      {
        id: 'sec-004',
        severity: 'LOW',
        category: 'Verbose Error',
        location: 'src/middleware/error.ts:22',
        summary: 'Stack trace exposed in production error response',
        detail: 'Error handler returns full stack traces to the client in all environments.',
        suggestion: 'Only include stack traces in development mode; return generic error messages in production.',
      },
      {
        id: 'sec-005',
        severity: 'INFO',
        category: 'Security Header',
        location: 'src/server.ts:1',
        summary: 'Missing X-Content-Type-Options header',
        detail: 'The application does not set the X-Content-Type-Options: nosniff header.',
        suggestion: 'Add helmet middleware or manually set X-Content-Type-Options: nosniff.',
      },
    ]);

    const result = parseFindings(mockLlmResponse, 'security-scan');

    // Should NOT be a ParseError
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;

    expect(result).toHaveLength(5);
    expect(result[0].id).toBe('sec-001');
    expect(result[0].severity).toBe('CRITICAL');
    expect(result[0].category).toBe('Hardcoded Secret');
    expect(result[1].severity).toBe('HIGH');
    expect(result[2].severity).toBe('MEDIUM');
    expect(result[3].severity).toBe('LOW');
    expect(result[4].severity).toBe('INFO');
  });

  it('empty array response parses to empty findings', () => {
    const result = parseFindings('[]', 'security-scan');
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(0);
    }
  });

  it('JSON in code fence parses correctly', () => {
    const fencedResponse = '```json\n[{"id":"sec-001","severity":"HIGH","category":"Auth Bypass","location":"auth.ts:10","summary":"No auth check","detail":"Missing authentication","suggestion":"Add auth middleware"}]\n```';
    const result = parseFindings(fencedResponse, 'security-scan');
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
      expect(result[0].severity).toBe('HIGH');
    }
  });
});
