import { describe, it, expect, beforeEach } from 'vitest';
import { runDeterministicScan } from './index.js';
import type { HipaaConfig } from '../../config/repo-config.js';
describe('runDeterministicScan (orchestrator)', () => {
  beforeEach(() => {
  });
  it('runs all scanners when all enabled (default)', () => {
    const files = new Map([
      // phi-in-logs trigger
      ['src/service.ts', 'console.log(patient.ssn);'],
      // select-star trigger
      ['src/query.sql', 'SELECT * FROM patients WHERE id = 1;'],
    ]);
    const findings = runDeterministicScan(files);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    // Check deterministic metadata on all
    for (const f of findings) {
      expect(f.confidenceScore).toBe(100);
      expect(f.deterministic).toBe(true);
    }
  });
  it('skips disabled scanner', () => {
    const files = new Map([
      ['src/service.ts', 'console.log(patient.ssn);'],
      ['src/query.sql', 'SELECT * FROM patients WHERE id = 1;'],
    ]);
    const config: HipaaConfig = {
      scanners: {
        'phi-in-logs': false,
      },
    };
    const findings = runDeterministicScan(files, config);
    // phi-in-logs is disabled, so no finding from that scanner
    const phiLogFindings = findings.filter((f) => f.scannerId === 'phi-in-logs');
    expect(phiLogFindings).toHaveLength(0);
    // select-star should still produce findings
    const selectStarFindings = findings.filter((f) => f.scannerId === 'select-star');
    expect(selectStarFindings.length).toBeGreaterThanOrEqual(1);
  });
  it('results are merged flat', () => {
    const files = new Map([
      ['src/service.ts', 'console.log(patient.ssn);'],
      ['src/query.sql', 'SELECT * FROM patients WHERE id = 1;'],
    ]);
    const findings = runDeterministicScan(files);
    expect(Array.isArray(findings)).toBe(true);
    // All findings should be in a single flat array
    for (const f of findings) {
      expect(f).toHaveProperty('id');
      expect(f).toHaveProperty('severity');
      expect(f).toHaveProperty('scannerId');
    }
  });
  it('empty input returns empty output', () => {
    const files = new Map<string, string>();
    const findings = runDeterministicScan(files);
    expect(findings).toHaveLength(0);
  });
  it('respects custom phiFields from config', () => {
    const files = new Map([
      ['src/service.ts', 'console.log(record.customSecret);'],
    ]);
    const config: HipaaConfig = {
      phiFields: ['customSecret'],
    };
    const findings = runDeterministicScan(files, config);
    const phiLogFindings = findings.filter((f) => f.scannerId === 'phi-in-logs');
    expect(phiLogFindings.length).toBeGreaterThanOrEqual(1);
  });
  it('enables all scanners when scanners config is absent', () => {
    const files = new Map([
      ['src/fhir/client.ts', [
        'import axios from "axios";',
        'const result = axios.get("/Patient?name=test");',
      ].join('\n')],
    ]);
    const config: HipaaConfig = {};
    const findings = runDeterministicScan(files, config);
    // fhir-rules should fire (Patient search without _elements)
    const fhirFindings = findings.filter((f) => f.scannerId === 'fhir-rules');
    expect(fhirFindings.length).toBeGreaterThanOrEqual(1);
  });
});
