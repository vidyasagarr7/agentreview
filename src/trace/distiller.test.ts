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

  it('uses singular form when a tool appears exactly once in exploration summary', () => {
    // Covers the `n !== 1 ? 's' : ''` branch where n === 1 (singular)
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'x'.repeat(200000) },
    ];
    // 5 Reads + 1 Grep + 1 Bash (7 total ≥ EXPLORATION_RUN_MIN=6)
    // Read appears 5 times (plural), Grep and Bash appear once each (singular)
    for (let i = 0; i < 5; i++) {
      events.push({
        type: 'assistant', timestamp: '', uuid: `r${i}`,
        toolCalls: [{ name: 'Read', input: { file_path: `file${i}.ts` } }],
      });
    }
    events.push({
      type: 'assistant', timestamp: '', uuid: 'g0',
      toolCalls: [{ name: 'Grep', input: { pattern: 'TODO', path: 'src/' } }],
    });
    events.push({
      type: 'assistant', timestamp: '', uuid: 'b0',
      toolCalls: [{ name: 'Bash', input: { command: 'echo hi' } }],
    });
    events.push({ type: 'user', timestamp: '', uuid: 'u2', text: 'done' });
    const session = makeSession(events);
    const result = distillTrace(session);
    expect(result).toContain('[exploration:');
    // plural for reads (5)
    expect(result).toContain('5 reads');
    // singular for grep (1) and bash (1)
    expect(result).toContain('1 grep');
    expect(result).toContain('1 bash');
    // must NOT add spurious 's'
    expect(result).not.toContain('1 bashs');
    expect(result).not.toContain('1 greps');
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
});
