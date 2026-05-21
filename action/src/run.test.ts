import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionInputs } from './inputs.js';
import type { PRContext } from './context.js';
import type {
  PRData,
  AgentResult,
  AgentFinding,
  ConsolidatedReport,
  ReviewContext,
  CodebaseContext,
} from '../../src/types/index.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
}));

const mockGetPR = vi.fn();
const mockGetBaseSha = vi.fn();

vi.mock('../../src/github/client.js', () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    getPR: mockGetPR,
    getBaseSha: mockGetBaseSha,
    getRepoTree: vi.fn(),
    getFileContent: vi.fn(),
  })),
}));

const mockBuildReviewContext = vi.fn();
vi.mock('../../src/github/context-builder.js', () => ({
  buildReviewContext: (...args: unknown[]) => mockBuildReviewContext(...args),
}));

const mockBuildCodebaseContext = vi.fn();
vi.mock('../../src/codebase/orchestrator.js', () => ({
  buildCodebaseContext: (...args: unknown[]) => mockBuildCodebaseContext(...args),
}));

const mockLoadCustomLenses = vi.fn();
const mockResolveLenses = vi.fn();
vi.mock('../../src/lenses/registry.js', () => ({
  LensRegistry: vi.fn().mockImplementation(() => ({
    loadCustomLenses: mockLoadCustomLenses,
    resolveLenses: mockResolveLenses,
  })),
}));

vi.mock('../../src/llm/client.js', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    complete: vi.fn().mockResolvedValue('{}'),
  })),
}));

const mockDispatchAgents = vi.fn();
vi.mock('../../src/agents/dispatcher.js', () => ({
  dispatchAgents: (...args: unknown[]) => mockDispatchAgents(...args),
}));

const mockValidateAgentResults = vi.fn();
vi.mock('../../src/validation/validator.js', () => ({
  validateAgentResults: (...args: unknown[]) => mockValidateAgentResults(...args),
}));

const mockConsolidate = vi.fn();
vi.mock('../../src/report/consolidator.js', () => ({
  consolidate: (...args: unknown[]) => mockConsolidate(...args),
}));

const mockRender = vi.fn();
vi.mock('../../src/report/renderer.js', () => ({
  render: (...args: unknown[]) => mockRender(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePR(overrides: Partial<PRData> = {}): PRData {
  return {
    title: 'Test PR',
    body: 'Test body',
    author: 'testuser',
    baseBranch: 'main',
    headBranch: 'feat/test',
    labels: [],
    diff: 'diff --git a/foo.ts b/foo.ts\n+line',
    files: [
      {
        filename: 'foo.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ],
    additions: 1,
    deletions: 0,
    number: 42,
    repoOwner: 'owner',
    repoName: 'repo',
    isDraft: false,
    state: 'open',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    id: 'f1',
    severity: 'MEDIUM',
    category: 'test',
    location: 'foo.ts:1',
    summary: 'Test finding',
    detail: 'Detail',
    suggestion: 'Fix it',
    lenses: ['security'],
    ...overrides,
  };
}

function makeReviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    pr: makePR(),
    diff: 'diff',
    fileList: '- foo.ts',
    truncated: false,
    estimatedTokens: 100,
    skippedFiles: [],
    ...overrides,
  };
}

function makeConsolidatedReport(
  findings: AgentFinding[] = [],
  overrides: Partial<ConsolidatedReport> = {},
): ConsolidatedReport {
  return {
    pr: {
      title: 'Test PR',
      number: 42,
      author: 'testuser',
      repoOwner: 'owner',
      repoName: 'repo',
      filesChanged: 1,
      additions: 1,
      deletions: 0,
    },
    reviewedAt: new Date().toISOString(),
    lensesRun: ['security'],
    findings,
    parseErrors: [],
    stats: {
      total: findings.length,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      byLens: {},
      cleanLenses: [],
      erroredLenses: [],
      parseErrorLenses: [],
    },
    validationStats: {
      confirmed: 0,
      uncertain: 0,
      disproven: 0,
      unvalidated: findings.length,
      filtered: 0,
    },
    confidence: 'NORMAL',
    skippedFiles: [],
    ...overrides,
  };
}

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    llmConfig: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
      timeout: 120,
      contextTokens: 200000,
    },
    lenses: 'all',
    validate: false,
    minConfidence: 40,
    codebaseContext: false,
    codebaseBudget: 8000,
    verbose: false,
    githubToken: 'ghp_test',
    commentMode: 'full' as const,
    ...overrides,
  };
}

function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    owner: 'owner',
    repo: 'repo',
    prNumber: 42,
    token: 'ghp_test',
    ...overrides,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let runReview: typeof import('./run.js').runReview;

beforeEach(async () => {
  vi.clearAllMocks();

  const pr = makePR();
  const context = makeReviewContext();
  const results: AgentResult[] = [
    { lensId: 'security', findings: [], durationMs: 1000 },
  ];
  const report = makeConsolidatedReport();

  mockGetPR.mockResolvedValue(pr);
  mockBuildReviewContext.mockReturnValue(context);
  mockBuildCodebaseContext.mockResolvedValue(undefined);
  mockResolveLenses.mockReturnValue([
    { id: 'security', name: 'Security', description: 'Security lens', systemPrompt: 'Review for security', focusAreas: ['auth'] },
  ]);
  mockLoadCustomLenses.mockResolvedValue([]);
  mockDispatchAgents.mockResolvedValue(results);
  mockValidateAgentResults.mockResolvedValue(results);
  mockConsolidate.mockReturnValue(report);
  mockRender.mockReturnValue('# Review Report\n\nAll clean!');

  // Dynamic import to pick up mocks
  const mod = await import('./run.js');
  runReview = mod.runReview;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runReview', () => {
  it('returns ActionReviewResult with expected shape', async () => {
    const result = await runReview(makeInputs(), makePRContext());

    expect(result).toHaveProperty('report');
    expect(result).toHaveProperty('findings');
    expect(result).toHaveProperty('stats');
    expect(result).toHaveProperty('shouldFail');
    expect(result).toHaveProperty('confidence');

    expect(typeof result.report).toBe('string');
    expect(Array.isArray(result.findings)).toBe(true);
    expect(typeof result.stats.total).toBe('number');
    expect(typeof result.shouldFail).toBe('boolean');
    expect(['NORMAL', 'LOW']).toContain(result.confidence);
  });

  it('calls pipeline steps in correct order', async () => {
    await runReview(makeInputs(), makePRContext());

    expect(mockGetPR).toHaveBeenCalledWith('owner', 'repo', 42);
    expect(mockBuildReviewContext).toHaveBeenCalled();
    expect(mockResolveLenses).toHaveBeenCalledWith('all');
    expect(mockDispatchAgents).toHaveBeenCalled();
    expect(mockConsolidate).toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalledWith(expect.anything(), 'markdown');
  });

  it('filters lenses when specific IDs provided', async () => {
    const inputs = makeInputs({ lenses: ['security'] });
    await runReview(inputs, makePRContext());

    expect(mockResolveLenses).toHaveBeenCalledWith(['security']);
  });

  it('skips codebase context when disabled', async () => {
    const inputs = makeInputs({ codebaseContext: false });
    await runReview(inputs, makePRContext());

    expect(mockBuildCodebaseContext).not.toHaveBeenCalled();
  });

  it('builds codebase context when enabled', async () => {
    const codebase: CodebaseContext = {
      baseSha: 'abc123',
      importsOut: [],
      rendered: 'codebase context',
      estimatedTokens: 500,
      truncated: false,
      diagnostics: [],
      parserUsed: 'regex',
      languagesCovered: ['ts'],
      filesAnalyzed: 5,
      filesFailed: 0,
    };
    mockBuildCodebaseContext.mockResolvedValue(codebase);

    const inputs = makeInputs({ codebaseContext: true, codebaseBudget: 8000 });
    await runReview(inputs, makePRContext());

    expect(mockBuildCodebaseContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { enabled: true, budgetTokens: 8000 },
    );
  });

  it('skips validation when disabled', async () => {
    const inputs = makeInputs({ validate: false });
    await runReview(inputs, makePRContext());

    expect(mockValidateAgentResults).not.toHaveBeenCalled();
  });

  it('runs validation when enabled', async () => {
    const inputs = makeInputs({ validate: true, minConfidence: 50 });
    await runReview(inputs, makePRContext());

    expect(mockValidateAgentResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { minConfidence: 50 },
    );
  });

  it('shouldFail is true when findings exceed fail-on threshold', async () => {
    const findings = [makeFinding({ severity: 'HIGH' })];
    const report = makeConsolidatedReport(findings);
    report.stats.total = 1;
    report.stats.bySeverity.HIGH = 1;
    mockConsolidate.mockReturnValue(report);

    const inputs = makeInputs({ failOn: 'HIGH' });
    const result = await runReview(inputs, makePRContext());

    expect(result.shouldFail).toBe(true);
  });

  it('shouldFail is true when findings severity is higher than threshold', async () => {
    const findings = [makeFinding({ severity: 'CRITICAL' })];
    const report = makeConsolidatedReport(findings);
    report.stats.total = 1;
    report.stats.bySeverity.CRITICAL = 1;
    mockConsolidate.mockReturnValue(report);

    // fail-on is MEDIUM, but we have CRITICAL — should still fail
    const inputs = makeInputs({ failOn: 'MEDIUM' });
    const result = await runReview(inputs, makePRContext());

    expect(result.shouldFail).toBe(true);
  });

  it('shouldFail is false when findings are below threshold', async () => {
    const findings = [makeFinding({ severity: 'LOW' })];
    const report = makeConsolidatedReport(findings);
    report.stats.total = 1;
    report.stats.bySeverity.LOW = 1;
    mockConsolidate.mockReturnValue(report);

    const inputs = makeInputs({ failOn: 'HIGH' });
    const result = await runReview(inputs, makePRContext());

    expect(result.shouldFail).toBe(false);
  });

  it('shouldFail is false when no fail-on set', async () => {
    const findings = [makeFinding({ severity: 'CRITICAL' })];
    const report = makeConsolidatedReport(findings);
    mockConsolidate.mockReturnValue(report);

    const inputs = makeInputs({ failOn: undefined });
    const result = await runReview(inputs, makePRContext());

    expect(result.shouldFail).toBe(false);
  });

  it('error in one lens does not kill review', async () => {
    const results: AgentResult[] = [
      { lensId: 'security', findings: [], error: 'LLM timeout', durationMs: 60000 },
      { lensId: 'quality', findings: [makeFinding({ lenses: ['quality'] })], durationMs: 5000 },
    ];
    mockDispatchAgents.mockResolvedValue(results);

    const report = makeConsolidatedReport([makeFinding({ lenses: ['quality'] })], {
      confidence: 'LOW',
      lensesRun: ['security', 'quality'],
    });
    report.stats.erroredLenses = ['security'];
    mockConsolidate.mockReturnValue(report);

    const result = await runReview(makeInputs(), makePRContext());

    // Review completes despite the security lens error
    expect(result.confidence).toBe('LOW');
    expect(result.findings).toHaveLength(1);
    expect(result.report).toBeDefined();
  });

  it('loads custom lenses when customLensesDir is set', async () => {
    const inputs = makeInputs({ customLensesDir: '/path/to/lenses' });
    await runReview(inputs, makePRContext());

    expect(mockLoadCustomLenses).toHaveBeenCalledWith('/path/to/lenses');
  });

  it('does not load custom lenses when customLensesDir is unset', async () => {
    const inputs = makeInputs({ customLensesDir: undefined });
    await runReview(inputs, makePRContext());

    expect(mockLoadCustomLenses).not.toHaveBeenCalled();
  });
});
