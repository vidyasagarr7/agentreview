import { describe, it, expect, beforeEach } from 'vitest';
import { selectStarScanner } from './select-star.js';
import { resetCounter, type ScannerOptions } from './types.js';
import { buildPhiFieldSet } from '../phi-patterns.js';

describe('select-star scanner', () => {
  let options: ScannerOptions;

  beforeEach(() => {
    resetCounter();
    options = { phiFields: buildPhiFieldSet() };
  });

  it('detects SELECT * FROM patients (HIGH)', () => {
    const files = new Map([
      ['src/repo.ts', "const q = `SELECT * FROM patients`;"],
    ]);
    const findings = selectStarScanner.scan(files, options);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
    expect(findings[0].summary).toContain('patients');
  });

  it('detects multiline SELECT *', () => {
    const code = `const q = \`
      SELECT
        *
      FROM
        patients
      WHERE id = 1
    \`;`;
    const files = new Map([['src/query.ts', code]]);
    const findings = selectStarScanner.scan(files, options);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('allows SELECT with explicit columns', () => {
    const files = new Map([
      ['src/safe.ts', "const q = `SELECT id, name FROM patients`;"],
    ]);
    const findings = selectStarScanner.scan(files, options);
    expect(findings).toHaveLength(0);
  });

  it('ignores SELECT * from non-PHI tables', () => {
    const files = new Map([
      ['src/logs.ts', "const q = `SELECT * FROM audit_logs`;"],
    ]);
    const findings = selectStarScanner.scan(files, options);
    expect(findings).toHaveLength(0);
  });

  it('detects Patient.findAll() without attributes (MEDIUM)', () => {
    const files = new Map([
      ['src/orm.ts', 'const patients = await Patient.findAll();'],
    ]);
    const findings = selectStarScanner.scan(files, options);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('MEDIUM');
    expect(findings[0].summary).toContain('findAll');
  });

  it('allows Patient.findAll with explicit attributes', () => {
    const files = new Map([
      ['src/orm-safe.ts', "const patients = await Patient.findAll({ attributes: ['id'] });"],
    ]);
    const findings = selectStarScanner.scan(files, options);
    expect(findings).toHaveLength(0);
  });
});
