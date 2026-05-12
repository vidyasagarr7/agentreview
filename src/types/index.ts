// ─── Core Data Shapes ────────────────────────────────────────────────────────

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PRData {
  title: string;
  body: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  labels: string[];
  diff: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  number: number;
  repoOwner: string;
  repoName: string;
  isDraft: boolean;
  state: 'open' | 'closed' | 'merged';
}

export interface ReviewContext {
  pr: PRData;
  diff: string;
  fileList: string;
  truncated: boolean;
  truncationNote?: string;
  estimatedTokens: number;
  /** Files skipped because they are binary or have no patch (e.g. binary blobs). */
  skippedFiles?: string[];
  codebase?: CodebaseContext;
}

// ─── Lens Types ───────────────────────────────────────────────────────────────

export type LensSeverity = 'strict' | 'normal' | 'advisory';

export interface Lens {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  focusAreas: string[];
  severity?: LensSeverity;
}

// ─── Finding Types ────────────────────────────────────────────────────────────

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type FindingDisposition = 'unvalidated' | 'confirmed' | 'uncertain' | 'disproven';

export const SEVERITY_ORDER: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export interface AgentFinding {
  id: string;
  severity: FindingSeverity;
  category: string;
  location: string;
  summary: string;
  detail: string;
  suggestion: string;
  lenses: string[];
  confidenceScore?: number | undefined;
  disposition?: FindingDisposition;
}

export interface ParseError {
  type: 'ParseError';
  lensId: string;
  raw: string;
  message: string;
}

export type AgentResultFindings = AgentFinding[] | ParseError;

export interface AgentResult {
  lensId: string;
  findings: AgentResultFindings;
  error?: string;
  durationMs: number;
}

// ─── Report Types ─────────────────────────────────────────────────────────────

export type ReportFormat = 'markdown' | 'json';
export type ReviewConfidence = 'NORMAL' | 'LOW';

export interface FindingStats {
  total: number;
  bySeverity: Record<FindingSeverity, number>;
  byLens: Record<string, number>;
  cleanLenses: string[];
  erroredLenses: string[];
  parseErrorLenses: string[];
}

export interface ValidationStats {
  confirmed: number;
  uncertain: number;
  disproven: number;
  unvalidated: number;
  filtered: number;
}

export interface ConsolidatedReport {
  pr: {
    title: string;
    number: number;
    author: string;
    repoOwner: string;
    repoName: string;
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  reviewedAt: string;
  lensesRun: string[];
  findings: AgentFinding[];
  parseErrors: ParseError[];
  stats: FindingStats;
  validationStats?: ValidationStats;
  confidence: ReviewConfidence;
  /** Files skipped during review (binary or no patch available). */
  skippedFiles: string[];
}

// ─── Codebase Context Types ─────────────────────────────────────────────────

export interface RepoFileEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

export interface RepoTree {
  sha: string;
  entries: RepoFileEntry[];
  truncated: boolean;
}

export interface ImportEdge {
  from: string;
  to: string;
  symbols?: string[];
  external: boolean;
}

export interface CodebaseContextDiagnostic {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CodebaseContext {
  baseSha: string;
  tree?: RepoTree;
  importsOut: ImportEdge[];
  rendered: string;
  estimatedTokens: number;
  truncated: boolean;
  diagnostics: CodebaseContextDiagnostic[];
  parserUsed: 'regex';
  languagesCovered: string[];
  filesAnalyzed: number;
  filesFailed: number;
}

// ─── Ensemble Types ─────────────────────────────────────────────────────────────

export interface ModelConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey: string;
  label: string;  // e.g. 'claude-sonnet', 'gpt-4o' — used in source tracking
}

export interface EnsembleConfig {
  models: ModelConfig[];
  strategy: 'unanimous' | 'majority' | 'any';  // agreement strategy
  timeout: number;
  contextTokens: number;
}

export interface ModelFinding extends AgentFinding {
  modelSource: string;   // label of the model that found it
  modelSources: string[];  // all models that found this (after merge)
  agreementCount: number;  // how many models found similar issue
}

export interface EnsembleResult {
  modelResults: Array<{
    label: string;
    model: string;
    findings: AgentFinding[];
    error?: string;
    durationMs: number;
  }>;
  mergedFindings: ModelFinding[];
  stats: {
    modelsRun: number;
    modelsSucceeded: number;
    totalRawFindings: number;
    mergedFindings: number;
    unanimousFindings: number;   // found by all models
    majorityFindings: number;    // found by >50% of models
    singleSourceFindings: number; // found by only one model
  };
}

// ─── Fix Types ────────────────────────────────────────────────────────────────

export type FixStatus = 'pending' | 'applied' | 'verified' | 'reverted' | 'failed';

export interface FixAttempt {
  findingId: string;
  finding: AgentFinding;
  patch: string;
  explanation: string;
  status: FixStatus;
  verificationResult?: string;
}

export interface VerificationResult {
  findingId: string;
  passed: boolean;
  issues: string[];
}

export interface FixReport {
  pr: {
    title: string;
    number: number;
    repoOwner: string;
    repoName: string;
  };
  eligible: number;
  generated: number;
  verified: number;
  reverted: number;
  failed: number;
  fixes: FixAttempt[];
}

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface LLMConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey: string;
  timeout: number;
  contextTokens: number;
}

export interface CLIOptions {
  lens: string;
  format: ReportFormat;
  output?: string;
  post: boolean;
  failOn?: FindingSeverity;
  timeout: number;
  model?: string;
  noDedup: boolean;
  validate: boolean;
  minConfidence: number;
  verbose: boolean;
  yes: boolean;
}
