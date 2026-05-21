import { describe, it, expect, beforeEach } from 'vitest';
import { httpPhiScanner } from './http-phi.js';
import { resetCounter, type ScannerOptions } from './types.js';

function opts(overrides?: Partial<ScannerOptions>): ScannerOptions {
  return {
    phiFields: new Set(['patientName', 'ssn']),
    phiSourcePatterns: [],
    skipTests: true,
    ...overrides,
  };
}

describe('httpPhiScanner', () => {
  beforeEach(() => resetCounter());

  it('flags http:// URL in a PHI-relevant file as CRITICAL', () => {
    const files = new Map([
      ['src/fhir/client.ts', 'const url = "http://api.internal/patients";'],
    ]);
    const findings = httpPhiScanner.scan(files, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].regulation).toBe('45 CFR §164.312(e)');
    expect(findings[0].location).toBe('src/fhir/client.ts:1');
  });

  it('does NOT flag https:// URLs', () => {
    const files = new Map([
      ['src/patient/api.ts', 'const url = "https://api.internal/patients";'],
    ]);
    const findings = httpPhiScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag allowlisted localhost', () => {
    const files = new Map([
      ['src/fhir/dev.ts', 'const url = "http://localhost:3000/api";'],
    ]);
    const findings = httpPhiScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag allowlisted 127.0.0.1', () => {
    const files = new Map([
      ['src/patient/dev.ts', 'const url = "http://127.0.0.1:8080/api";'],
    ]);
    const findings = httpPhiScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  it('skips test files', () => {
    const files = new Map([
      ['src/fhir/client.test.ts', 'const url = "http://api.external/patients";'],
    ]);
    const findings = httpPhiScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag http:// in non-PHI file', () => {
    const files = new Map([
      ['src/utils/logger.ts', 'const url = "http://api.external/logs";'],
    ]);
    const findings = httpPhiScanner.scan(files, opts());
    expect(findings).toHaveLength(0);
  });

  it('flags when file matches phiSourcePatterns', () => {
    const files = new Map([
      ['src/services/data.ts', 'fetch("http://api.external/data");'],
    ]);
    const findings = httpPhiScanner.scan(files, opts({ phiSourcePatterns: ['src/services/.*'] }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
  });
});
