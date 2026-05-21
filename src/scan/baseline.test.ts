import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentFinding } from '../types/index.js';
import type { Baseline } from './baseline.js';
import { generateFingerprint, loadBaseline, saveBaseline, filterNewFindings, createBaseline } from './baseline.js';

function makeFinding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    id: overrides.id ?? 'f-1', severity: overrides.severity ?? 'HIGH',
    category: overrides.category ?? 'sql-injection', location: overrides.location ?? 'src/auth.ts:42',
    summary: overrides.summary ?? 'SQL injection in user input', detail: overrides.detail ?? 'User input is not sanitized',
    suggestion: overrides.suggestion ?? 'Use parameterized queries', lenses: overrides.lenses ?? ['security'],
  };
}
function makeBaseline(entries: Baseline['entries'] = [], target = '/my-project'): Baseline {
  return { version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', target, entries };
}

describe('generateFingerprint', () => {
  it('produces consistent hash for the same finding', () => {
    const f = makeFinding();
    expect(generateFingerprint(f)).toBe(generateFingerprint(f));
    expect(generateFingerprint(f)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('produces same hash regardless of line number', () => {
    expect(generateFingerprint(makeFinding({ location: 'src/auth.ts:42' }))).toBe(generateFingerprint(makeFinding({ location: 'src/auth.ts:99' })));
  });
  it('produces different hash for different findings', () => {
    expect(generateFingerprint(makeFinding({ category: 'sql-injection', location: 'src/auth.ts:42' }))).not.toBe(generateFingerprint(makeFinding({ category: 'xss', location: 'src/render.ts:10' })));
  });
  it('produces different hash for different files same category', () => {
    expect(generateFingerprint(makeFinding({ location: 'src/a.ts:1' }))).not.toBe(generateFingerprint(makeFinding({ location: 'src/b.ts:1' })));
  });
  it('produces different hash for different summaries', () => {
    expect(generateFingerprint(makeFinding({ summary: 'SQL injection via user input' }))).not.toBe(generateFingerprint(makeFinding({ summary: 'Hardcoded API key found' })));
  });
});

describe('loadBaseline', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'bl-')); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it('returns null for missing file', async () => { expect(await loadBaseline(join(tmpDir, 'x.json'))).toBeNull(); });
  it('reads valid baseline', async () => {
    const bl = makeBaseline([{ fingerprint: 'abc', severity: 'HIGH', location: 'a.ts:1', summary: 'x', suppressedAt: '2026-01-01T00:00:00.000Z' }]);
    const p = join(tmpDir, 'bl.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(p, JSON.stringify(bl, null, 2), 'utf-8');
    const r = await loadBaseline(p);
    expect(r).toEqual(bl);
    expect(r!.entries).toHaveLength(1);
  });
});

describe('saveBaseline', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'bl-')); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it('writes valid JSON', async () => {
    const bl = makeBaseline([{ fingerprint: 'abc', severity: 'MEDIUM', location: 'c.ts:10', summary: 'x', suppressedAt: '2026-01-01T00:00:00.000Z' }]);
    const p = join(tmpDir, 'bl.json');
    await saveBaseline(p, bl);
    const raw = await readFile(p, 'utf-8');
    expect(JSON.parse(raw)).toEqual(bl);
  });
});

describe('filterNewFindings', () => {
  it('suppresses findings in baseline', () => {
    const f = makeFinding();
    const bl = makeBaseline([{ fingerprint: generateFingerprint(f), severity: 'HIGH', location: f.location, summary: f.summary, suppressedAt: '2026-01-01T00:00:00.000Z' }]);
    const r = filterNewFindings([f], bl);
    expect(r.new).toHaveLength(0);
    expect(r.suppressed).toHaveLength(1);
  });
  it('reports findings NOT in baseline as new', () => {
    const f = makeFinding({ category: 'xss', summary: 'XSS in template' });
    const bl = makeBaseline([{ fingerprint: 'different', severity: 'HIGH', location: 'other.ts:1', summary: 'Other', suppressedAt: '2026-01-01T00:00:00.000Z' }]);
    const r = filterNewFindings([f], bl);
    expect(r.new).toHaveLength(1);
    expect(r.suppressed).toHaveLength(0);
  });
  it('treats empty baseline as all new', () => {
    const r = filterNewFindings([makeFinding(), makeFinding({ id: 'f-2', category: 'xss', summary: 'XSS' })], makeBaseline([]));
    expect(r.new).toHaveLength(2);
    expect(r.suppressed).toHaveLength(0);
  });
  it('correctly splits mixed findings', () => {
    const known = makeFinding({ id: 'f-1' });
    const newF = makeFinding({ id: 'f-2', category: 'xss', summary: 'XSS in output' });
    const bl = makeBaseline([{ fingerprint: generateFingerprint(known), severity: 'HIGH', location: known.location, summary: known.summary, suppressedAt: '2026-01-01T00:00:00.000Z' }]);
    const r = filterNewFindings([known, newF], bl);
    expect(r.new).toHaveLength(1);
    expect(r.new[0].id).toBe('f-2');
    expect(r.suppressed).toHaveLength(1);
  });
});

describe('createBaseline', () => {
  it('creates valid baseline structure', () => {
    const findings = [makeFinding(), makeFinding({ id: 'f-2', category: 'xss', summary: 'XSS', severity: 'MEDIUM' })];
    const bl = createBaseline(findings, '/proj');
    expect(bl.version).toBe(1);
    expect(bl.entries).toHaveLength(2);
    bl.entries.forEach(e => expect(e.fingerprint).toMatch(/^[a-f0-9]{64}$/));
    expect(bl.entries[0].fingerprint).toBe(generateFingerprint(findings[0]));
  });
  it('creates empty baseline for no findings', () => {
    expect(createBaseline([], '/empty').entries).toHaveLength(0);
  });
});
