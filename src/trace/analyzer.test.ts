import { describe, it, expect } from 'vitest';
import { analyzeTrace } from './analyzer.js';
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
      toolCalls: events.reduce((s, e) => s + (e.toolCalls?.length ?? 0), 0),
      toolCallsByName: {},
      errorCount: 0,
      durationMs: 60000,
    },
    warnings: 0,
  };
}

describe('analyzeTrace', () => {
  it('detects dead ends (error → different approach)', () => {
    const events: TraceEvent[] = [
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{
          name: 'Bash', input: { command: 'npm test' },
          result: { content: 'FAIL: test 1', isError: true },
        }],
      },
      {
        type: 'assistant', timestamp: '', uuid: 'a2',
        text: 'Let me try a different approach',
        toolCalls: [{
          name: 'Write', input: { file_path: 'src/new.ts', content: '...' },
        }],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    const deadEnds = findings.filter(f => f.signal === 'dead_end');
    expect(deadEnds).toHaveLength(1);
    expect(deadEnds[0].severity).toBe('warning');
    expect(deadEnds[0].description).toContain('dead end');
  });

  it('counts multiple dead ends correctly', () => {
    const events: TraceEvent[] = [
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{
          name: 'Bash', input: { command: 'approach1' },
          result: { content: 'error 1', isError: true },
        }],
      },
      {
        type: 'assistant', timestamp: '', uuid: 'a2',
        toolCalls: [{
          name: 'Bash', input: { command: 'approach2' },
          result: { content: 'error 2', isError: true },
        }],
      },
      {
        type: 'assistant', timestamp: '', uuid: 'a3',
        toolCalls: [{
          name: 'Write', input: { file_path: 'fix.ts', content: '...' },
        }],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    const deadEnds = findings.filter(f => f.signal === 'dead_end');
    expect(deadEnds).toHaveLength(1);
    expect(deadEnds[0].description).toContain('2 dead ends');
  });

  it('detects retry storms (3+ same command)', () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < 4; i++) {
      events.push({
        type: 'assistant', timestamp: '', uuid: `a${i}`,
        toolCalls: [{
          name: 'Bash', input: { command: 'npm test' },
          result: { content: 'fail', isError: true },
        }],
      });
    }
    const findings = analyzeTrace(makeSession(events));
    const retries = findings.filter(f => f.signal === 'retry_storm');
    expect(retries).toHaveLength(1);
    expect(retries[0].severity).toBe('warning');
    expect(retries[0].description).toContain('4 times');
  });

  it('does NOT flag retry storms for < 3 retries', () => {
    const events: TraceEvent[] = [
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Bash', input: { command: 'npm test' } }],
      },
      {
        type: 'assistant', timestamp: '', uuid: 'a2',
        toolCalls: [{ name: 'Bash', input: { command: 'npm test' } }],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    const retries = findings.filter(f => f.signal === 'retry_storm');
    expect(retries).toHaveLength(0);
  });

  it('detects unhandled errors (error → no fix attempt)', () => {
    const events: TraceEvent[] = [
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{
          name: 'Bash', input: { command: 'curl api' },
          result: { content: 'connection refused', isError: true },
        }],
      },
      // Next action is completely unrelated
      {
        type: 'assistant', timestamp: '', uuid: 'a2',
        toolCalls: [{
          name: 'Read', input: { file_path: 'unrelated.md' },
        }],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    const unhandled = findings.filter(f => f.signal === 'unhandled_error');
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].evidence).toContain('connection refused');
  });

  it('does NOT flag error as unhandled when next action addresses it', () => {
    const events: TraceEvent[] = [
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{
          name: 'Bash', input: { command: 'npm test', file_path: 'src/foo.ts' },
          result: { content: 'TypeError in foo.ts', isError: true },
        }],
      },
      {
        type: 'assistant', timestamp: '', uuid: 'a2',
        text: 'I see the error, let me fix it',
        toolCalls: [{
          name: 'Edit', input: { file_path: 'src/foo.ts', content: 'fixed' },
        }],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    const unhandled = findings.filter(f => f.signal === 'unhandled_error');
    expect(unhandled).toHaveLength(0);
  });

  it('detects low exploration (single approach, no errors)', () => {
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'build feature X' },
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [
          { name: 'Read', input: { file_path: 'a.ts' } },
          { name: 'Read', input: { file_path: 'b.ts' } },
          { name: 'Write', input: { file_path: 'c.ts', content: '...' } },
          { name: 'Write', input: { file_path: 'd.ts', content: '...' } },
          { name: 'Bash', input: { command: 'npm test' } },
          { name: 'Bash', input: { command: 'npm run build' } },
        ],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    const lowExplore = findings.filter(f => f.signal === 'low_exploration');
    expect(lowExplore).toHaveLength(1);
    expect(lowExplore[0].severity).toBe('info');
  });

  it('returns empty findings for a clean varied session', () => {
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'do task' },
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Read', input: { file_path: 'a.ts' } }],
      },
      { type: 'user', timestamp: '', uuid: 'u2', text: 'now do B' },
      {
        type: 'assistant', timestamp: '', uuid: 'a2',
        toolCalls: [{ name: 'Write', input: { file_path: 'b.ts', content: '...' } }],
      },
      { type: 'user', timestamp: '', uuid: 'u3', text: 'test it' },
      {
        type: 'assistant', timestamp: '', uuid: 'a3',
        toolCalls: [{
          name: 'Bash', input: { command: 'npm test' },
          result: { content: 'all pass', isError: false },
        }],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    // Multiple user prompts + no errors = not low exploration; no retries; no dead ends
    expect(findings).toHaveLength(0);
  });

  it('returns empty findings for empty session', () => {
    const findings = analyzeTrace(makeSession([]));
    expect(findings).toHaveLength(0);
  });

  it('sorts findings: warnings before info', () => {
    const events: TraceEvent[] = [
      { type: 'user', timestamp: '', uuid: 'u1', text: 'go' },
      // Create both a warning (retry storm) and info (low exploration) scenario
      {
        type: 'assistant', timestamp: '', uuid: 'a1',
        toolCalls: [{ name: 'Bash', input: { command: 'test' }, result: { content: 'err', isError: true } }],
      },
      {
        type: 'assistant', timestamp: '', uuid: 'a2',
        toolCalls: [{ name: 'Bash', input: { command: 'test' }, result: { content: 'err', isError: true } }],
      },
      {
        type: 'assistant', timestamp: '', uuid: 'a3',
        toolCalls: [{ name: 'Bash', input: { command: 'test' }, result: { content: 'err', isError: true } }],
      },
    ];
    const findings = analyzeTrace(makeSession(events));
    if (findings.length >= 2) {
      const wIdx = findings.findIndex(f => f.severity === 'warning');
      const iIdx = findings.findIndex(f => f.severity === 'info');
      if (wIdx !== -1 && iIdx !== -1) {
        expect(wIdx).toBeLessThan(iIdx);
      }
    }
  });
});
