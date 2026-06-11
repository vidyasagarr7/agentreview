import { describe, it, expect } from 'vitest';
import { parseTrace, distillTrace, analyzeTrace } from './index.js';
import type {
  TraceSession,
  TraceEvent,
  TraceEventType,
  TraceStats,
  TraceToolCall,
  TraceToolResult,
  ProcessFinding,
} from './index.js';

describe('trace barrel exports', () => {
  it('exports parseTrace as a function', () => {
    expect(typeof parseTrace).toBe('function');
  });

  it('exports distillTrace as a function', () => {
    expect(typeof distillTrace).toBe('function');
  });

  it('exports analyzeTrace as a function', () => {
    expect(typeof analyzeTrace).toBe('function');
  });

  it('type exports are accessible at compile time', () => {
    // TypeScript compile-time check: if these types were not exported,
    // this file would fail to compile.
    const _session: TraceSession | undefined = undefined;
    const _event: TraceEvent | undefined = undefined;
    const _eventType: TraceEventType | undefined = undefined;
    const _stats: TraceStats | undefined = undefined;
    const _toolCall: TraceToolCall | undefined = undefined;
    const _toolResult: TraceToolResult | undefined = undefined;
    const _finding: ProcessFinding | undefined = undefined;

    // Suppress unused-variable warnings while proving types resolve
    expect(_session).toBeUndefined();
    expect(_event).toBeUndefined();
    expect(_eventType).toBeUndefined();
    expect(_stats).toBeUndefined();
    expect(_toolCall).toBeUndefined();
    expect(_toolResult).toBeUndefined();
    expect(_finding).toBeUndefined();
  });
});
