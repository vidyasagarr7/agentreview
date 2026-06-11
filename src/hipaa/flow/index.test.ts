// ─── index.test.ts — Tests for buildFlowOptions, flowPathsToFindings, and analyzePhiFlow ──────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildFlowOptions, flowPathsToFindings } from './index.js';
import { DEFAULT_FLOW_OPTIONS } from './types.js';
import type { VerifiedPath, FlowSafePatternConfig, FullImportGraph, FilePhiProfile, FlowAnalysisInput, LLMClient } from './types.js';
import type { HipaaConfig } from '../../config/repo-config.js';
import type { ImportEdge } from '../../types/index.js';

// ─── Mocks for analyzePhiFlow dependencies ───────────────────────────────────

const mockExtendPrGraph = vi.fn();
const mockBuildFullImportGraph = vi.fn();
vi.mock('./import-graph-full.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./import-graph-full.js')>();
  return {
    ...original,
    extendPrGraph: (...args: unknown[]) => mockExtendPrGraph(...args),
    buildFullImportGraph: (...args: unknown[]) => mockBuildFullImportGraph(...args),
  };
});

const mockProfileFiles = vi.fn();
vi.mock('./profiler.js', () => ({
  profileFiles: (...args: unknown[]) => mockProfileFiles(...args),
}));

const mockDetectRuntimeFlows = vi.fn();
vi.mock('./runtime-detector.js', () => ({
  detectRuntimeFlows: (...args: unknown[]) => mockDetectRuntimeFlows(...args),
}));

const mockBuildPhiFlowGraph = vi.fn();
vi.mock('./graph.js', () => ({
  buildPhiFlowGraph: (...args: unknown[]) => mockBuildPhiFlowGraph(...args),
}));

const mockVerifyPaths = vi.fn();
vi.mock('./verifier.js', () => ({
  verifyPaths: (...args: unknown[]) => mockVerifyPaths(...args),
}));

const mockApplySafePatterns = vi.fn();
vi.mock('./safe-patterns.js', () => {
  return {
    SafePatternMatcher: class {
      applySafePatterns(...args: unknown[]) { return mockApplySafePatterns(...args); }
    },
  };
});

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

// ─── Shared helpers for analyzePhiFlow tests ─────────────────────────────────

function makeEmptyImportGraph(): FullImportGraph {
  return {
    importsOut: new Map(),
    importsIn: new Map(),
    filesAnalyzed: 1,
    filesFailed: 0,
    diagnostics: [],
  };
}

function makeMockLLM(): LLMClient {
  return { chat: vi.fn().mockResolvedValue('{}') };
}

function setupDefaultMocks() {
  const graph = makeEmptyImportGraph();
  mockExtendPrGraph.mockResolvedValue(graph);
  mockBuildFullImportGraph.mockResolvedValue(graph);
  mockProfileFiles.mockResolvedValue(new Map<string, FilePhiProfile>());
  mockDetectRuntimeFlows.mockReturnValue([]);
  mockBuildPhiFlowGraph.mockReturnValue([]);
  mockApplySafePatterns.mockReturnValue([]);
  mockVerifyPaths.mockResolvedValue([]);
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

// ─── analyzePhiFlow ──────────────────────────────────────────────────────────

describe('analyzePhiFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('uses extendPrGraph when mode is pr with importGraph, tree, and fetcher', async () => {
    const { analyzePhiFlow } = await import('./index.js');
    const prGraph = makeEmptyImportGraph();
    prGraph.filesAnalyzed = 3;
    mockExtendPrGraph.mockResolvedValue(prGraph);

    const importGraph: ImportEdge[] = [{ from: 'a.ts', to: 'b.ts', symbols: ['foo'], external: false }];
    const tree = { sha: 'abc', truncated: false, entries: [{ path: 'a.ts', type: 'blob' as const }] };
    const fetcher = { fetchFile: vi.fn().mockResolvedValue('content') };

    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, mode: 'pr' },
      files: [{ path: 'a.ts', content: 'const x = 1;' }],
      llm: makeMockLLM(),
      importGraph,
      tree,
      fetcher,
    };

    const result = await analyzePhiFlow(input);

    expect(mockExtendPrGraph).toHaveBeenCalledWith(
      importGraph,
      ['a.ts'],
      tree,
      fetcher,
      DEFAULT_FLOW_OPTIONS.prHopDepth,
    );
    expect(mockBuildFullImportGraph).not.toHaveBeenCalled();
    expect(result.graphStats.filesAnalyzed).toBe(3);
  });

  it('uses buildFullImportGraph when tree and fetcher provided in scan mode', async () => {
    const { analyzePhiFlow } = await import('./index.js');
    const fullGraph = makeEmptyImportGraph();
    fullGraph.filesAnalyzed = 5;
    mockBuildFullImportGraph.mockResolvedValue(fullGraph);

    const tree = { sha: 'def', truncated: false, entries: [{ path: 'b.ts', type: 'blob' as const }] };
    const fetcher = { fetchFile: vi.fn().mockResolvedValue('content') };

    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, mode: 'scan' },
      files: [{ path: 'b.ts', content: 'export const y = 2;' }],
      llm: makeMockLLM(),
      tree,
      fetcher,
    };

    const result = await analyzePhiFlow(input);

    expect(mockBuildFullImportGraph).toHaveBeenCalledWith(
      ['b.ts'],
      tree,
      fetcher,
    );
    expect(mockExtendPrGraph).not.toHaveBeenCalled();
    expect(result.graphStats.filesAnalyzed).toBe(5);
  });

  it('builds import graph from file content map when no tree/fetcher provided', async () => {
    const { analyzePhiFlow } = await import('./index.js');
    const mapGraph = makeEmptyImportGraph();
    mapGraph.filesAnalyzed = 2;
    mockBuildFullImportGraph.mockResolvedValue(mapGraph);

    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, mode: 'scan' },
      files: [
        { path: 'c.ts', content: 'export const z = 3;' },
        { path: 'd.ts', content: 'import { z } from "./c";' },
      ],
      llm: makeMockLLM(),
      // no tree, no fetcher
    };

    const result = await analyzePhiFlow(input);

    expect(mockBuildFullImportGraph).toHaveBeenCalled();
    // Should have constructed a synthetic tree with both files
    const callArgs = mockBuildFullImportGraph.mock.calls[0];
    expect(callArgs[0]).toEqual(['c.ts', 'd.ts']);
    // tree arg should have entries for both files
    expect(callArgs[1].entries).toEqual([
      { path: 'c.ts', type: 'blob' },
      { path: 'd.ts', type: 'blob' },
    ]);
    expect(result.graphStats.filesAnalyzed).toBe(2);
  });

  it('creates minimal profile for files with runtime flows but no LLM profile', async () => {
    const { analyzePhiFlow } = await import('./index.js');
    mockBuildFullImportGraph.mockResolvedValue(makeEmptyImportGraph());

    // profileFiles returns profiles for only some files
    const existingProfiles = new Map<string, FilePhiProfile>();
    existingProfiles.set('known.ts', {
      sources: [{ name: 'getData', line: 1, type: 'db-query' }],
      sinks: [],
      transforms: [],
      exports: [],
      imports: [],
      runtimeFlows: [],
    });
    mockProfileFiles.mockResolvedValue(existingProfiles);

    // detectRuntimeFlows returns flows for a file NOT in profiles
    mockDetectRuntimeFlows.mockImplementation((filePath: string) => {
      if (filePath === 'unknown.ts') {
        return [{
          type: 'event-emit' as const,
          channel: 'data-channel',
          functionName: 'emitData',
          line: 5,
        }];
      }
      return [];
    });

    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS },
      files: [
        { path: 'known.ts', content: 'const data = query();' },
        { path: 'unknown.ts', content: 'emitter.emit("data-channel", payload);' },
      ],
      llm: makeMockLLM(),
    };

    const result = await analyzePhiFlow(input);

    // The unknown.ts file should have a minimal profile created
    const unknownProfile = result.profiles.get('unknown.ts');
    expect(unknownProfile).toBeDefined();
    expect(unknownProfile!.sources).toEqual([]);
    expect(unknownProfile!.sinks).toEqual([]);
    expect(unknownProfile!.transforms).toEqual([]);
    expect(unknownProfile!.exports).toEqual([]);
    expect(unknownProfile!.imports).toEqual([]);
    expect(unknownProfile!.runtimeFlows).toHaveLength(1);
    expect(unknownProfile!.runtimeFlows[0].channel).toBe('data-channel');
  });

  it('merges runtime flows into existing profiles', async () => {
    const { analyzePhiFlow } = await import('./index.js');
    mockBuildFullImportGraph.mockResolvedValue(makeEmptyImportGraph());

    const existingProfiles = new Map<string, FilePhiProfile>();
    existingProfiles.set('known.ts', {
      sources: [{ name: 'getData', line: 1, type: 'db-query' }],
      sinks: [],
      transforms: [],
      exports: [],
      imports: [],
      runtimeFlows: [{
        type: 'event-listen' as const,
        channel: 'existing',
        functionName: 'listen',
        line: 10,
      }],
    });
    mockProfileFiles.mockResolvedValue(existingProfiles);

    mockDetectRuntimeFlows.mockImplementation((filePath: string) => {
      if (filePath === 'known.ts') {
        return [{
          type: 'queue-publish' as const,
          channel: 'new-channel',
          functionName: 'publish',
          line: 20,
        }];
      }
      return [];
    });

    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS },
      files: [{ path: 'known.ts', content: 'queue.publish(data);' }],
      llm: makeMockLLM(),
    };

    const result = await analyzePhiFlow(input);

    const profile = result.profiles.get('known.ts');
    expect(profile).toBeDefined();
    // Should have both the existing runtime flow and the newly detected one
    expect(profile!.runtimeFlows).toHaveLength(2);
    expect(profile!.runtimeFlows[0].channel).toBe('existing');
    expect(profile!.runtimeFlows[1].channel).toBe('new-channel');
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

  // ─── generateSuggestion coverage ───────────────────────────────────────────

  describe('generateSuggestion — sink type branches', () => {
    it('suggests sanitization for log sink type', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'logger.ts', name: 'log', line: 5, type: 'log' } })]);
      expect(finding.suggestion).toContain('Sanitize or redact PHI before logging');
      expect(finding.suggestion).toContain('PHI-aware logger');
    });

    it('suggests sanitization for error-tracking sink type', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'sentry.ts', name: 'captureError', line: 10, type: 'error-tracking' } })]);
      expect(finding.suggestion).toContain('Sanitize or redact PHI before logging');
    });

    it('suggests sanitization for apm sink type', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'apm.ts', name: 'trace', line: 3, type: 'apm' } })]);
      expect(finding.suggestion).toContain('Sanitize or redact PHI before logging');
    });

    it('suggests CRITICAL BAA violation for external-api with no-baa', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({
        sink: { file: 'api.ts', name: 'sendData', line: 15, type: 'external-api' },
        baaStatus: 'no-baa',
      })]);
      expect(finding.suggestion).toContain('CRITICAL');
      expect(finding.suggestion).toContain('no BAA');
      expect(finding.suggestion).toContain('HIPAA violation');
    });

    it('suggests verifying BAA for external-api with covered baaStatus', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({
        sink: { file: 'api.ts', name: 'sendData', line: 15, type: 'external-api' },
        baaStatus: 'covered',
      })]);
      expect(finding.suggestion).toContain('Verify BAA status');
      expect(finding.suggestion).not.toContain('CRITICAL');
    });

    it('suggests verifying BAA for external-api with unknown baaStatus', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({
        sink: { file: 'api.ts', name: 'sendData', line: 15, type: 'external-api' },
        baaStatus: 'unknown',
      })]);
      expect(finding.suggestion).toContain('Verify BAA status');
    });

    it('suggests verifying BAA for webhook with no-baa', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({
        sink: { file: 'hook.ts', name: 'postHook', line: 7, type: 'webhook' },
        baaStatus: 'no-baa',
      })]);
      expect(finding.suggestion).toContain('CRITICAL');
    });

    it('suggests stripping PHI for analytics sink type', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'analytics.ts', name: 'track', line: 20, type: 'analytics' } })]);
      expect(finding.suggestion).toContain('Strip PHI before sending to analytics');
      expect(finding.suggestion).toContain('anonymous/aggregate');
    });

    it('suggests access controls for cache sink type', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'cache.ts', name: 'redis.set', line: 8, type: 'cache' } })]);
      expect(finding.suggestion).toContain('Ensure cache');
      expect(finding.suggestion).toContain('access controls and encryption');
    });

    it('suggests access controls for search-index sink type', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'search.ts', name: 'index', line: 12, type: 'search-index' } })]);
      expect(finding.suggestion).toContain('Ensure search-index');
      expect(finding.suggestion).toContain('access controls and encryption');
    });

    it('suggests reviewing PHI handling for default/unknown sink types', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'queue.ts', name: 'publish', line: 30, type: 'queue' } })]);
      expect(finding.suggestion).toContain('Review PHI handling');
      expect(finding.suggestion).toContain('HIPAA-compliant');
    });

    it('suggests reviewing PHI handling for notification sink type (default branch)', () => {
      const [finding] = flowPathsToFindings([makeVerifiedPath({ sink: { file: 'notify.ts', name: 'send', line: 4, type: 'notification' } })]);
      expect(finding.suggestion).toContain('Review PHI handling');
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
