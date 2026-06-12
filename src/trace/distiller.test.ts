import { describe, it, expect } from 'vitest';
import { distillTrace } from './distiller.js';
import type { TraceSession, TraceEvent } from './types.js';

function makeSession(events: TraceEvent[]): TraceSession {
  return {
    sessionId: 'test',
    model: 'claude-sonnet-4',
    startedAt: '2025-01-01T00:00:00Z',
    endedAt: '2025-01-01T00:01:00Z',
    events,
    stats: {
      totalEvents: events.length,
      userPrompts: events.filter(e => e.type === 'user').length,
      toolCalls: 0,
      toolCallsByName: {},
      errorCount: 0,
      durationMs: 60000,
    },
    warnings: 0,
  };
}

describe('distillTrace', () => {
  it('renders user events as USER: text', () => {
    const session = makeSession([
      { type: 'user', timestamp: '', uuid: 'u1', text: 'hello world' },
    ]);
    const result = distillTrace(session);
    expect(result).toBe('USER: hello world');
  });

  it('renders assistant text as ASSISTANT: text', () => {
    const session = makeSession([
      { type: 'assistant', timestamp: '', uuid: 'a1', text: 'I will help' },
    ]);
    const result = distillTrace(session);
    expect(result).toBe('ASSISTANT: I will help');
  });

  it('renders Bash tool calls with command', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Bash', input: { command: 'ls -la' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Bash: ls -la');
  });

  it('truncates Bash commands at 120 chars', () => {
    const longCmd = 'x'.repeat(200);
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Bash', input: { command: longCmd } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('…');
  });

  it('renders Write/Edit with path and size, not content', () => {
    const content = 'x'.repeat(5000);
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Write', input: { file_path: 'src/foo.ts', content } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Write src/foo.ts');
    expect(result).toContain('KB)');
    expect(result).not.toContain('x'.repeat(100));
  });

  it('renders Read calls with path', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Read', input: { file_path: 'src/bar.ts' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Read src/bar.ts');
  });

  it('renders Grep calls with pattern and path', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Grep', input: { pattern: 'TODO', path: 'src/' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Grep "TODO" in src/');
  });

  it('NEVER collapses failed tool calls', () => {
    // 8 consecutive tool calls, all errors — should NOT be collapsed
    const events: TraceEvent[] = [];
    for (let i = 0; i < 8; i++) {
      events.push({
        type: 'assistant', timestamp: '', uuid: `a${i}`,
        toolCalls: [{
          name: 'Bash',
          input: { command: `attempt ${i}` },
          result: { content: 'error', isError: true },
        }],
      });
    }
    const session = makeSession(events);
    const result = distillTrace(session);
    // Each line should be present (not collapsed)
    for (let i = 0; i < 8; i++) {
      expect(result).toContain(`attempt ${i}`);
    }
    expect(result).not.toContain('[exploration:');
  });

  it('collapses successful exploration runs >= 6', () => {
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'start' },
    ];
    // 8 successful Read calls
    for (let i = 0; i < 8; i++) {
      events.push({
        type: 'assistant', timestamp: '', uuid: `a${i}`,
        toolCalls: [{
          name: 'Read',
          input: { file_path: `file${i}.ts` },
          result: { content: 'ok', isError: false },
        }],
      });
    }
    events.push({ type: 'user', timestamp: '', uuid: 'u2', text: 'done' });

    // Make it big enough to trigger collapse (target tokens exceeded)
    const session = makeSession(events);
    // Force collapse by making estimateTokens think we're over budget
    // We need > 60K tokens worth of content. Let's add a large user prompt.
    const bigEvents: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'x'.repeat(200000) },
    ];
    for (let i = 0; i < 8; i++) {
      bigEvents.push({
        type: 'assistant', timestamp: '', uuid: `a${i}`,
        toolCalls: [{
          name: 'Read',
          input: { file_path: `file${i}.ts` },
        }],
      });
    }
    bigEvents.push({ type: 'user', timestamp: '', uuid: 'u2', text: 'done' });
    const bigSession = makeSession(bigEvents);
    const result = distillTrace(bigSession);
    expect(result).toContain('[exploration:');
    expect(result).toContain('reads');
  });

  it('applies head/tail truncation when over hard cap', () => {
    const events: TraceEvent[] = [];
    // Create a massive session with unique lines (so dedup doesn't collapse them)
    for (let i = 0; i < 2000; i++) {
      events.push({
        type: 'user', timestamp: '', uuid: `u${i}`,
        text: `prompt ${i}: ${'x'.repeat(500)}`,
      });
    }
    const session = makeSession(events);
    const result = distillTrace(session);
    expect(result).toContain('[… elided');
    expect(result).toContain('events …]');
  });

  it('handles empty session', () => {
    const session = makeSession([]);
    const result = distillTrace(session);
    expect(result).toBe('');
  });

  it('skips adjacent duplicate lines', () => {
    const session = makeSession([
      { type: 'user', timestamp: '', uuid: 'u1', text: 'same' },
      { type: 'user', timestamp: '', uuid: 'u2', text: 'same' },
      { type: 'user', timestamp: '', uuid: 'u3', text: 'different' },
    ]);
    const result = distillTrace(session);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('USER: same');
    expect(lines[1]).toBe('USER: different');
  });

  it('shows error status on Bash calls', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{
          name: 'Bash',
          input: { command: 'npm test' },
          result: { content: 'FAIL', isError: true },
        }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('→ ERR');
  });

  it('renders task tool calls as Subagent: description', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Task', input: { description: 'Write tests for the auth module' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Subagent: Write tests for the auth module');
  });

  it('truncates task description at 100 chars', () => {
    const longDesc = 'x'.repeat(150);
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Task', input: { description: longDesc } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Subagent: ' + 'x'.repeat(100));
    expect(result).not.toContain('x'.repeat(101));
  });

  it('skips todowrite tool calls (returns empty string)', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [
          { name: 'TodoWrite', input: { todos: [] } },
          { name: 'Bash', input: { command: 'echo hi' } },
        ],
      },
    ]);
    const result = distillTrace(session);
    expect(result).not.toContain('TodoWrite');
    expect(result).toContain('Bash: echo hi');
  });

  it('renders generic tool with file_path', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'NotebookEdit', input: { file_path: 'analysis.ipynb' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('NotebookEdit analysis.ipynb');
  });

  it('renders generic tool without file_path as just tool name', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'WebSearch', input: { query: 'typescript coverage' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('WebSearch');
    expect(result).not.toContain('undefined');
  });

  it('returns null (skips) events with unknown type', () => {
    const events = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'hello' },
      { type: 'system', timestamp: '', uuid: 's1', text: 'init' } as any,
      { type: 'user', timestamp: '', uuid: 'u2', text: 'world' },
    ];
    const session = makeSession(events as any);
    const result = distillTrace(session);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(result).not.toContain('system');
    expect(result).not.toContain('init');
  });

  it('keeps short tool-only runs (< 6) without collapsing to exploration summary', () => {
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'x'.repeat(200000) },
    ];
    for (let i = 0; i < 4; i++) {
      events.push({
        type: 'assistant', timestamp: '', uuid: `a${i}`,
        toolCalls: [{ name: 'Read', input: { file_path: `file${i}.ts` } }],
      });
    }
    events.push({ type: 'user', timestamp: '', uuid: 'u2', text: 'done' });
    const session = makeSession(events);
    const result = distillTrace(session);
    expect(result).not.toContain('[exploration:');
    expect(result).toContain('Read file0.ts');
  });

  // --- Branch coverage additions ---

  it('uses singular form when a tool appears exactly once in exploration', () => {
    // 6 tool calls: 5 Reads + 1 Grep → triggers exploration collapse
    // Grep count = 1 → singular (no trailing 's')
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'x'.repeat(200000) },
    ];
    for (let i = 0; i < 5; i++) {
      events.push({
        type: 'assistant', timestamp: '', uuid: `a${i}`,
        toolCalls: [{ name: 'Read', input: { file_path: `f${i}.ts` } }],
      });
    }
    events.push({
      type: 'assistant', timestamp: '', uuid: 'a5',
      toolCalls: [{ name: 'Grep', input: { pattern: 'x', path: 'src/' } }],
    });
    events.push({ type: 'user', timestamp: '', uuid: 'u2', text: 'done' });
    const session = makeSession(events);
    const result = distillTrace(session);
    expect(result).toContain('[exploration:');
    // "5 reads" (plural) and "1 grep" (singular — no trailing s)
    expect(result).toContain('5 reads');
    expect(result).toMatch(/1 grep(?!s)/);
  });

  it('truncateMiddle returns all lines when head+tail cover everything (elided <= 0)', () => {
    // HARD_CAP = 200000 tokens, targetChars = 200000/0.4 = 500000
    // headBudget = max(250000, lines[0].length+1), tailBudget = max(250000, lines[last].length+1)
    // We need total estimateTokens > HARD_CAP to trigger truncateMiddle,
    // but few enough short middle lines that head+tail cover them all.
    // Strategy: 3 lines where line[0] is huge (>500K chars to exceed hard cap)
    // but line[1] is short. headBudget = max(250000, len(line[0])+1) = huge.
    // So head will grab line[0] and line[1]. tail grabs line[2].
    // elided = 3 - 2 - 1 = 0 → hits the elided <= 0 branch!
    const bigText = 'a'.repeat(510000); // > 500K chars → exceeds hard cap
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: bigText },
      { type: 'user', timestamp: '', uuid: 'u2', text: 'middle line' },
      { type: 'user', timestamp: '', uuid: 'u3', text: 'end line' },
    ];
    const session = makeSession(events);
    const result = distillTrace(session);
    // All 3 lines should be present, no elision marker
    expect(result).not.toContain('[… elided');
    expect(result).toContain('USER: middle line');
    expect(result).toContain('USER: end line');
  });

  it('skips user events with no text', () => {
    const session = makeSession([
      { type: 'user', timestamp: '', uuid: 'u1', text: '' },
      { type: 'user', timestamp: '', uuid: 'u2', text: 'hello' },
    ]);
    const result = distillTrace(session);
    expect(result).toBe('USER: hello');
  });

  it('skips assistant events with no text and no toolCalls', () => {
    const session = makeSession([
      { type: 'assistant', timestamp: '', uuid: 'a1' } as TraceEvent,
      { type: 'user', timestamp: '', uuid: 'u1', text: 'hello' },
    ]);
    const result = distillTrace(session);
    expect(result).toBe('USER: hello');
  });

  it('renders Bash with no result (no status indicator)', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Bash', input: { command: 'echo test' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toBe('Bash: echo test');
    expect(result).not.toContain('→');
  });

  it('renders Bash OK status when result is not an error', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{
          name: 'Bash',
          input: { command: 'echo hi' },
          result: { content: 'hi', isError: false },
        }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('→ OK');
  });

  it('renders Grep with query field (fallback from pattern)', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Grep', input: { query: 'findme' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Grep "findme"');
    // no path
    expect(result).not.toContain(' in ');
  });

  it('renders Glob tool calls with pattern', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Glob', input: { pattern: '**/*.ts' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Glob "**/*.ts"');
  });

  it('renders Replace tool like Write/Edit with path and size', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Replace', input: { file_path: 'src/x.ts', content: 'abc' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Replace src/x.ts');
    expect(result).toContain('KB)');
  });

  it('handles Write with missing content (0.0KB)', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Write', input: { file_path: 'foo.ts' } }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Write foo.ts (0.0KB)');
  });

  it('handles Bash with non-string command', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Bash', input: { command: 123 } }],
      },
    ]);
    const result = distillTrace(session);
    // cmd is '' (empty trim), so result is 'Bash: ' with trailing space
    expect(result).toBe('Bash: ');
  });

  it('handles tool call with no input', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Bash' } as any],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Bash:');
  });

  it('handles Task with no description', () => {
    const session = makeSession([
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Task', input: {} }],
      },
    ]);
    const result = distillTrace(session);
    expect(result).toContain('Subagent:');
  });
});
