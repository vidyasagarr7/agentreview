import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import type { AgentFinding } from '../types/index.js';
import type { Baseline } from './baseline.js';
import {
  generateFingerprint,
  loadBaseline,
  saveBaseline,
  filterNewFindings,
  createBaseline,
} from './baseline.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    id: overrides.id ?? 'f-1',
    severity: overrides.severity ?? 'HIGH',
    category: overrides.category ?? 'sql-injection',
    location: overrides.location ?? 'src/auth.ts:42',
    summary: overrides.summary ?? 'SQL injection in user input',
    detail: overrides.detail ?? 'User input is not sanitized',
    suggestion: overrides.suggestion ?? 'Use parameterized queries',
    lenses: overrides.lenses ?? ['security'],
  };
}

function makeBaseline(entries: Baseline['entries'] = [], target = '/my-project'): Baseline {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    target,
    entries,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateFingerprint', () => {
  it('produces consistent hash for the same finding', () => {
    const finding = makeFinding();
    const fp1 = generateFingerprint(finding);
    const fp2 = generateFingerprint(finding);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('produces same hash regardless of line number', () => {
    const f1 = makeFinding({ location: 'src/auth.ts:42' });
    const f2 = makeFinding({ location: 'src/auth.ts:99' });
    expect(generateFingerprint(f1)).toBe(generateFingerprint(f2));
  });

  it('produces different hash for different findings', () => {
    const f1 = makeFinding({ category: 'sql-injection', location: 'src/auth.ts:42' });
    const f2 = makeFinding({ category: 'xss', location: 'src/render.ts:10' });
    expect(generateFingerprint(f1)).not.toBe(generateFingerprint(f2));
  });

  it('produces different hash for different files same category', () => {
    const f1 = makeFinding({ location: 'src/a.ts:1' });
    const f2 = makeFinding({ location: 'src/b.ts:1' });
    expect(generateFingerprint(f1)).not.toBe(generateFingerprint(f2));
  });

  it('produces different hash for different summaries', () => {
    const f1 = makeFinding({ summary: 'SQL injection via user input' });
    const f2 = makeFinding({ summary: 'Hardcoded API key found' });
    expect(generateFingerprint(f1)).not.toBe(generateFingerprint(f2));
  });
});

describe('loadBaseline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'baseline-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for missing file', async () => {
    const result = await loadBaseline(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('reads valid baseline', async () => {
    const baseline = makeBaseline([
      {
        fingerprint: 'abc123',
        severity: 'HIGH',
        location: 'src/auth.ts:42',
        summary: 'Test finding',
        suppressedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const filePath = join(tmpDir, '.agentreview-baseline.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(filePath, JSON.stringify(baseline, null, 2), 'utf-8');

    const result = await loadBaseline(filePath);
    expect(result).toEqual(baseline);
    expect(result!.entries).toHaveLength(1);
    expect(result!.version).toBe(1);
  });
});

describe('saveBaseline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'baseline-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes valid JSON', async () => {
    const baseline = makeBaseline([
      {
        fingerprint: 'abc123',
        severity: 'MEDIUM',
        location: 'src/config.ts:10',
        summary: 'Hardcoded secret',
        suppressedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const filePath = join(tmpDir, 'baseline.json');
    await saveBaseline(filePath, baseline);

    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(baseline);
    // Verify indentation (pretty-printed)
    expect(raw).toContain('  ');
  });
});

describe('filterNewFindings', () => {
  it('suppresses findings that match baseline', () => {
    const finding = makeFinding();
    const fp = generateFingerprint(finding);
    const baseline = makeBaseline([
      {
        fingerprint: fp,
        severity: 'HIGH',
        location: finding.location,
        summary: finding.summary,
        suppressedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = filterNewFindings([finding], baseline);
    expect(result.new).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]).toBe(finding);
  });

  it('reports findings NOT in baseline as new', () => {
    const finding = makeFinding({ category: 'xss', summary: 'XSS in template rendering' });
    const baseline = makeBaseline([
      {
        fingerprint: 'totally-different-fingerprint',
        severity: 'HIGH',
        location: 'src/other.ts:1',
        summary: 'Other issue',
        suppressedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = filterNewFindings([finding], baseline);
    expect(result.new).toHaveLength(1);
    expect(result.new[0]).toBe(finding);
    expect(result.suppressed).toHaveLength(0);
  });

  it('treats empty baseline as all new', () => {
    const findings = [
      makeFinding({ id: 'f-1' }),
      makeFinding({ id: 'f-2', category: 'xss', summary: 'XSS vulnerability' }),
    ];
    const baseline = makeBaseline([]);

    const result = filterNewFindings(findings, baseline);
    expect(result.new).toHaveLength(2);
    expect(result.suppressed).toHaveLength(0);
  });

  it('correctly splits mixed findings', () => {
    const knownFinding = makeFinding({ id: 'f-1' });
    const newFinding = makeFinding({ id: 'f-2', category: 'xss', summary: 'XSS in output' });
    const knownFp = generateFingerprint(knownFinding);

    const baseline = makeBaseline([
      {
        fingerprint: knownFp,
        severity: 'HIGH',
        location: knownFinding.location,
        summary: knownFinding.summary,
        suppressedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = filterNewFindings([knownFinding, newFinding], baseline);
    expect(result.new).toHaveLength(1);
    expect(result.new[0].id).toBe('f-2');
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].id).toBe('f-1');
  });
});

describe('createBaseline', () => {
  it('creates valid baseline structure', () => {
    const findings = [
      makeFinding({ id: 'f-1' }),
      makeFinding({ id: 'f-2', category: 'xss', summary: 'XSS vulnerability', severity: 'MEDIUM' }),
    ];

    const baseline = createBaseline(findings, '/my-project');

    expect(baseline.version).toBe(1);
    expect(baseline.target).toBe('/my-project');
    expect(baseline.createdAt).toBeTruthy();
    expect(baseline.updatedAt).toBeTruthy();
    expect(baseline.entries).toHaveLength(2);

    // Each entry has correct shape
    for (const entry of baseline.entries) {
      expect(entry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.severity).toBeTruthy();
      expect(entry.location).toBeTruthy();
      expect(entry.summary).toBeTruthy();
      expect(entry.suppressedAt).toBeTruthy();
    }

    // Fingerprints match what generateFingerprint would produce
    expect(baseline.entries[0].fingerprint).toBe(generateFingerprint(findings[0]));
    expect(baseline.entries[1].fingerprint).toBe(generateFingerprint(findings[1]));
  });

  it('creates empty baseline for no findings', () => {
    const baseline = createBaseline([], '/empty-project');
    expect(baseline.entries).toHaveLength(0);
    expect(baseline.target).toBe('/empty-project');
  });
});
