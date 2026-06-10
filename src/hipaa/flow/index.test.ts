// ─── index.test.ts — Tests for buildFlowOptions and flowPathsToFindings ──────

import { describe, it, expect } from 'vitest';
import { buildFlowOptions, flowPathsToFindings } from './index.js';
import { DEFAULT_FLOW_OPTIONS } from './types.js';
import type { VerifiedPath, FlowSafePatternConfig } from './types.js';
import type { HipaaConfig } from '../../config/repo-config.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeVerifiedPath(overrides: Partial<VerifiedPath> = {}): VerifiedPath {
  return {
    source: {
      file: 'src/api/patients.ts',
      name: 'getPatient',
      line: 10,
      type: 'fhir-read',
    },
    intermediates: [],
    sink: {
      file: 'src/logging/logger.ts',
      name: 'logger.info',
      line: 25,
      type: 'log',
    },
    confidence: 'high',
    severity: 'HIGH',
    isLeak: true,
    explanation: 'PHI flows from FHIR read directly into a logger call.',
    baaRelevant: false,
    ...overrides,
  };
}

// ─── buildFlowOptions ────────────────────────────────────────────────────────

describe('buildFlowOptions', () => {
  it('returns DEFAULT_FLOW_OPTIONS unchanged when called with no args', () => {
    expect(buildFlowOptions()).toEqual(DEFAULT_FLOW_OPTIONS);
  });

  it('returns DEFAULT_FLOW_OPTIONS unchanged when called with empty config', () => {
    expect(buildFlowOptions({})).toEqual(DEFAULT_FLOW_OPTIONS);
  });

  it('applies flowMaxDepth → maxDepth override', () => {
    const result = buildFlowOptions({ flowMaxDepth: 10 });
    expect(result.maxDepth).toBe(10);
    expect(result.maxPaths).toBe(DEFAULT_FLOW_OPTIONS.maxPaths);
    expect(result.maxFiles).toBe(DEFAULT_FLOW_OPTIONS.maxFiles);
    expect(result.prHopDepth).toBe(DEFAULT_FLOW_OPTIONS.prHopDepth);
    expect(result.safePatterns).toEqual(DEFAULT_FLOW_OPTIONS.safePatterns);
  });

  it('applies flowMaxPaths → maxPaths override', () => {
    const result = buildFlowOptions({ flowMaxPaths: 50 });
    expect(result.maxPaths).toBe(50);
    expect(result.maxDepth).toBe(DEFAULT_FLOW_OPTIONS.maxDepth);
  });

  it('applies flowMaxFiles → maxFiles override', () => {
    const result = buildFlowOptions({ flowMaxFiles: 500 });
    expect(result.maxFiles).toBe(500);
    expect(result.maxDepth).toBe(DEFAULT_FLOW_OPTIONS.maxDepth);
  });

  it('applies flowPrHopDepth → prHopDepth override', () => {
    const result = buildFlowOptions({ flowPrHopDepth: 4 });
    expect(result.prHopDepth).toBe(4);
    expect(result.maxDepth).toBe(DEFAULT_FLOW_OPTIONS.maxDepth);
  });

  it('applies flowSafePatterns → safePatterns override', () => {
    const safePatterns: FlowSafePatternConfig[] = [
      { pattern: 'redact*', type: 'sanitizer' },
      { pattern: 'pickSafeFields', type: 'projection' },
    ];
    const result = buildFlowOptions({ flowSafePatterns: safePatterns });
    expect(result.safePatterns).toEqual(safePatterns);
    expect(result.maxDepth).toBe(DEFAULT_FLOW_OPTIONS.maxDepth);
  });

  it('applies all overrides together', () => {
    const safePatterns: FlowSafePatternConfig[] = [{ pattern: 'sanitize*', type: 'sanitizer' }];
    const config: HipaaConfig = {
      flowMaxDepth: 7,
      flowMaxPaths: 30,
      flowMaxFiles: 300,
      flowPrHopDepth: 3,
      flowSafePatterns: safePatterns,
    };
    const result = buildFlowOptions(config);
    expect(result.maxDepth).toBe(7);
    expect(result.maxPaths).toBe(30);
    expect(result.maxFiles).toBe(300);
    expect(result.prHopDepth).toBe(3);
    expect(result.safePatterns).toEqual(safePatterns);
  });

  it('partial config keeps defaults for unset fields', () => {
    const result = buildFlowOptions({ flowMaxDepth: 8 });
    expect(result.maxDepth).toBe(8);
    expect(result.mode).toBe(DEFAULT_FLOW_OPTIONS.mode);
    expect(result.maxPaths).toBe(DEFAULT_FLOW_OPTIONS.maxPaths);
    expect(result.maxFiles).toBe(DEFAULT_FLOW_OPTIONS.maxFiles);
    expect(result.prHopDepth).toBe(DEFAULT_FLOW_OPTIONS.prHopDepth);
    expect(result.callTimeoutMs).toBe(DEFAULT_FLOW_OPTIONS.callTimeoutMs);
    expect(result.failureAbortThreshold).toBe(DEFAULT_FLOW_OPTIONS.failureAbortThreshold);
    expect(result.safePatterns).toEqual(DEFAULT_FLOW_OPTIONS.safePatterns);
  });

  it('ignores undefined fields (does not override defaults)', () => {
    const result = buildFlowOptions({
      flowMaxDepth: undefined,
      flowMaxPaths: undefined,
      flowMaxFiles: undefined,
      flowPrHopDepth: undefined,
      flowSafePatterns: undefined,
    });
    expect(result).toEqual(DEFAULT_FLOW_OPTIONS);
  });

  it('does not mutate DEFAULT_FLOW_OPTIONS', () => {
    const snapshot = JSON.parse(JSON.stringify(DEFAULT_FLOW_OPTIONS));
    buildFlowOptions({ flowMaxDepth: 99, flowMaxPaths: 99 });
    expect(DEFAULT_FLOW_OPTIONS).toEqual(snapshot);
  });
});

// ─── flowPathsToFindings ─────────────────────────────────────────────────────

describe('flowPathsToFindings', () => {
  it('returns empty array for empty input', () => {
    expect(flowPathsToFindings([])).toEqual([]);
  });

  it('produces a correctly-shaped AgentFinding for a single path with no intermediates', () => {
    const path = makeVerifiedPath();
    const [finding] = flowPathsToFindings([path]);

    expect(finding.id).toBe('phi-flow-1');
    expect(finding.severity).toBe('HIGH');
    expect(finding.category).toBe('HIPAA / PHI Data Flow');
    expect(finding.location).toBe('src/api/patients.ts:10 → src/logging/logger.ts:25');
    expect(finding.lenses).toEqual(['hipaa']);
    expect(finding.scannerId).toBe('phi-flow-analysis');
    expect(finding.regulation).toBe('HIPAA §164.502(a)');
    expect(finding.summary).toContain('fhir-read');
    expect(finding.summary).toContain('getPatient');
    expect(finding.summary).toContain('log');
    expect(finding.summary).toContain('logger.info');
  });

  it('assigns sequential ids starting at phi-flow-1', () => {
    const findings = flowPathsToFindings([
      makeVerifiedPath(),
      makeVerifiedPath(),
      makeVerifiedPath(),
    ]);
    expect(findings.map((f) => f.id)).toEqual(['phi-flow-1', 'phi-flow-2', 'phi-flow-3']);
  });

  it('propagates severity from the path', () => {
    const critical = flowPathsToFindings([makeVerifiedPath({ severity: 'CRITICAL' })])[0];
    const medium = flowPathsToFindings([makeVerifiedPath({ severity: 'MEDIUM' })])[0];
    const low = flowPathsToFindings([makeVerifiedPath({ severity: 'LOW' })])[0];

    expect(critical.severity).toBe('CRITICAL');
    expect(medium.severity).toBe('MEDIUM');
    expect(low.severity).toBe('LOW');
  });

  // ─── Confidence mapping ────────────────────────────────────────────────────

  describe('confidence mapping', () => {
    it('maps high → 0.9', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ confidence: 'high' })]);
      expect(finding.confidenceScore).toBe(0.9);
    });

    it('maps medium → 0.7', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ confidence: 'medium' })]);
      expect(finding.confidenceScore).toBe(0.7);
    });

    it('maps low → 0.5', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ confidence: 'low' })]);
      expect(finding.confidenceScore).toBe(0.5);
    });
  });

  // ─── BAA notes ──────────────────────────────────────────────────────────────

  describe('BAA notes', () => {
    it('omits BAA note when baaRelevant is false', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ baaRelevant: false })]);
      expect(finding.detail).not.toContain('BAA Status');
      expect(finding.detail).not.toMatch(/⚠️|✅|❓/);
    });

    it('adds warning emoji for no-baa status', () => {
      const [finding] = flowPathsToFindings([
        makeVerifiedPath({ baaRelevant: true, baaStatus: 'no-baa' }),
      ]);
      expect(finding.detail).toContain('BAA Status: no-baa');
      expect(finding.detail).toContain('⚠️');
      expect(finding.detail).toContain('NO Business Associate Agreement');
    });

    it('adds checkmark for covered status', () => {
      const [finding] = flowPathsToFindings([
        makeVerifiedPath({ baaRelevant: true, baaStatus: 'covered' }),
      ]);
      expect(finding.detail).toContain('BAA Status: covered');
      expect(finding.detail).toContain('✅');
      expect(finding.detail).toContain('Covered by BAA');
    });

    it('adds question mark for unknown status', () => {
      const [finding] = flowPathsToFindings([
        makeVerifiedPath({ baaRelevant: true, baaStatus: 'unknown' }),
      ]);
      expect(finding.detail).toContain('BAA Status: unknown');
      expect(finding.detail).toContain('❓');
      expect(finding.detail).toContain('verify with compliance team');
    });

    it('defaults to unknown question-mark note when baaRelevant but baaStatus is missing', () => {
      const [finding] = flowPathsToFindings([
        makeVerifiedPath({ baaRelevant: true, baaStatus: undefined }),
      ]);
      expect(finding.detail).toContain('BAA Status: unknown');
      expect(finding.detail).toContain('❓');
    });
  });

  // ─── Multi-step intermediates ───────────────────────────────────────────────

  describe('multi-step intermediates', () => {
    it('joins multiple intermediates with → in the flow chain', () => {
      const path = makeVerifiedPath({
        intermediates: [
          { file: 'src/services/patient-service.ts', name: 'fetchPatient', line: 42, mechanism: 'direct' },
          { file: 'src/events/emitter.ts', name: 'emit', line: 18, mechanism: 'event-emit' },
        ],
      });
      const [finding] = flowPathsToFindings([path]);

      expect(finding.detail).toContain('Flow chain:');
      expect(finding.detail).toContain(
        'src/api/patients.ts:10 → src/services/patient-service.ts:42 (direct) → src/events/emitter.ts:18 (event-emit) → src/logging/logger.ts:25',
      );
    });

    it('handles a single intermediate', () => {
      const path = makeVerifiedPath({
        intermediates: [
          { file: 'src/services/service.ts', name: 'helper', line: 5, mechanism: 'callback' },
        ],
      });
      const [finding] = flowPathsToFindings([path]);
      expect(finding.detail).toContain(
        'src/api/patients.ts:10 → src/services/service.ts:5 (callback) → src/logging/logger.ts:25',
      );
    });

    it('omits intermediate segment from flow chain when intermediates is empty', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ intermediates: [] })]);
      expect(finding.detail).toContain(
        'Flow chain: src/api/patients.ts:10 → src/logging/logger.ts:25',
      );
    });
  });
});
