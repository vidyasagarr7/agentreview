// ─── index.ts — Cross-file PHI flow analysis orchestrator ────────────────────

import type { AgentFinding, CodebaseContextDiagnostic, ImportEdge } from '../../types/index.js';
import type {
  FlowAnalysisInput,
  FlowAnalysisOptions,
  FlowAnalysisResult,
  FileContentMap,
  FilePhiProfile,
  LLMClient,
  VerifiedPath,
  FlowProgressCallback,
} from './types.js';
import { DEFAULT_FLOW_OPTIONS } from './types.js';
import type { FullImportGraph } from './types.js';
import { buildFullImportGraph, extendPrGraph, buildRepoTreeFromReader, readerToFetcher } from './import-graph-full.js';
import type { FileFetcher } from './import-graph-full.js';
import { profileFiles } from './profiler.js';
import { detectRuntimeFlows } from './runtime-detector.js';
import { buildPhiFlowGraph } from './graph.js';
import { verifyPaths } from './verifier.js';
import { SafePatternMatcher } from './safe-patterns.js';
import type { BaaRegistry } from '../baa-registry.js';
import type { SourceReader } from '../../scan/types.js';
import type { RepoTree } from '../../types/index.js';
import type { HipaaConfig } from '../../config/repo-config.js';

// ─── Options Builder ──────────────────────────────────────────────────────────

/**
 * Build FlowAnalysisOptions from HipaaConfig, applying defaults.
 */
export function buildFlowOptions(hipaaConfig?: HipaaConfig): FlowAnalysisOptions {
  return {
    ...DEFAULT_FLOW_OPTIONS,
    ...(hipaaConfig?.flowMaxDepth !== undefined && { maxDepth: hipaaConfig.flowMaxDepth }),
    ...(hipaaConfig?.flowMaxPaths !== undefined && { maxPaths: hipaaConfig.flowMaxPaths }),
    ...(hipaaConfig?.flowMaxFiles !== undefined && { maxFiles: hipaaConfig.flowMaxFiles }),
    ...(hipaaConfig?.flowPrHopDepth !== undefined && { prHopDepth: hipaaConfig.flowPrHopDepth }),
    ...(hipaaConfig?.flowSafePatterns && { safePatterns: hipaaConfig.flowSafePatterns }),
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Run cross-file PHI data flow analysis.
 *
 * Orchestrates:
 * 1. Build shared file content map (read once — Claude challenge #5)
 * 2. Build or extend import graph
 * 3. Pass 1: profile each file (parallel LLM)
 * 4. Runtime flow detection (deterministic)
 * 5. Merge runtime flows into profiles
 * 6. Pass 2: build flow graph (deterministic)
 * 7. Apply safe patterns
 * 8. Pass 3: verify leaks (targeted LLM + BAA)
 */
export async function analyzePhiFlow(input: FlowAnalysisInput): Promise<FlowAnalysisResult> {
  const startTime = Date.now();
  const diagnostics: CodebaseContextDiagnostic[] = [];
  const { options, files, llm, baaRegistry } = input;
  const onProgress = options.onProgress;

  // 1. Build shared file content map (Claude challenge #5: read files once)
  const fileContents: FileContentMap = new Map();
  for (const f of files) {
    fileContents.set(f.path, f.content);
  }

  // Warn if file count exceeds max (Gemini challenge #3)
  if (files.length > options.maxFiles) {
    diagnostics.push({
      level: 'warn',
      message: `Flow analysis: ${files.length} files exceed max of ${options.maxFiles}. Only the top ${options.maxFiles} will be profiled.`,
    });
  }

  // 2. Build or extend import graph
  let importGraph: FullImportGraph;

  if (options.mode === 'pr' && input.importGraph && input.tree && input.fetcher) {
    // PR mode: extend existing graph with N-hop neighbors
    importGraph = await extendPrGraph(
      input.importGraph,
      files.map((f) => f.path),
      input.tree,
      input.fetcher,
      options.prHopDepth,
    );
  } else if (input.tree && input.fetcher) {
    // Scan mode with tree: build full graph
    importGraph = await buildFullImportGraph(
      files.map((f) => f.path),
      input.tree,
      input.fetcher,
    );
  } else {
    // Scan mode without tree: build from file content map
    // Create a simple fetcher from our file content map
    const mapFetcher: FileFetcher = {
      fetchFile: async (path: string) => fileContents.get(path) ?? null,
    };
    const tree: RepoTree = {
      sha: 'local',
      truncated: false,
      entries: files.map((f) => ({ path: f.path, type: 'blob' as const })),
    };
    importGraph = await buildFullImportGraph(
      files.map((f) => f.path),
      tree,
      mapFetcher,
    );
  }

  diagnostics.push(...importGraph.diagnostics);

  // 3. Pass 1: Profile each file (parallel LLM)
  const profiles = await profileFiles(
    files,
    llm,
    {
      concurrency: 5,
      maxFiles: options.maxFiles,
      onProgress,
    },
  );

  // 4. Runtime flow detection (deterministic, no LLM)
  for (const [filePath, content] of fileContents) {
    const runtimeFlows = detectRuntimeFlows(filePath, content);
    if (runtimeFlows.length > 0) {
      const existing = profiles.get(filePath);
      if (existing) {
        // 5. Merge runtime flows into profiles
        existing.runtimeFlows = [...existing.runtimeFlows, ...runtimeFlows];
      } else {
        // Create a minimal profile for files with runtime flows but no LLM profile
        profiles.set(filePath, {
          sources: [],
          sinks: [],
          transforms: [],
          exports: [],
          imports: [],
          runtimeFlows,
        });
      }
    }
  }

  // 6. Pass 2: Build flow graph (deterministic)
  onProgress?.('graph', 0, 1, 'Building flow graph from profiles + import graph');
  const candidatePaths = buildPhiFlowGraph(profiles, importGraph, options);
  onProgress?.('graph', 1, 1, `Found ${candidatePaths.length} candidate paths`);

  // 7. Apply safe patterns
  const matcher = new SafePatternMatcher(options.safePatterns);
  const filteredPaths = matcher.applySafePatterns(candidatePaths);

  // 8. Pass 3: Verify leaks (targeted LLM + BAA)
  const verifiedPaths = await verifyPaths(
    filteredPaths,
    fileContents,
    llm,
    baaRegistry,
    {
      concurrency: 3,
      callTimeoutMs: options.callTimeoutMs,
      failureAbortThreshold: options.failureAbortThreshold,
      onProgress,
    },
  );

  // Count total edges in import graph
  let totalEdges = 0;
  for (const edges of importGraph.importsOut.values()) {
    totalEdges += edges.length;
  }

  return {
    paths: verifiedPaths,
    profiles,
    graphStats: {
      filesAnalyzed: importGraph.filesAnalyzed,
      filesFailed: importGraph.filesFailed,
      totalEdges,
      candidatePaths: candidatePaths.length,
      verifiedLeaks: verifiedPaths.length,
    },
    diagnostics,
    durationMs: Date.now() - startTime,
  };
}

// ─── Finding Conversion ───────────────────────────────────────────────────────

/**
 * Convert verified PHI flow paths into AgentFinding format for integration
 * with the existing scan pipeline.
 */
export function flowPathsToFindings(paths: VerifiedPath[]): AgentFinding[] {
  return paths.map((path, index) => {
    const intermediateSteps = path.intermediates
      .map((i) => `${i.file}:${i.line} (${i.mechanism})`)
      .join(' → ');

    const flowChain = intermediateSteps
      ? `${path.source.file}:${path.source.line} → ${intermediateSteps} → ${path.sink.file}:${path.sink.line}`
      : `${path.source.file}:${path.source.line} → ${path.sink.file}:${path.sink.line}`;

    const baaNote = path.baaRelevant
      ? `\n\nBAA Status: ${path.baaStatus ?? 'unknown'} — ${
          path.baaStatus === 'no-baa'
            ? '⚠️ External sink has NO Business Associate Agreement'
            : path.baaStatus === 'covered'
            ? '✅ Covered by BAA'
            : '❓ BAA status unknown — verify with compliance team'
        }`
      : '';

    return {
      id: `phi-flow-${index + 1}`,
      severity: path.severity,
      category: 'HIPAA / PHI Data Flow',
      location: `${path.source.file}:${path.source.line} → ${path.sink.file}:${path.sink.line}`,
      summary: `PHI from ${path.source.type} (${path.source.name}) flows to ${path.sink.type} (${path.sink.name})`,
      detail: `Cross-file PHI flow detected:\n\nFlow chain: ${flowChain}\n\nSource: ${path.source.type} at ${path.source.file}:${path.source.line} (${path.source.name})\nSink: ${path.sink.type} at ${path.sink.file}:${path.sink.line} (${path.sink.name})\nConfidence: ${path.confidence}\n\n${path.explanation}${baaNote}`,
      suggestion: generateSuggestion(path),
      lenses: ['hipaa'],
      confidenceScore: path.confidence === 'high' ? 0.9 : path.confidence === 'medium' ? 0.7 : 0.5,
      scannerId: 'phi-flow-analysis',
      regulation: 'HIPAA §164.502(a)',
    };
  });
}

function generateSuggestion(path: VerifiedPath): string {
  const suggestions: string[] = [];

  if (path.sink.type === 'log' || path.sink.type === 'error-tracking' || path.sink.type === 'apm') {
    suggestions.push(`Sanitize or redact PHI before logging/monitoring at ${path.sink.file}:${path.sink.line}`);
    suggestions.push('Consider using a PHI-aware logger that automatically redacts sensitive fields');
  } else if (path.sink.type === 'external-api' || path.sink.type === 'webhook') {
    if (path.baaStatus === 'no-baa') {
      suggestions.push(`CRITICAL: External service at ${path.sink.file}:${path.sink.line} has no BAA — PHI transmission is a HIPAA violation`);
      suggestions.push('Either obtain a BAA from the vendor, or strip all PHI before sending');
    } else {
      suggestions.push(`Verify BAA status for the external service at ${path.sink.file}:${path.sink.line}`);
    }
  } else if (path.sink.type === 'analytics') {
    suggestions.push(`Strip PHI before sending to analytics at ${path.sink.file}:${path.sink.line}`);
    suggestions.push('Use anonymous/aggregate data for analytics — never send individual PHI');
  } else if (path.sink.type === 'cache' || path.sink.type === 'search-index') {
    suggestions.push(`Ensure ${path.sink.type} at ${path.sink.file}:${path.sink.line} has appropriate access controls and encryption`);
  } else {
    suggestions.push(`Review PHI handling at ${path.sink.file}:${path.sink.line} — ensure data is sanitized or the sink is HIPAA-compliant`);
  }

  return suggestions.join('\n');
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { buildRepoTreeFromReader, readerToFetcher } from './import-graph-full.js';
export type { FlowAnalysisResult, FlowAnalysisOptions, FlowAnalysisInput } from './types.js';
