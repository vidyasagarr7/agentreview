// ─── graph.test.ts — Tests for PHI flow graph traversal, ranking, and dedup ──

import { describe, it, expect } from 'vitest';
import { buildPhiFlowGraph } from './graph.js';
import type {
  FilePhiProfile,
  FullImportGraph,
  FlowAnalysisOptions,
} from './types.js';
import type { ImportEdge } from '../../types/index.js';
import { DEFAULT_FLOW_OPTIONS } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyProfile(overrides: Partial<FilePhiProfile> = {}): FilePhiProfile {
  return {
    sources: [],
    sinks: [],
    transforms: [],
    exports: [],
    imports: [],
    runtimeFlows: [],
    ...overrides,
  };
}

function makeImportGraph(
  outEdges: Map<string, ImportEdge[]>,
  inEdges: Map<string, ImportEdge[]>,
): FullImportGraph {
  return {
    importsOut: outEdges,
    importsIn: inEdges,
    filesAnalyzed: 0,
    filesFailed: 0,
    diagnostics: [],
  };
}

function opts(overrides: Partial<FlowAnalysisOptions> = {}): FlowAnalysisOptions {
  return { ...DEFAULT_FLOW_OPTIONS, ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildPhiFlowGraph', () => {
  it('simple 2-file flow: source → import → sink → high confidence', () => {
    // File A has a PHI source, File B imports from A and has a sink
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/patient-repo.ts', emptyProfile({
      sources: [{ name: 'getPatient', line: 10, type: 'fhir-read' }],
      exports: [{ name: 'getPatient', containsPhi: true }],
    }));
    profiles.set('src/handler.ts', emptyProfile({
      sinks: [{ name: 'console.log', line: 5, type: 'log' }],
      imports: [{ from: 'src/patient-repo.ts', names: ['getPatient'] }],
    }));

    const edge: ImportEdge = {
      from: 'src/handler.ts',
      to: 'src/patient-repo.ts',
      symbols: ['getPatient'],
      external: false,
    };
    const graph = makeImportGraph(
      new Map([['src/handler.ts', [edge]]]),
      new Map([['src/patient-repo.ts', [edge]]]),
    );

    const paths = buildPhiFlowGraph(profiles, graph, opts());

    expect(paths).toHaveLength(1);
    expect(paths[0].source.file).toBe('src/patient-repo.ts');
    expect(paths[0].source.type).toBe('fhir-read');
    expect(paths[0].sink.file).toBe('src/handler.ts');
    expect(paths[0].sink.type).toBe('log');
    expect(paths[0].confidence).toBe('high');
    expect(paths[0].severity).toBe('HIGH');
  });

  it('3-file chain: source → transform → sink → medium confidence', () => {
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/db.ts', emptyProfile({
      sources: [{ name: 'queryPatients', line: 20, type: 'db-query' }],
      exports: [{ name: 'queryPatients', containsPhi: true }],
    }));
    profiles.set('src/transform.ts', emptyProfile({
      transforms: [{ name: 'sanitize', line: 5, inputParam: 'queryPatients', outputReturn: true, mechanism: 'direct' }],
      exports: [{ name: 'sanitize', containsPhi: true }],
      imports: [{ from: 'src/db.ts', names: ['queryPatients'] }],
    }));
    profiles.set('src/api.ts', emptyProfile({
      sinks: [{ name: 'res.json', line: 15, type: 'response' }],
      imports: [{ from: 'src/transform.ts', names: ['sanitize'] }],
    }));

    // db.ts ← transform.ts ← api.ts
    const edge1: ImportEdge = { from: 'src/transform.ts', to: 'src/db.ts', symbols: ['queryPatients'], external: false };
    const edge2: ImportEdge = { from: 'src/api.ts', to: 'src/transform.ts', symbols: ['sanitize'], external: false };

    const graph = makeImportGraph(
      new Map([
        ['src/transform.ts', [edge1]],
        ['src/api.ts', [edge2]],
      ]),
      new Map([
        ['src/db.ts', [edge1]],
        ['src/transform.ts', [edge2]],
      ]),
    );

    const paths = buildPhiFlowGraph(profiles, graph, opts());

    // Should find a path from db.ts → transform.ts → api.ts
    const apiPath = paths.find((p) => p.sink.file === 'src/api.ts');
    expect(apiPath).toBeDefined();
    expect(apiPath!.source.file).toBe('src/db.ts');
    expect(apiPath!.intermediates.length).toBeGreaterThanOrEqual(1);
    // 3 hops: db → transform → api → should be medium (through transform)
    expect(apiPath!.confidence).toBe('medium');
  });

  it('event emitter flow: emit → on with sink → detected', () => {
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/emitter.ts', emptyProfile({
      sources: [{ name: 'loadPatient', line: 10, type: 'fhir-read' }],
      runtimeFlows: [{
        type: 'event-emit',
        channel: 'patient',
        functionName: 'emitPatient',
        line: 15,
      }],
    }));
    profiles.set('src/listener.ts', emptyProfile({
      sinks: [{ name: 'logger.info', line: 20, type: 'log' }],
      runtimeFlows: [{
        type: 'event-listen',
        channel: 'patient',
        functionName: 'handlePatient',
        line: 5,
      }],
    }));

    const graph = makeImportGraph(new Map(), new Map());
    const paths = buildPhiFlowGraph(profiles, graph, opts());

    expect(paths.length).toBeGreaterThanOrEqual(1);
    const eventPath = paths.find(
      (p) => p.source.file === 'src/emitter.ts' && p.sink.file === 'src/listener.ts',
    );
    expect(eventPath).toBeDefined();
    expect(eventPath!.confidence).toBe('high'); // literal channel name, 22642 hops
  });

  it('max depth exceeded → no path generated beyond depth', () => {
    // Build a chain of 7 files, maxDepth = 3
    const profiles = new Map<string, FilePhiProfile>();
    const inEdges = new Map<string, ImportEdge[]>();

    profiles.set('src/f0.ts', emptyProfile({
      sources: [{ name: 'getData', line: 1, type: 'db-query' }],
      exports: [{ name: 'getData', containsPhi: true }],
    }));

    for (let i = 1; i <= 6; i++) {
      const prev = `src/f${i - 1}.ts`;
      const curr = `src/f${i}.ts`;
      profiles.set(curr, emptyProfile({
        ...(i === 6 ? { sinks: [{ name: 'log', line: 1, type: 'log' }] } : {}),
        exports: [{ name: `pass${i}`, containsPhi: true }],
        imports: [{ from: prev, names: [`pass${i - 1}`] }],
      }));

      const edge: ImportEdge = { from: curr, to: prev, symbols: [`pass${i - 1}`], external: false };
      inEdges.set(prev, [...(inEdges.get(prev) ?? []), edge]);
    }

    const graph = makeImportGraph(new Map(), inEdges);
    const paths = buildPhiFlowGraph(profiles, graph, opts({ maxDepth: 3 }));

    // The sink is at f6.ts which is 6 hops away — should not be reachable with maxDepth=3
    const deepPath = paths.find((p) => p.sink.file === 'src/f6.ts');
    expect(deepPath).toBeUndefined();
  });

  it('circular import → no infinite loop', () => {
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/a.ts', emptyProfile({
      sources: [{ name: 'getA', line: 1, type: 'fhir-read' }],
      exports: [{ name: 'getA', containsPhi: true }],
      imports: [{ from: 'src/b.ts', names: ['getB'] }],
    }));
    profiles.set('src/b.ts', emptyProfile({
      sinks: [{ name: 'logB', line: 5, type: 'log' }],
      exports: [{ name: 'getB', containsPhi: true }],
      imports: [{ from: 'src/a.ts', names: ['getA'] }],
    }));

    // Circular: a → b and b → a
    const edgeAB: ImportEdge = { from: 'src/b.ts', to: 'src/a.ts', symbols: ['getA'], external: false };
    const edgeBA: ImportEdge = { from: 'src/a.ts', to: 'src/b.ts', symbols: ['getB'], external: false };

    const graph = makeImportGraph(
      new Map([['src/a.ts', [edgeBA]], ['src/b.ts', [edgeAB]]]),
      new Map([['src/a.ts', [edgeAB]], ['src/b.ts', [edgeBA]]]),
    );

    // Should not hang — just complete in reasonable time
    const paths = buildPhiFlowGraph(profiles, graph, opts());
    expect(paths).toBeDefined();
    // Should find path a→b since b has a sink
    const p = paths.find((p) => p.source.file === 'src/a.ts' && p.sink.file === 'src/b.ts');
    expect(p).toBeDefined();
  });

  it('path dedup: same source+sink → shortest kept', () => {
    // Two paths from A to C: direct (A→C) and indirect (A→B→C)
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/a.ts', emptyProfile({
      sources: [{ name: 'getData', line: 1, type: 'fhir-read' }],
      exports: [{ name: 'getData', containsPhi: true }],
    }));
    profiles.set('src/b.ts', emptyProfile({
      exports: [{ name: 'passData', containsPhi: true }],
      imports: [{ from: 'src/a.ts', names: ['getData'] }],
    }));
    profiles.set('src/c.ts', emptyProfile({
      sinks: [{ name: 'logIt', line: 10, type: 'log' }],
      imports: [
        { from: 'src/a.ts', names: ['getData'] },
        { from: 'src/b.ts', names: ['passData'] },
      ],
    }));

    const edgeAC: ImportEdge = { from: 'src/c.ts', to: 'src/a.ts', symbols: ['getData'], external: false };
    const edgeAB: ImportEdge = { from: 'src/b.ts', to: 'src/a.ts', symbols: ['getData'], external: false };
    const edgeBC: ImportEdge = { from: 'src/c.ts', to: 'src/b.ts', symbols: ['passData'], external: false };

    const graph = makeImportGraph(
      new Map([
        ['src/b.ts', [edgeAB]],
        ['src/c.ts', [edgeAC, edgeBC]],
      ]),
      new Map([
        ['src/a.ts', [edgeAC, edgeAB]],
        ['src/b.ts', [edgeBC]],
      ]),
    );

    const paths = buildPhiFlowGraph(profiles, graph, opts());

    // Should dedup to 1 path (same source getData in a.ts → same sink logIt in c.ts)
    const matchingPaths = paths.filter(
      (p) => p.source.file === 'src/a.ts' && p.source.name === 'getData'
        && p.sink.file === 'src/c.ts' && p.sink.name === 'logIt',
    );
    expect(matchingPaths).toHaveLength(1);
    // Should keep the shorter one (direct A→C, 1 hop)
    expect(matchingPaths[0].intermediates.length).toBeLessThanOrEqual(1);
  });

  it('path prioritization: 30 paths, maxPaths=20 → top 20 by heuristic', () => {
    // Generate 30 paths with different sink types and source types
    const profiles = new Map<string, FilePhiProfile>();
    const inEdges = new Map<string, ImportEdge[]>();

    profiles.set('src/source.ts', emptyProfile({
      sources: [
        { name: 'fhirRead', line: 1, type: 'fhir-read' },
        { name: 'dbQuery', line: 2, type: 'db-query' },
        { name: 'funcParam', line: 3, type: 'function-param' },
      ],
      exports: [
        { name: 'fhirRead', containsPhi: true },
        { name: 'dbQuery', containsPhi: true },
        { name: 'funcParam', containsPhi: true },
      ],
    }));

    // Create 10 sink files with different sink types
    const sinkTypes: Array<{ name: string; type: 'log' | 'external-api' | 'analytics' | 'cache' | 'response' }> = [
      { name: 'logSink', type: 'log' },
      { name: 'apiSink', type: 'external-api' },
      { name: 'analyticsSink', type: 'analytics' },
      { name: 'cacheSink', type: 'cache' },
      { name: 'responseSink', type: 'response' },
      { name: 'logSink2', type: 'log' },
      { name: 'apiSink2', type: 'external-api' },
      { name: 'analyticsSink2', type: 'analytics' },
      { name: 'cacheSink2', type: 'cache' },
      { name: 'responseSink2', type: 'response' },
    ];

    for (let i = 0; i < sinkTypes.length; i++) {
      const sinkFile = `src/sink${i}.ts`;
      profiles.set(sinkFile, emptyProfile({
        sinks: [{ name: sinkTypes[i].name, line: 1, type: sinkTypes[i].type }],
        imports: [{ from: 'src/source.ts', names: ['fhirRead', 'dbQuery', 'funcParam'] }],
      }));

      const edge: ImportEdge = {
        from: sinkFile,
        to: 'src/source.ts',
        symbols: ['fhirRead', 'dbQuery', 'funcParam'],
        external: false,
      };
      const existing = inEdges.get('src/source.ts') ?? [];
      existing.push(edge);
      inEdges.set('src/source.ts', existing);
    }

    const graph = makeImportGraph(new Map(), inEdges);
    const paths = buildPhiFlowGraph(profiles, graph, opts({ maxPaths: 20 }));

    // Should be capped at 20
    expect(paths.length).toBe(20);

    // log and external-api sinks should be prioritized (higher in SINK_SEVERITY_ORDER)
    const topSinkTypes = paths.slice(0, 6).map((p) => p.sink.type);
    expect(topSinkTypes.every((t) => t === 'log' || t === 'external-api')).toBe(true);
  });

  it('no PHI sources → empty result', () => {
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/clean.ts', emptyProfile({
      sinks: [{ name: 'logger', line: 1, type: 'log' }],
    }));

    const graph = makeImportGraph(new Map(), new Map());
    const paths = buildPhiFlowGraph(profiles, graph, opts());

    expect(paths).toHaveLength(0);
  });

  it('runtime queue flow: publish → subscribe with sink → detected', () => {
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/publisher.ts', emptyProfile({
      sources: [{ name: 'fetchHL7', line: 5, type: 'hl7-v2' }],
      runtimeFlows: [{
        type: 'queue-publish',
        channel: 'patient-updates',
        functionName: 'publishUpdate',
        line: 10,
      }],
    }));
    profiles.set('src/subscriber.ts', emptyProfile({
      sinks: [{ name: 'sendToThirdParty', line: 15, type: 'external-api' }],
      runtimeFlows: [{
        type: 'queue-subscribe',
        channel: 'patient-updates',
        functionName: 'processUpdate',
        line: 3,
      }],
    }));

    const graph = makeImportGraph(new Map(), new Map());
    const paths = buildPhiFlowGraph(profiles, graph, opts());

    expect(paths.length).toBeGreaterThanOrEqual(1);
    const queuePath = paths.find(
      (p) => p.source.file === 'src/publisher.ts' && p.sink.file === 'src/subscriber.ts',
    );
    expect(queuePath).toBeDefined();
    expect(queuePath!.sink.type).toBe('external-api');
    // Dynamic channel → low confidence
    expect(queuePath!.confidence).toBe('high'); // literal topic name
  });

  it('high confidence + external-api sink → CRITICAL severity', () => {
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/source.ts', emptyProfile({
      sources: [{ name: 'getPatient', line: 1, type: 'fhir-read' }],
      sinks: [{ name: 'sendToApi', line: 10, type: 'external-api' }],
    }));

    const graph = makeImportGraph(new Map(), new Map());
    const paths = buildPhiFlowGraph(profiles, graph, opts());

    expect(paths).toHaveLength(1);
    expect(paths[0].confidence).toBe('high');
    expect(paths[0].severity).toBe('CRITICAL');
  });

  it('medium confidence + fhir-bulk source → HIGH severity override', () => {
    const profiles = new Map<string, FilePhiProfile>();
    profiles.set('src/bulk.ts', emptyProfile({
      sources: [{ name: 'bulkExport', line: 1, type: 'fhir-bulk' }],
      exports: [{ name: 'bulkExport', containsPhi: true }],
    }));
    profiles.set('src/mid.ts', emptyProfile({
      transforms: [{ name: 'transform', line: 5, inputParam: 'bulkExport', outputReturn: true, mechanism: 'direct' }],
      exports: [{ name: 'transform', containsPhi: true }],
      imports: [{ from: 'src/bulk.ts', names: ['bulkExport'] }],
    }));
    profiles.set('src/sink.ts', emptyProfile({
      sinks: [{ name: 'store', line: 10, type: 'storage' }],
      imports: [{ from: 'src/mid.ts', names: ['transform'] }],
    }));

    const edge1: ImportEdge = { from: 'src/mid.ts', to: 'src/bulk.ts', symbols: ['bulkExport'], external: false };
    const edge2: ImportEdge = { from: 'src/sink.ts', to: 'src/mid.ts', symbols: ['transform'], external: false };

    const graph = makeImportGraph(
      new Map([['src/mid.ts', [edge1]], ['src/sink.ts', [edge2]]]),
      new Map([['src/bulk.ts', [edge1]], ['src/mid.ts', [edge2]]]),
    );

    const paths = buildPhiFlowGraph(profiles, graph, opts());
    const sinkPath = paths.find((p) => p.sink.file === 'src/sink.ts');
    expect(sinkPath).toBeDefined();
    expect(sinkPath!.confidence).toBe('medium');
    expect(sinkPath!.severity).toBe('HIGH'); // override: fhir-bulk + medium → HIGH
  });
});
