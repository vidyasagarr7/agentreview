import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTraceCommand } from './trace.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { parseTrace, distillTrace, analyzeTrace } from '../../trace/index.js';
import { redactSecrets } from '../../scan/redact.js';
import type { TraceSession, ProcessFinding } from '../../trace/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../../trace/index.js', () => ({
  parseTrace: vi.fn(),
  distillTrace: vi.fn(),
  analyzeTrace: vi.fn(),
}));

vi.mock('../../scan/redact.js', () => ({
  redactSecrets: vi.fn(),
}));

const mockReadFile = vi.mocked(readFile);
const mockExistsSync = vi.mocked(existsSync);
const mockParseTrace = vi.mocked(parseTrace);
const mockDistillTrace = vi.mocked(distillTrace);
const mockAnalyzeTrace = vi.mocked(analyzeTrace);
const mockRedactSecrets = vi.mocked(redactSecrets);

// Builds a TraceSession with a couple of tool calls so distribution/summary lines render.
function makeSession(overrides: Partial<TraceSession> = {}): TraceSession {
  return {
    sessionId: 'sess-123',
    model: 'claude-opus-4-8',
    startedAt: '2026-06-10T00:00:00Z',
    endedAt: '2026-06-10T00:05:00Z',
    events: [
      { type: 'user', timestamp: '2026-06-10T00:00:00Z', uuid: 'u1', text: 'hi' },
    ],
    stats: {
      totalEvents: 10,
      userPrompts: 2,
      toolCalls: 5,
      toolCallsByName: { Read: 3, Edit: 2 },
      errorCount: 1,
      durationMs: 125000,
    },
    warnings: 2,
    ...overrides,
  };
}

const sampleFindings: ProcessFinding[] = [
  {
    signal: 'no_tests_run',
    severity: 'warning',
    description: 'No tests were executed after code changes',
    evidence: 'Edited 3 files, ran 0 test commands',
    eventIndex: 4,
  },
  {
    signal: 'long_session',
    severity: 'info',
    description: 'Session ran longer than typical',
    evidence: 'Duration 2m 5s',
    eventIndex: 8,
  },
];

// Collects every argument passed to a console spy into one searchable string.
function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

describe('createTraceCommand', () => {
  it('creates a command named "trace"', () => {
    const cmd = createTraceCommand();
    expect(cmd.name()).toBe('trace');
  });

  it('has --format, --verbose, and --stats-only options', () => {
    const cmd = createTraceCommand();
    const opts = cmd.options.map(o => o.long);
    expect(opts).toContain('--format');
    expect(opts).toContain('--verbose');
    expect(opts).toContain('--stats-only');
  });

  it('requires a path argument', () => {
    const cmd = createTraceCommand();
    // Commander stores registered arguments in _args
    expect((cmd as any)._args.length).toBe(1);
  });
});

describe('trace action handler', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Sensible defaults for the happy path; individual tests override as needed.
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('raw trace content');
    mockRedactSecrets.mockReturnValue({ redacted: 'redacted content', count: 0 });
    mockParseTrace.mockReturnValue(makeSession());
    mockDistillTrace.mockReturnValue('DISTILLED TRACE BODY');
    mockAnalyzeTrace.mockReturnValue(sampleFindings);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Throw so the handler stops at process.exit, mirroring real behavior.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with code 1 when the file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const cmd = createTraceCommand();

    await expect(
      cmd.parseAsync(['node', 'trace', '/missing/file.jsonl']),
    ).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(collectOutput(errorSpy)).toContain('file not found: /missing/file.jsonl');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('renders default text format output', async () => {
    const cmd = createTraceCommand();
    await cmd.parseAsync(['node', 'trace', '/path/to/file.jsonl']);

    expect(mockReadFile).toHaveBeenCalledWith('/path/to/file.jsonl', 'utf-8');
    expect(mockRedactSecrets).toHaveBeenCalledWith('raw trace content');
    expect(mockParseTrace).toHaveBeenCalledWith('redacted content');

    const out = collectOutput(logSpy);
    expect(out).toContain('📊 Session Summary');
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('Distribution: 3 Read, 2 Edit');
    expect(out).toContain('2 malformed lines skipped');
    expect(out).toContain('Process Findings (2)');
    expect(out).toContain('no tests run');
    // Non-verbose run should not include the distilled body.
    expect(out).not.toContain('Distilled Trace');
  });

  it('renders json format output', async () => {
    const cmd = createTraceCommand();
    await cmd.parseAsync(['node', 'trace', '/path/to/file.jsonl', '--format', 'json']);

    const out = collectOutput(logSpy);
    const parsed = JSON.parse(out);
    expect(parsed.session.sessionId).toBe('sess-123');
    expect(parsed.session.model).toBe('claude-opus-4-8');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.distilled).toBe('DISTILLED TRACE BODY');
  });

  it('renders markdown format output', async () => {
    const cmd = createTraceCommand();
    await cmd.parseAsync(['node', 'trace', '/path/to/file.jsonl', '--format', 'markdown']);

    const out = collectOutput(logSpy);
    expect(out).toContain('# Agent Trace Review');
    expect(out).toContain('## Session Summary');
    expect(out).toContain('**Model:** claude-opus-4-8');
    expect(out).toContain('### Tool Distribution');
    expect(out).toContain('## Process Findings');
  });

  it('includes the distilled trace when --verbose is set', async () => {
    const cmd = createTraceCommand();
    await cmd.parseAsync(['node', 'trace', '/path/to/file.jsonl', '--verbose']);

    const out = collectOutput(logSpy);
    expect(out).toContain('--- Distilled Trace ---');
    expect(out).toContain('DISTILLED TRACE BODY');
  });

  it('skips analyzeTrace when --stats-only is set', async () => {
    const cmd = createTraceCommand();
    await cmd.parseAsync(['node', 'trace', '/path/to/file.jsonl', '--stats-only']);

    expect(mockAnalyzeTrace).not.toHaveBeenCalled();
    const out = collectOutput(logSpy);
    expect(out).toContain('✅ No process issues detected');
  });

  it('warns when secrets are redacted (redactCount > 0)', async () => {
    mockRedactSecrets.mockReturnValue({ redacted: 'redacted content', count: 4 });
    const cmd = createTraceCommand();
    await cmd.parseAsync(['node', 'trace', '/path/to/file.jsonl']);

    expect(collectOutput(errorSpy)).toContain('Redacted 4 potential secret(s)');
  });

  it('warns when the parsed trace has no events', async () => {
    mockParseTrace.mockReturnValue(makeSession({ events: [] }));
    const cmd = createTraceCommand();
    await cmd.parseAsync(['node', 'trace', '/path/to/file.jsonl']);

    expect(collectOutput(errorSpy)).toContain('no events found in trace file');
  });
});
