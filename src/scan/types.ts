import type { AgentFinding, FindingSeverity } from '../types/index.js';

// ─── Security Domains ─────────────────────────────────────────────────────────

export type SecurityDomain =
  | 'auth'
  | 'secrets'
  | 'injection'
  | 'config'
  | 'deps'
  | 'crypto'
  | 'data-flow'
  | 'general';

// ─── File & Chunk Types ───────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  size: number;
  priority: number;
}

export interface ChunkFile {
  path: string;
  content: string;
  priority: number;
  estimatedTokens: number;
}

export interface ScanChunk {
  id: string;
  domain: SecurityDomain;
  files: ChunkFile[];
  estimatedTokens: number;
  focusPrompt: string;
}

export interface ClassifiedFile {
  path: string;
  size: number;
  priority: number;
  domain: SecurityDomain;
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ScanOptions {
  focus?: SecurityDomain[];
  maxConcurrency: number;
  budgetTokens: number;
  maxFiles?: number;
  model?: string;
  timeout: number;
  validate: boolean;
  verbose: boolean;
  redact: boolean;
  onProgress?: ScanProgressCallback;
}

// ─── Results ──────────────────────────────────────────────────────────────────

export interface ChunkResult {
  chunkId: string;
  domain: SecurityDomain;
  findings: AgentFinding[];
  error?: string;
  durationMs: number;
}

export interface CoverageEntry {
  domain: SecurityDomain;
  filesScanned: number;
  findings: number;
}

export interface ScanStats {
  total: number;
  bySeverity: Record<FindingSeverity, number>;
  byDomain: Record<string, number>;
  cleanDomains: string[];
  erroredChunks: string[];
}

export interface ScanResult {
  target: string;
  branch: string;
  scannedAt: string;
  filesDiscovered: number;
  filesScanned: number;
  filesSkipped: number;
  chunks: ChunkResult[];
  findings: AgentFinding[];
  stats: ScanStats;
  coverage: CoverageEntry[];
}

// ─── Callbacks & Interfaces ───────────────────────────────────────────────────

export type ScanProgressCallback = (
  chunkId: string,
  status: 'started' | 'completed' | 'failed',
  meta?: {
    domain: SecurityDomain;
    fileCount: number;
    durationMs?: number;
    findingCount?: number;
  },
) => void;

export interface SourceReader {
  listFiles(): Promise<FileEntry[]>;
  readFile(path: string): Promise<string | null>;
  cleanup?(): Promise<void>;
}
