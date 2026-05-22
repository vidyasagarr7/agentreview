import { createDeterministicFinding } from './types.js';
import type { Scanner, ScannerOptions } from './types.js';
import type { AgentFinding } from '../../types/index.js';

const SCANNER_ID = 'hl7-phi';
const SCANNER_NAME = 'HL7v2 PHI Detection';
const REGULATION = '45 CFR §164.312(b), §164.530(c)';
const CATEGORY = 'HL7v2 PHI Exposure';

// ── Log-call patterns ─────────────────────────────────────────────────────────
// Matches console.log / console.warn / console.error / logger.info etc.
const LOG_CALL_RE =
  /\b(?:console\.(?:log|warn|error|info|debug|trace)|logger\.(?:log|warn|error|info|debug|trace|fatal))\s*\(/i;

// ── HL7 full-message variable names in a log call ─────────────────────────────
// e.g. console.log(hl7Message), logger.info(adtEvent), log(oruResult)
const HL7_VAR_RE =
  /\b(?:hl7|adt|oru|hl7message|hl7msg|hl7_message|hl7_msg|adtMessage|adtEvent|oruMessage|oruResult|rawMessage|rawHl7)\b/i;

// ── Raw HL7 pipe-delimited content ────────────────────────────────────────────
// In source files the backslash may appear as literal \ (escaped in string)
const RAW_MSH_RE = /MSH\|\^\~\\{1,2}&\|/;

// ── PHI-containing segment references (PID, NK1, IN1, IN2, DG1, GT1) ─────────
const PHI_SEGMENT_RE =
  /\b(?:pid|nk1|in1|in2|dg1|gt1)/i;

// ── MSH segment reference (header only) ───────────────────────────────────────
const MSH_REF_RE = /\bmsh/i;

// ── Raw segment pipe pattern: e.g. PID|1||MRN123 ─────────────────────────────
const RAW_PHI_SEGMENT_RE = /\b(?:PID|NK1|IN1|IN2|DG1|GT1)\s*\|/;

// ── Test-file detection ───────────────────────────────────────────────────────
function isTestFile(path: string): boolean {
  return /(?:\.test\.|\.spec\.|__tests__|__mocks__|\/test\/|\/tests\/|\.stories\.)/.test(path);
}

export const hl7PhiScanner: Scanner = {
  id: SCANNER_ID,
  name: SCANNER_NAME,

  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[] {
    const findings: AgentFinding[] = [];

    for (const [filePath, content] of files) {
      if (options.skipTests !== false && isTestFile(filePath)) continue;

      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const location = `${filePath}:${lineNum}`;
        const hasLogCall = LOG_CALL_RE.test(line);

        // ── 1. Raw HL7 pipe-delimited MSH in code/log → CRITICAL ──────────
        if (RAW_MSH_RE.test(line) && hasLogCall) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'CRITICAL',
              category: CATEGORY,
              location,
              summary: 'Raw HL7v2 message logged',
              detail: `Raw HL7v2 MSH segment logged at ${location}. HL7 messages contain full patient demographics, diagnoses, and insurance data.`,
              suggestion:
                'Remove raw HL7 message from log output. Log only message control ID (MSH-10) or a sanitized summary.',
              regulation: REGULATION,
            }),
          );
          continue; // most severe match for this line, skip further checks
        }

        // ── 2. Raw PHI segment pipe pattern (PID|1||MRN) ─────────────────
        if (RAW_PHI_SEGMENT_RE.test(line)) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'HIGH',
              category: CATEGORY,
              location,
              summary: 'Raw HL7v2 PHI segment in code',
              detail: `Raw HL7v2 PHI segment pattern detected at ${location}. Pipe-delimited segment data contains patient identifiers.`,
              suggestion:
                'Remove raw HL7 segment data from source. Use parsed field references and redact PHI before any output.',
              regulation: REGULATION,
            }),
          );
          continue;
        }

        // Only check log-context patterns if there's a log call on this line
        if (!hasLogCall) continue;

        // ── 3. HL7 full-message variable in log → CRITICAL ───────────────
        if (HL7_VAR_RE.test(line)) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'CRITICAL',
              category: CATEGORY,
              location,
              summary: 'HL7v2 message variable logged',
              detail: `HL7v2 message variable logged at ${location}. Full HL7 messages contain PHI across multiple segments.`,
              suggestion:
                'Do not log entire HL7 message objects. Log only the message control ID or event type.',
              regulation: REGULATION,
            }),
          );
          continue;
        }

        // ── 4. PHI-containing segment refs in log → HIGH ─────────────────
        if (PHI_SEGMENT_RE.test(line) && !MSH_REF_RE.test(line)) {
          // Has a PHI segment but not just MSH alone
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'HIGH',
              category: CATEGORY,
              location,
              summary: 'HL7v2 PHI segment referenced in log',
              detail: `HL7v2 PHI segment reference in log at ${location}. Segments like PID, NK1, IN1, DG1, GT1 contain protected health information.`,
              suggestion:
                'Do not log PHI-bearing HL7 segments directly. Extract only non-PHI fields or redact before logging.',
              regulation: REGULATION,
            }),
          );
          continue;
        }

        // Also catch lines that have BOTH PHI segments and MSH
        if (PHI_SEGMENT_RE.test(line) && MSH_REF_RE.test(line)) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'HIGH',
              category: CATEGORY,
              location,
              summary: 'HL7v2 PHI segment referenced in log',
              detail: `HL7v2 PHI segment reference in log at ${location}. Segments like PID, NK1, IN1, DG1, GT1 contain protected health information.`,
              suggestion:
                'Do not log PHI-bearing HL7 segments directly. Extract only non-PHI fields or redact before logging.',
              regulation: REGULATION,
            }),
          );
          continue;
        }

        // ── 5. MSH segment alone in log → MEDIUM ─────────────────────────
        if (MSH_REF_RE.test(line)) {
          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'MEDIUM',
              category: CATEGORY,
              location,
              summary: 'HL7v2 MSH segment referenced in log',
              detail: `HL7v2 MSH (header) segment referenced in log at ${location}. While MSH itself may not contain PHI, logging it implies the system processes full HL7 messages.`,
              suggestion:
                'Review logging practices for HL7 message processing. Ensure no downstream logging exposes PHI segments.',
              regulation: REGULATION,
            }),
          );
        }
      }
    }

    return findings;
  },
};
