// ─── types.ts — Cross-file PHI data flow analysis types ──────────────────────

import type { FindingSeverity, CodebaseContextDiagnostic, ImportEdge, RepoTree } from '../../types/index.js';
import type { BaaRegistry } from '../baa-registry.js';
import type { FileFetcher } from './import-graph-full.js';

// ─── PHI Source Types ─────────────────────────────────────────────────────────

export type PhiSourceType =
  // Database
  | 'db-query'
  | 'db-stored-proc'
  // FHIR (granular)
  | 'fhir-read'
  | 'fhir-search'
  | 'fhir-bulk'
  // CDA / HL7
  | 'cda'
  | 'hl7-v2'
  // CDS Hooks
  | 'cds-hook'
  // SMART on FHIR
  | 'smart-launch'
  // Other
  | 'api-response'
  | 'function-param'
  | 'file-read'
  | 'env-config';

export const PHI_SOURCE_TYPES = [
  'db-query', 'db-stored-proc',
  'fhir-read', 'fhir-search', 'fhir-bulk',
  'cda', 'hl7-v2', 'cds-hook', 'smart-launch',
  'api-response', 'function-param', 'file-read', 'env-config',
] as const;

// ─── PHI Sink Types ───────────────────────────────────────────────────────────

export type PhiSinkType =
  // Logging & monitoring
  | 'log'
  | 'error-tracking'
  | 'apm'
  // HTTP/API
  | 'response'
  | 'external-api'
  | 'webhook'
  // Storage
  | 'cache'
  | 'storage'
  | 'search-index'
  | 'analytics'
  // Messaging
  | 'queue'
  | 'notification'
  // Document generation
  | 'document-gen'
  | 'template-render';

export const PHI_SINK_TYPES = [
  'log', 'error-tracking', 'apm',
  'response', 'external-api', 'webhook',
  'cache', 'storage', 'search-index', 'analytics',
  'queue', 'notification',
  'document-gen', 'template-render',
] as const;

// ─── Transform Mechanism ──────────────────────────────────────────────────────

export type TransformMechanism =
  | 'direct'
  | 'event-emit'
  | 'middleware-next'
  | 'queue-publish'
  | 'callback'
  | 'fhir-bundle-unwrap';

// ─── Runtime Flow Types ───────────────────────────────────────────────────────

export type RuntimeFlowType =
  | 'event-emit'
  | 'event-listen'
  | 'middleware-chain'
  | 'queue-publish'
  | 'queue-subscribe';

export interface RuntimeFlowDescriptor {
  type: RuntimeFlowType;
  channel: string;
  functionName: string;
  line: number;
  dataParam?: string;
}

// ─── Per-File PHI Profile ─────────────────────────────────────────────────────

export interface PhiSource {
  name: string;
  line: number;
  type: PhiSourceType;
}

export interface PhiSink {
  name: string;
  line: number;
  type: PhiSinkType;
}

export interface PhiTransform {
  name: string;
  line: number;
  inputParam: string;
  outputReturn: boolean;
  mechanism: TransformMechanism;
}

export interface PhiExport {
  name: string;
  containsPhi: boolean;
}

export interface FilePhiProfile {
  sources: PhiSource[];
  sinks: PhiSink[];
  transforms: PhiTransform[];
  exports: PhiExport[];
  imports: Array<{ from: string; names: string[] }>;
  runtimeFlows: RuntimeFlowDescriptor[];
}

// ─── Flow Graph Types ─────────────────────────────────────────────────────────

export type FlowEdgeType = 'import' | 'event' | 'middleware' | 'queue' | 'callback';

export interface PhiFlowEdge {
  from: { file: string; export: string; line: number };
  to: { file: string; import: string; line: number };
  type: FlowEdgeType;
}

export interface PhiFlowPath {
  source: { file: string; name: string; line: number; type: PhiSourceType };
  intermediates: Array<{ file: string; name: string; line: number; mechanism: string }>;
  sink: { file: string; name: string; line: number; type: PhiSinkType };
  confidence: 'high' | 'medium' | 'low';
  severity: FindingSeverity;
}

export interface VerifiedPath extends PhiFlowPath {
  isLeak: boolean;
  explanation: string;
  baaRelevant: boolean;
  baaStatus?: 'covered' | 'no-baa' | 'unknown';
  /** Verifier's own confidence assessment (may override heuristic) */
  verifierConfidence?: 'high' | 'medium' | 'low';
}

// ─── Full Import Graph (Bidirectional) ────────────────────────────────────────

export interface FullImportGraph {
  importsOut: Map<string, ImportEdge[]>;
  importsIn: Map<string, ImportEdge[]>;
  filesAnalyzed: number;
  filesFailed: number;
  diagnostics: CodebaseContextDiagnostic[];
}

// ─── Flow Analysis Options ────────────────────────────────────────────────────

export type FlowAnalysisMode = 'scan' | 'pr';

export interface FlowSafePatternConfig {
  pattern: string;
  type: 'sanitizer' | 'projection' | 'expected-sink' | 'compliant-sink';
}

export interface FlowAnalysisOptions {
  mode: FlowAnalysisMode;
  maxDepth: number;
  maxPaths: number;
  maxFiles: number;
  safePatterns: FlowSafePatternConfig[];
  /** Number of import hops to extend PR graph (default: 2) */
  prHopDepth: number;
  /** Per-LLM-call timeout in ms (default: 30000) */
  callTimeoutMs: number;
  /** Abort analysis if more than this fraction of LLM calls fail (default: 0.3) */
  failureAbortThreshold: number;
  /** Progress callback for long-running operations */
  onProgress?: FlowProgressCallback;
}

export type FlowProgressCallback = (
  phase: 'profiling' | 'graph' | 'verifying',
  current: number,
  total: number,
  detail?: string,
) => void;

// ─── Flow Analysis Result ─────────────────────────────────────────────────────

export interface FlowAnalysisResult {
  paths: VerifiedPath[];
  profiles: Map<string, FilePhiProfile>;
  graphStats: {
    filesAnalyzed: number;
    filesFailed: number;
    totalEdges: number;
    candidatePaths: number;
    verifiedLeaks: number;
  };
  diagnostics: CodebaseContextDiagnostic[];
  durationMs: number;
}

// ─── Flow Analysis Input ──────────────────────────────────────────────────────

export interface FlowAnalysisInput {
  options: FlowAnalysisOptions;
  files: Array<{ path: string; content: string }>;
  llm: LLMClient;
  importGraph?: ImportEdge[];
  tree?: RepoTree;
  fetcher?: FileFetcher;
  baaRegistry?: BaaRegistry;
}

// ─── LLM Client Interface ─────────────────────────────────────────────────────
// Minimal interface for LLM calls used by profiler and verifier.

export interface LLMClient {
  chat(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string>;
}

// ─── Shared File Content Map ──────────────────────────────────────────────────
// Files are read once and shared across all passes (Claude challenge #5).

export type FileContentMap = Map<string, string>;

// ─── Default Options ──────────────────────────────────────────────────────────

export const DEFAULT_FLOW_OPTIONS: FlowAnalysisOptions = {
  mode: 'scan',
  maxDepth: 5,
  maxPaths: 20,
  maxFiles: 200,  // Gemini challenge #3: default 200 for healthcare monorepos
  safePatterns: [],
  prHopDepth: 2,  // Claude challenge #7: 2-hop instead of 1-hop
  callTimeoutMs: 30_000,  // Claude challenge #4
  failureAbortThreshold: 0.3,  // Claude challenge #4
};
