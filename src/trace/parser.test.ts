import { describe, it, expect } from 'vitest';
import { parseTrace } from './parser.js';

function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('parseTrace — core parsing', () => {
  it('parses minimal valid JSONL with 1 user + 1 assistant event', () => {
    const input = jsonl(
      {
        type: 'user',
        sessionId: 'sess-1',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'user', content: 'hello world' },
      },
      {
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:05Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hi there' }],
        },
      },
    );

    const session = parseTrace(input);

    expect(session.sessionId).toBe('sess-1');
    expect(session.model).toBe('claude-sonnet-4');
    expect(session.startedAt).toBe('2025-01-01T00:00:00Z');
    expect(session.endedAt).toBe('2025-01-01T00:00:05Z');
    expect(session.events).toHaveLength(2);
    expect(session.events[0].type).toBe('user');
    expect(session.events[0].text).toBe('hello world');
    expect(session.events[1].type).toBe('assistant');
    expect(session.events[1].text).toBe('hi there');
  });

  it('skips malformed JSON lines and increments warning counter', () => {
    const input = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'user', content: 'ok' },
      }),
      '{ not valid json',
      'garbage',
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      }),
    ].join('\n');

    const session = parseTrace(input);
    expect(session.events).toHaveLength(2);
    expect(session.warnings).toBe(2);
  });

  it('drops noise event types', () => {
    const input = jsonl(
      { type: 'permission-mode', uuid: 'n1', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'file-history-snapshot', uuid: 'n2', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'attachment', uuid: 'n3', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'last-prompt', uuid: 'n4', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'ai-title', uuid: 'n5', timestamp: '2025-01-01T00:00:00Z' },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'user', content: 'keep me' },
      },
    );

    const session = parseTrace(input);
    expect(session.events).toHaveLength(1);
    expect(session.events[0].text).toBe('keep me');
  });

  it('extracts user prompt text from string content format', () => {
    const input = jsonl({
      type: 'user',
      uuid: 'u1',
      timestamp: '2025-01-01T00:00:00Z',
      message: { role: 'user', content: 'plain string prompt' },
    });
    const session = parseTrace(input);
    expect(session.events[0].text).toBe('plain string prompt');
  });

  it('extracts user prompt text from array content format', () => {
    const input = jsonl({
      type: 'user',
      uuid: 'u1',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      },
    });
    const session = parseTrace(input);
    expect(session.events[0].text).toContain('part one');
    expect(session.events[0].text).toContain('part two');
  });

  it('extracts assistant text blocks and tool_use blocks', () => {
    const input = jsonl({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'text', text: "I'll list files" },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const session = parseTrace(input);
    expect(session.events).toHaveLength(1);
    const ev = session.events[0];
    expect(ev.type).toBe('assistant');
    expect(ev.text).toBe("I'll list files");
    expect(ev.toolCalls).toHaveLength(1);
    expect(ev.toolCalls![0].name).toBe('Bash');
    expect(ev.toolCalls![0].input).toEqual({ command: 'ls' });
    expect(ev.toolCalls![0].id).toBe('t1');
  });

  it('extracts thinking blocks on assistant events', () => {
    const input = jsonl({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'pondering options' },
          { type: 'text', text: 'answer' },
        ],
      },
    });
    const session = parseTrace(input);
    expect(session.events[0].thinking).toContain('pondering options');
    expect(session.events[0].text).toBe('answer');
  });

  it('computes TraceStats correctly (counts and duration)', () => {
    const input = jsonl(
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'user', content: 'go' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'a' } },
            { type: 'tool_use', id: 't2', name: 'Read', input: { path: 'x' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2025-01-01T00:00:10Z',
        message: { role: 'user', content: 'again' },
      },
    );
    const session = parseTrace(input);
    expect(session.stats.totalEvents).toBe(3);
    expect(session.stats.userPrompts).toBe(2);
    expect(session.stats.toolCalls).toBe(2);
    expect(session.stats.toolCallsByName).toEqual({ Bash: 1, Read: 1 });
    expect(session.stats.durationMs).toBe(10_000);
  });

  it('handles empty input → empty TraceSession', () => {
    const session = parseTrace('');
    expect(session.events).toHaveLength(0);
    expect(session.stats.totalEvents).toBe(0);
    expect(session.sessionId).toBeNull();
    expect(session.model).toBeNull();
    expect(session.startedAt).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(session.stats.durationMs).toBeNull();
  });

  it('handles whitespace-only / blank lines without warnings', () => {
    const input = [
      '',
      '   ',
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'user', content: 'ok' },
      }),
      '',
    ].join('\n');
    const session = parseTrace(input);
    expect(session.events).toHaveLength(1);
    expect(session.warnings).toBe(0);
  });

  it('attaches tool result to matching tool_use_id', () => {
    const input = jsonl(
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2025-01-01T00:00:01Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'file.txt' },
          ],
        },
      },
    );
    const session = parseTrace(input);
    const call = session.events[0].toolCalls![0];
    expect(call.result).toBeDefined();
    expect(call.result!.content).toBe('file.txt');
    expect(call.result!.isError).toBe(false);
  });

  it('sets isError when tool_result has is_error=true', () => {
    const input = jsonl(
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't-err', name: 'Bash', input: { command: 'false' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2025-01-01T00:00:01Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't-err',
              content: 'command failed: exit 1',
              is_error: true,
            },
          ],
        },
      },
    );
    const session = parseTrace(input);
    const call = session.events[0].toolCalls![0];
    expect(call.result!.isError).toBe(true);
    expect(session.stats.errorCount).toBe(1);
  });

  it('truncates ok tool_result to 80 chars', () => {
    const longOk = 'A'.repeat(500);
    const input = jsonl(
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:01Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: longOk }],
        },
      },
    );
    const session = parseTrace(input);
    const result = session.events[0].toolCalls![0].result!;
    // 80 char body + ellipsis marker
    expect(result.content.length).toBeLessThanOrEqual(81);
    expect(result.content.startsWith('A'.repeat(80))).toBe(true);
  });

  it('truncates error tool_result to 400 chars', () => {
    const longErr = 'E'.repeat(800);
    const input = jsonl(
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:01Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: longErr, is_error: true },
          ],
        },
      },
    );
    const session = parseTrace(input);
    const result = session.events[0].toolCalls![0].result!;
    expect(result.content.length).toBeLessThanOrEqual(401);
    expect(result.content.startsWith('E'.repeat(400))).toBe(true);
  });

  it('handles tool_result content given as an array of text blocks', () => {
    const input = jsonl(
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2025-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2025-01-01T00:00:01Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'hello from array' }],
            },
          ],
        },
      },
    );
    const session = parseTrace(input);
    expect(session.events[0].toolCalls![0].result!.content).toContain('hello from array');
  });

  it('keeps orphaned tool_result as a synthetic event', () => {
    const input = jsonl({
      type: 'user',
      uuid: 'u1',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'missing-id', content: 'lonely result' },
        ],
      },
    });
    const session = parseTrace(input);
    // Orphan synthesized as a tool_use event, not dropped.
    expect(session.events).toHaveLength(1);
    expect(session.events[0].type).toBe('tool_use');
    expect(session.events[0].toolCalls![0].name).toBe('<orphan_tool_result>');
    expect(session.events[0].toolCalls![0].result!.content).toBe('lonely result');
  });

  it('handles 10K+ lines without OOM', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(
        JSON.stringify({
          type: 'user',
          uuid: `u${i}`,
          timestamp: '2025-01-01T00:00:00Z',
          message: { role: 'user', content: `prompt ${i}` },
        }),
      );
    }
    const session = parseTrace(lines.join('\n'));
    expect(session.events).toHaveLength(10_000);
    expect(session.stats.userPrompts).toBe(10_000);
  });
});
