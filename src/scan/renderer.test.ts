import { describe, it, expect } from 'vitest';
import { renderScanReport } from './renderer.js';
import type { ScanResult } from './types.js';
import type { AgentFinding, FindingSeverity } from '../types/index.js';
import { SEVERITY_ORDER } from '../types/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<AgentFinding> & { id: string; severity: FindingSeverity }): AgentFinding {
  return {
    category: 'test-category',
    location: 'src/example.ts',
    summary: 'Test finding summary',
    detail: 'Test finding detail',
    suggestion: 'Test suggestion',
    lenses: ['security'],
    ...overrides,
  };
}

function makeResult(overrides?: Partial<ScanResult>): ScanResult {
  const findings: AgentFinding[] = overrides?.findings ?? [
    makeFinding({ id: 'sec-001', severity: 'CRITICAL', location: 'src/auth/middleware.ts', summary: 'Hardcoded JWT secret' }),
    makeFinding({ id: 'sec-002', severity: 'HIGH', location: 'src/auth/middleware.ts', summary: 'Missing rate limit' }),
    makeFinding({ id: 'sec-003', severity: 'HIGH', location: 'src/auth/middleware.ts', summary: 'No CSRF protection' }),
    makeFinding({ id: 'sec-004', severity: 'MEDIUM', location: 'src/db/query.ts', summary: 'SQL concatenation' }),
    makeFinding({ id: 'sec-005', severity: 'LOW', location: 'src/utils/log.ts', summary: 'Verbose error logging' }),
    makeFinding({ id: 'sec-006', severity: 'INFO', location: 'src/config.ts', summary: 'Unused env variable' }),
  ];

  return {
    target: 'my-app',
    branch: 'main',
    scannedAt: '2026-05-21T07:00:00Z',
    filesDiscovered: 120,
    filesScanned: 95,
    filesSkipped: 25,
    chunks: [],
    findings,
    stats: overrides?.stats ?? {
      total: findings.length,
      bySeverity: {
        CRITICAL: findings.filter((f) => f.severity === 'CRITICAL').length,
        HIGH: findings.filter((f) => f.severity === 'HIGH').length,
        MEDIUM: findings.filter((f) => f.severity === 'MEDIUM').length,
        LOW: findings.filter((f) => f.severity === 'LOW').length,
        INFO: findings.filter((f) => f.severity === 'INFO').length,
      },
      byDomain: { auth: 3, injection: 1, general: 2 },
      cleanDomains: ['crypto', 'deps'],
      erroredChunks: [],
    },
    coverage: overrides?.coverage ?? [
      { domain: 'auth', filesScanned: 12, findings: 3 },
      { domain: 'injection', filesScanned: 8, findings: 1 },
      { domain: 'config', filesScanned: 5, findings: 1 },
      { domain: 'general', filesScanned: 70, findings: 1 },
    ],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('renderScanReport', () => {
  describe('markdown format', () => {
    it('includes risk posture table with correct counts', () => {
      const result = makeResult();
      const md = renderScanReport(result, 'markdown');

      expect(md).toContain('## Risk Posture');
      expect(md).toContain('| CRITICAL | 1 |');
      expect(md).toContain('| HIGH | 2 |');
      expect(md).toContain('| MEDIUM | 1 |');
      expect(md).toContain('| LOW | 1 |');
      expect(md).toContain('| INFO | 1 |');
    });

    it('includes coverage table', () => {
      const result = makeResult();
      const md = renderScanReport(result, 'markdown');

      expect(md).toContain('## Coverage');
      expect(md).toContain('| auth | 12 | 3 |');
      expect(md).toContain('| injection | 8 | 1 |');
      expect(md).toContain('| config | 5 | 1 |');
      expect(md).toContain('| general | 70 | 1 |');
    });

    it('includes hotspots sorted by score', () => {
      const result = makeResult();
      const md = renderScanReport(result, 'markdown');

      expect(md).toContain('## Hotspots');
      // auth/middleware.ts has 1 CRITICAL (5) + 2 HIGH (6) = 11 points → first
      expect(md).toMatch(/1\.\s+`src\/auth\/middleware\.ts`/);
      // db/query.ts has 1 MEDIUM (2) → second
      expect(md).toMatch(/2\.\s+`src\/db\/query\.ts`/);
    });

    it('groups findings by severity in correct order', () => {
      const result = makeResult();
      const md = renderScanReport(result, 'markdown');

      const critIdx = md.indexOf('### CRITICAL');
      const highIdx = md.indexOf('### HIGH');
      const medIdx = md.indexOf('### MEDIUM');
      const lowIdx = md.indexOf('### LOW');
      const infoIdx = md.indexOf('### INFO');

      expect(critIdx).toBeGreaterThan(-1);
      expect(highIdx).toBeGreaterThan(critIdx);
      expect(medIdx).toBeGreaterThan(highIdx);
      expect(lowIdx).toBeGreaterThan(medIdx);
      expect(infoIdx).toBeGreaterThan(lowIdx);
    });

    it('includes header with target, branch, and file counts', () => {
      const result = makeResult();
      const md = renderScanReport(result, 'markdown');

      expect(md).toContain('# 🔒 Security Scan: my-app');
      expect(md).toContain('**Branch:** main');
      expect(md).toContain('**Files:** 95/120');
    });

    it('includes finding details', () => {
      const result = makeResult();
      const md = renderScanReport(result, 'markdown');

      expect(md).toContain('[sec-001] Hardcoded JWT secret');
      expect(md).toContain('**Suggestion:** Test suggestion');
    });
  });

  describe('json format', () => {
    it('produces valid JSON containing all ScanResult fields', () => {
      const result = makeResult();
      const json = renderScanReport(result, 'json');

      const parsed = JSON.parse(json);
      expect(parsed.target).toBe('my-app');
      expect(parsed.branch).toBe('main');
      expect(parsed.filesDiscovered).toBe(120);
      expect(parsed.filesScanned).toBe(95);
      expect(parsed.filesSkipped).toBe(25);
      expect(parsed.findings).toHaveLength(6);
      expect(parsed.stats.bySeverity.CRITICAL).toBe(1);
      expect(parsed.coverage).toHaveLength(4);
      expect(parsed.scannedAt).toBe('2026-05-21T07:00:00Z');
      expect(parsed.chunks).toBeDefined();
    });
  });

  describe('empty findings', () => {
    it('shows clean message with file and domain counts', () => {
      const result = makeResult({
        findings: [],
        stats: {
          total: 0,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
          byDomain: {},
          cleanDomains: ['auth', 'injection'],
          erroredChunks: [],
        },
        coverage: [
          { domain: 'auth', filesScanned: 12, findings: 0 },
          { domain: 'injection', filesScanned: 8, findings: 0 },
          { domain: 'config', filesScanned: 5, findings: 0 },
        ],
      });
      const md = renderScanReport(result, 'markdown');

      expect(md).toContain('✅ No security issues found');
      expect(md).toContain('scanned 95 files across 3 domains');
      expect(md).not.toContain('## Risk Posture');
      expect(md).not.toContain('## Findings');
    });
  });

  describe('hotspots sorting', () => {
    it('sorts hotspots by score descending then by count', () => {
      const findings: AgentFinding[] = [
        // File A: 2 HIGH = 6 points
        makeFinding({ id: 'a1', severity: 'HIGH', location: 'src/a.ts' }),
        makeFinding({ id: 'a2', severity: 'HIGH', location: 'src/a.ts' }),
        // File B: 1 CRITICAL = 5 points
        makeFinding({ id: 'b1', severity: 'CRITICAL', location: 'src/b.ts' }),
        // File C: 3 MEDIUM = 6 points, 3 findings (more than A's 2)
        makeFinding({ id: 'c1', severity: 'MEDIUM', location: 'src/c.ts' }),
        makeFinding({ id: 'c2', severity: 'MEDIUM', location: 'src/c.ts' }),
        makeFinding({ id: 'c3', severity: 'MEDIUM', location: 'src/c.ts' }),
      ];

      const result = makeResult({
        findings,
        stats: {
          total: 6,
          bySeverity: { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 0, INFO: 0 },
          byDomain: { general: 6 },
          cleanDomains: [],
          erroredChunks: [],
        },
      });

      const md = renderScanReport(result, 'markdown');

      // A and C both have 6 points, but C has 3 findings vs A's 2 → C first
      const posC = md.indexOf('`src/c.ts`');
      const posA = md.indexOf('`src/a.ts`');
      const posB = md.indexOf('`src/b.ts`');

      expect(posC).toBeGreaterThan(-1);
      expect(posA).toBeGreaterThan(posC);
      expect(posB).toBeGreaterThan(posA);
    });
  });
});
