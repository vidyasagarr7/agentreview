import { describe, it, expect, beforeEach } from 'vitest';
import { hl7PhiScanner } from './hl7-phi.js';
import { resetCounter } from './types.js';
import type { ScannerOptions } from './types.js';

const defaultOpts: ScannerOptions = {
  phiFields: new Set(['ssn', 'mrn', 'dob', 'name', 'address', 'phone']),
  skipTests: true,
};

function scan(code: string, path = 'src/hl7/parser.ts') {
  const files = new Map([[path, code]]);
  return hl7PhiScanner.scan(files, defaultOpts);
}

describe('HL7v2 PHI Detection Scanner', () => {
  beforeEach(() => resetCounter());

  // ── CRITICAL: Full HL7 message variable in log ──────────────────────────
  it('flags console.log(hl7Message) as CRITICAL', () => {
    const findings = scan('console.log(hl7Message);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].scannerId).toBe('hl7-phi');
  });

  it('flags logger.info(adtEvent) as CRITICAL', () => {
    const findings = scan('logger.info(adtEvent);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
  });

  it('flags console.log(oruResult) as CRITICAL', () => {
    const findings = scan('console.log(oruResult);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
  });

  // ── CRITICAL: Raw MSH|^~\\&| in log ────────────────────────────────────
  it('flags raw MSH|^~\\&| in log as CRITICAL', () => {
    const findings = scan('console.log("MSH|^~\\\\&|SENDING_APP|...");');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].summary).toContain('Raw HL7v2 message');
  });

  // ── HIGH: Individual PHI segments in logs ───────────────────────────────
  it('flags logger.info(pid.toString()) as HIGH', () => {
    const findings = scan('logger.info(pid.toString());');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('flags console.log(nk1Segment) as HIGH', () => {
    const findings = scan('console.log(nk1Segment);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('flags IN1 segment in log as HIGH', () => {
    const findings = scan('logger.debug(in1.toString());');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('flags DG1 segment in log as HIGH', () => {
    const findings = scan('console.log(dg1Data);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('flags GT1 segment in log as HIGH', () => {
    const findings = scan('console.warn(gt1Record);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });

  // ── HIGH: Raw PID|1||MRN pipe data ─────────────────────────────────────
  it('flags raw PID|1||MRN123 as HIGH', () => {
    const findings = scan('const data = "PID|1||MRN123^^^HOSP";');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
    expect(findings[0].summary).toContain('Raw HL7v2 PHI segment');
  });

  // ── MEDIUM: MSH segment alone in log ───────────────────────────────────
  it('flags console.log(msh.sendingApp) as MEDIUM', () => {
    const findings = scan('console.log(msh.sendingApp);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('MEDIUM');
  });

  it('flags logger.info(mshHeader) as MEDIUM', () => {
    const findings = scan('logger.info(mshHeader);');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('MEDIUM');
  });

  // ── No finding: HL7 parsed but not logged ──────────────────────────────
  it('does not flag HL7 parsing without logging', () => {
    const code = `
const parsed = parseHL7(rawMessage);
const pid = parsed.getSegment('PID');
const name = pid.getField(5);
return { name };
`;
    const findings = scan(code);
    expect(findings).toHaveLength(0);
  });

  it('does not flag HL7 variable assignment without log', () => {
    const findings = scan('const hl7Message = parser.parse(buffer);');
    expect(findings).toHaveLength(0);
  });

  // ── Test file skipping ─────────────────────────────────────────────────
  it('skips test files when skipTests is true', () => {
    const findings = scan('console.log(hl7Message);', 'src/hl7/parser.test.ts');
    expect(findings).toHaveLength(0);
  });

  it('scans test files when skipTests is false', () => {
    const opts: ScannerOptions = { ...defaultOpts, skipTests: false };
    const files = new Map([['src/hl7/parser.test.ts', 'console.log(hl7Message);']]);
    const findings = hl7PhiScanner.scan(files, opts);
    expect(findings).toHaveLength(1);
  });

  // ── Multiple findings in one file ──────────────────────────────────────
  it('reports multiple findings across lines', () => {
    const code = `
console.log(hl7Message);
logger.info(pid.toString());
console.log(msh.sendingApp);
`;
    const findings = scan(code);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[1].severity).toBe('HIGH');
    expect(findings[2].severity).toBe('MEDIUM');
  });

  // ── Regulation check ───────────────────────────────────────────────────
  it('includes correct regulation reference', () => {
    const findings = scan('console.log(hl7Message);');
    expect(findings[0].regulation).toBe('45 CFR §164.312(b), §164.530(c)');
  });

  // ── Deterministic fields ───────────────────────────────────────────────
  it('sets deterministic=true and confidenceScore=100', () => {
    const findings = scan('console.log(hl7Message);');
    expect(findings[0].deterministic).toBe(true);
    expect(findings[0].confidenceScore).toBe(100);
  });
});
