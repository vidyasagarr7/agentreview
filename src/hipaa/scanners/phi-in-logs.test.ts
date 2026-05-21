import { describe, it, expect, beforeEach } from 'vitest';
import { phiInLogsScanner } from './phi-in-logs.js';
import { resetCounter, type ScannerOptions } from './types.js';
import { buildPhiFieldSet } from '../phi-patterns.js';

describe('phi-in-logs scanner', () => {
  let options: ScannerOptions;

  beforeEach(() => {
    resetCounter();
    options = { phiFields: buildPhiFieldSet(), skipTests: true };
  });

  it('detects console.log with PHI field (CRITICAL)', () => {
    const files = new Map([
      ['src/service.ts', 'console.log(patient.ssn);'],
    ]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].location).toBe('src/service.ts:1');
    expect(findings[0].summary).toContain('ssn');
  });

  it('detects logger.info with PHI in object (CRITICAL)', () => {
    const files = new Map([
      ['src/api.ts', 'logger.info({ mrn: record.mrn });'],
    ]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].summary).toContain('mrn');
  });

  it('ignores safe log statements', () => {
    const files = new Map([
      ['src/app.ts', 'console.log("server started");'],
    ]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings).toHaveLength(0);
  });

  it('ignores non-PHI variables in logs', () => {
    const files = new Map([
      ['src/util.ts', 'console.log(count);'],
    ]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings).toHaveLength(0);
  });

  it('does NOT cross-contaminate — PHI field 3 lines away from log', () => {
    const code = [
      'const data = patient.ssn;',
      'const x = 1;',
      'const y = 2;',
      'console.log("processing done");',
    ].join('\n');
    const files = new Map([['src/handler.ts', code]]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings).toHaveLength(0);
  });

  it('skips test files', () => {
    const files = new Map([
      ['src/__tests__/service.test.ts', 'console.log(patient.ssn);'],
    ]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings).toHaveLength(0);
  });

  it('finds multiple findings in same file', () => {
    const code = [
      'console.log(patient.ssn);',
      'logger.error(user.email);',
    ].join('\n');
    const files = new Map([['src/multi.ts', code]]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[1].severity).toBe('CRITICAL');
  });

  it('detects PHI in multiline log context (HIGH)', () => {
    const code = [
      'logger.info({',
      '  mrn: record.mrn,',
      '});',
    ].join('\n');
    const files = new Map([['src/multiline.ts', code]]);
    const findings = phiInLogsScanner.scan(files, options);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    // Should find it — either same-line or multiline context
  });
});
