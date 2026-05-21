import { describe, it, expect, beforeEach } from 'vitest';
import { fhirRulesScanner } from './fhir-rules.js';
import { resetCounter, type ScannerOptions } from './types.js';

function opts(): ScannerOptions {
  return { phiFields: new Set(['patientName']), phiSourcePatterns: [] };
}

// Helper: wrap code lines with a fetch import so the scanner activates
function withFetchImport(code: string): string {
  return `import { fetch } from 'node-fetch';\n${code}`;
}

describe('fhirRulesScanner', () => {
  beforeEach(() => resetCounter());

  // ── Check 1: _elements ──────────────────────────────────────────────────

  it('flags /Patient? search without _elements', () => {
    const files = new Map([
      ['src/api/search.ts', withFetchImport('const url = "/Patient?name=Smith";')],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
    expect(findings[0].category).toBe('FHIR Minimum Necessary');
  });

  it('does NOT flag /Patient? search with _elements on same line', () => {
    const files = new Map([
      ['src/api/search.ts', withFetchImport('const url = "/Patient?name=Smith&_elements=id,name";')],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  // ── Check 2: SMART scopes ──────────────────────────────────────────────

  it('flags user/*.* scope as HIGH', () => {
    const files = new Map([
      ['src/auth/scopes.ts', withFetchImport("const scope = 'user/*.*';")],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
    expect(findings[0].category).toBe('FHIR Scope Overprivilege');
  });

  it('does NOT flag patient/*.read scope', () => {
    const files = new Map([
      ['src/auth/scopes.ts', withFetchImport("const scope = 'patient/*.read';")],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  // ── Check 3: Bulk $export ─────────────────────────────────────────────

  it('flags $export without _type', () => {
    const files = new Map([
      ['src/bulk/export.ts', withFetchImport('fetch("/$export");')],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
    expect(findings[0].category).toBe('FHIR Bulk Export');
  });

  it('does NOT flag $export with _type', () => {
    const files = new Map([
      ['src/bulk/export.ts', withFetchImport('fetch("/$export?_type=Patient");')],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  // ── Route definition guard ────────────────────────────────────────────

  it('does NOT flag route definition without HTTP client import', () => {
    const files = new Map([
      ['src/routes/patient.ts', `
import { Router } from 'express';
const router = Router();
router.get('/Patient?name=Smith', handler);
`],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  it('flags user/*.read scope as MEDIUM', () => {
    const files = new Map([
      ['src/auth/scopes.ts', withFetchImport("const scope = 'user/*.read';")],
    ]);
    const findings = fhirRulesScanner.scan(files, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('MEDIUM');
  });
});
