import { describe, it, expect } from 'vitest';
import { createTraceCommand } from './trace.js';

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
