// ─── graph.ts — PHI flow graph traversal, ranking, and dedup ────────────────

import type { FindingSeverity } from '../../types/index.js';
import type {
  FilePhiProfile,
  FullImportGraph,
  FlowAnalysisOptions,
  PhiFlowPath,
  PhiSourceType,
  PhiSinkType,
} from './types.js';

// ─── Sink severity ordering (higher index = worse) ───────────────────────────

const SINK_SEVERITY_ORDER: PhiSinkType[] = [
  'cache', 'search-index', 'storage',
  'template-render', 'document-gen', 'queue', 'notification',
  'response', 'apm',
  'log', 'error-tracking', 'analytics',
  'webhook', 'external-api',  // External data transfer is highest risk for HIPAA
];

// ─── Source specificity ordering (higher index = more specific) ───────────────

const SOURCE_SPECIFICITY_ORDER: PhiSourceType[] = [
  'env-config', 'file-read', 'function-param', 'api-response',
  'smart-launch', 'cds-hook', 'cda',
  'db-stored-proc', 'db-query', 'hl7-v2',
  'fhir-search', 'fhir-bulk', 'fhir-read',
];

// ─── Confidence helpers ──────────────────────────────────────────────────────

function computeConfidence(
  hops: number,
  hasTransform: boolean,
  hasDynamicChannel: boolean,
): 'high' | 'medium' | 'low' {
  if (hasDynamicChannel || hops > 4) return 'low';
  if (hasTransform || (hops >= 3 && hops <= 4)) return 'medium';
  if (hops <= 2) return 'high';
  return 'medium';
}

function computeSeverity(
  confidence: 'high' | 'medium' | 'low',
  sinkType: PhiSinkType,
  sourceType: PhiSourceType,
  safePatterns: Array<{ pattern: string; type: string }>,
  sinkName: string,
): FindingSeverity {
  // Check safe pattern override for low confidence
  if (confidence === 'low') {
    for (const sp of safePatterns) {
      if (sp.type === 'expected-sink' || sp.type === 'compliant-sink') {
        if (new RegExp(sp.pattern).test(sinkName)) return 'INFO';
      }
    }
  }

  // Base mapping
  let severity: FindingSeverity;
  switch (confidence) {
    case 'high':
      severity = 'HIGH';
      break;
    case 'medium':
      severity = 'MEDIUM';
      break;
    case 'low':
      severity = 'LOW';
      break;
  }

  // Overrides
  if (confidence === 'high' && sinkType === 'external-api') {
    severity = 'CRITICAL';
  }
  if (confidence === 'medium' && (sourceType === 'fhir-bulk' || sourceType === 'hl7-v2')) {
    severity = 'HIGH';
  }

  return severity;
}

// ─── Internal path representation during traversal ───────────────────────────

interface TraversalHop {
  file: string;
  name: string;
  line: number;
  mechanism: string;
}

interface CandidatePath {
  sourceFile: string;
  sourceName: string;
  sourceLine: number;
  sourceType: PhiSourceType;
  hops: TraversalHop[];
  sinkFile: string;
  sinkName: string;
  sinkLine: number;
  sinkType: PhiSinkType;
  hasTransform: boolean;
  hasDynamicChannel: boolean;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export function buildPhiFlowGraph(
  profiles: Map<string, FilePhiProfile>,
  importGraph: FullImportGraph,
  options: FlowAnalysisOptions,
): PhiFlowPath[] {
  const maxDepth = options.maxDepth ?? 5;
  const candidates: CandidatePath[] = [];

  // Build runtime flow index: channel → listeners/subscribers
  const runtimeListeners = new Map<string, Array<{ file: string; functionName: string; line: number }>>();
  for (const [file, profile] of profiles) {
    for (const rf of profile.runtimeFlows) {
      if (rf.type === 'event-listen' || rf.type === 'queue-subscribe') {
        const key = `${rf.type === 'event-listen' ? 'event' : 'queue'}:${rf.channel}`;
        const existing = runtimeListeners.get(key) ?? [];
        existing.push({ file, functionName: rf.functionName, line: rf.line });
        runtimeListeners.set(key, existing);
      }
    }
  }

  // For each file with PHI sources, start traversal
  for (const [file, profile] of profiles) {
    for (const source of profile.sources) {
      // Check for sinks in the same file (0-hop, direct)
      for (const sink of profile.sinks) {
        candidates.push({
          sourceFile: file,
          sourceName: source.name,
          sourceLine: source.line,
          sourceType: source.type,
          hops: [],
          sinkFile: file,
          sinkName: sink.name,
          sinkLine: sink.line,
          sinkType: sink.type,
          hasTransform: false,
          hasDynamicChannel: false,
        });
      }

      // Trace through import graph and runtime flows
      traceForward({
        currentFile: file,
        originFile: file,
        source,
        profiles,
        importGraph,
        runtimeListeners,
        maxDepth,
        candidates,
        visited: new Set<string>([file]),
        currentHops: [],
        hasTransform: false,
        hasDynamicChannel: false,
      });
    }
  }

  // ─── 7b: Dedup ──────────────────────────────────────────────────────────
  // Same source file+name + same sink file+name → keep shortest
  const dedupMap = new Map<string, CandidatePath>();
  for (const c of candidates) {
    const key = `${c.sourceFile}:${c.sourceName}→${c.sinkFile}:${c.sinkName}`;
    const existing = dedupMap.get(key);
    if (!existing || c.hops.length < existing.hops.length) {
      dedupMap.set(key, c);
    }
  }

  let deduped = Array.from(dedupMap.values());

  // ─── 7b: Rank and limit ─────────────────────────────────────────────────
  deduped.sort((a, b) => {
    // 1. Sink type severity (higher index in SINK_SEVERITY_ORDER = worse = first)
    const sinkA = SINK_SEVERITY_ORDER.indexOf(a.sinkType);
    const sinkB = SINK_SEVERITY_ORDER.indexOf(b.sinkType);
    if (sinkA !== sinkB) return sinkB - sinkA;

    // 2. Shorter paths preferred
    if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;

    // 3. Source specificity (higher index = more specific = first)
    const srcA = SOURCE_SPECIFICITY_ORDER.indexOf(a.sourceType);
    const srcB = SOURCE_SPECIFICITY_ORDER.indexOf(b.sourceType);
    return srcB - srcA;
  });

  if (deduped.length > options.maxPaths) {
    deduped = deduped.slice(0, options.maxPaths);
  }

  // ─── Convert to PhiFlowPath ──────────────────────────────────────────────
  return deduped.map((c) => {
    // hops count: intermediates + 1 for final edge to sink
    const hopCount = c.hops.length + (c.sourceFile !== c.sinkFile ? 1 : 0);
    const confidence = computeConfidence(hopCount, c.hasTransform, c.hasDynamicChannel);
    const severity = computeSeverity(
      confidence, c.sinkType, c.sourceType,
      options.safePatterns, c.sinkName,
    );

    return {
      source: { file: c.sourceFile, name: c.sourceName, line: c.sourceLine, type: c.sourceType },
      intermediates: c.hops.map((h) => ({
        file: h.file, name: h.name, line: h.line, mechanism: h.mechanism,
      })),
      sink: { file: c.sinkFile, name: c.sinkName, line: c.sinkLine, type: c.sinkType },
      confidence,
      severity,
    };
  });
}

// ─── Forward traversal (DFS) ─────────────────────────────────────────────────

interface TraceContext {
  currentFile: string;
  originFile: string;
  source: { name: string; line: number; type: PhiSourceType };
  profiles: Map<string, FilePhiProfile>;
  importGraph: FullImportGraph;
  runtimeListeners: Map<string, Array<{ file: string; functionName: string; line: number }>>;
  maxDepth: number;
  candidates: CandidatePath[];
  visited: Set<string>;
  currentHops: TraversalHop[];
  hasTransform: boolean;
  hasDynamicChannel: boolean;
}

function traceForward(ctx: TraceContext): void {
  if (ctx.currentHops.length >= ctx.maxDepth) return;

  const currentProfile = ctx.profiles.get(ctx.currentFile);
  // Don't bail if profile is missing — still traverse import edges
  // so "glue" files outside the maxFiles cap don't sever taint chains.

  // ─── Runtime flows (event-emit, queue-publish) ────────────────────────
  // Only check runtime flows if we have a profile for this file
  const runtimeFlows = currentProfile?.runtimeFlows ?? [];
  for (const rf of runtimeFlows) {
    if (rf.type !== 'event-emit' && rf.type !== 'queue-publish') continue;

    const isDynamic = rf.channel === '<dynamic>' || rf.channel === '<unknown>';
    const key = `${rf.type === 'event-emit' ? 'event' : 'queue'}:${rf.channel}`;
    const listeners = ctx.runtimeListeners.get(key) ?? [];

    for (const listener of listeners) {
      if (ctx.visited.has(listener.file)) continue;

      const newHops: TraversalHop[] = [...ctx.currentHops, {
        file: ctx.currentFile,
        name: rf.functionName,
        line: rf.line,
        mechanism: rf.type,
      }];

      const listenerProfile = ctx.profiles.get(listener.file);
      if (!listenerProfile) continue;

      // Check sinks in listener file
      for (const sink of listenerProfile.sinks) {
        ctx.candidates.push({
          sourceFile: ctx.originFile,
          sourceName: ctx.source.name,
          sourceLine: ctx.source.line,
          sourceType: ctx.source.type,
          hops: newHops,
          sinkFile: listener.file,
          sinkName: sink.name,
          sinkLine: sink.line,
          sinkType: sink.type,
          hasTransform: ctx.hasTransform,
          hasDynamicChannel: ctx.hasDynamicChannel || isDynamic,
        });
      }

      // Continue traversal from listener
      const newVisited = new Set(ctx.visited);
      newVisited.add(listener.file);
      traceForward({
        ...ctx,
        currentFile: listener.file,
        visited: newVisited,
        currentHops: newHops,
        hasDynamicChannel: ctx.hasDynamicChannel || isDynamic,
      });
    }
  }

  // ─── Import graph (reverse edges: who imports currentFile?) ───────────
  const inEdges = ctx.importGraph.importsIn.get(ctx.currentFile) ?? [];
  for (const edge of inEdges) {
    const importingFile = edge.from;
    if (ctx.visited.has(importingFile)) continue;

    const importingProfile = ctx.profiles.get(importingFile);
    // Don't skip files without profiles — still traverse through them

    // Check if importing file has transforms that handle the imported symbols
    let transformFound = false;
    if (importingProfile && edge.symbols) {
      for (const sym of edge.symbols) {
        for (const transform of importingProfile.transforms) {
          if (transform.inputParam === sym || transform.name === sym) {
            transformFound = true;
            break;
          }
        }
        if (transformFound) break;
      }
    }

    const newHops: TraversalHop[] = [...ctx.currentHops, {
      file: ctx.currentFile,
      name: edge.symbols?.[0] ?? 'default',
      line: 1,
      mechanism: transformFound ? 'transform' : 'import',
    }];

    // Check sinks in importing file (only if profiled)
    const importingSinks = importingProfile?.sinks ?? [];
    for (const sink of importingSinks) {
      ctx.candidates.push({
        sourceFile: ctx.originFile,
        sourceName: ctx.source.name,
        sourceLine: ctx.source.line,
        sourceType: ctx.source.type,
        hops: newHops,
        sinkFile: importingFile,
        sinkName: sink.name,
        sinkLine: sink.line,
        sinkType: sink.type,
        hasTransform: ctx.hasTransform || transformFound,
        hasDynamicChannel: ctx.hasDynamicChannel,
      });
    }

    // Continue forward traversal
    const newVisited = new Set(ctx.visited);
    newVisited.add(importingFile);
    traceForward({
      ...ctx,
      currentFile: importingFile,
      visited: newVisited,
      currentHops: newHops,
      hasTransform: ctx.hasTransform || transformFound,
    });
  }
}
