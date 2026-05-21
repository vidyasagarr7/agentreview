import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createScanCommand } from './scan.js';

describe('createScanCommand', () => {
  const cmd = createScanCommand();

  it('returns a Command instance', () => {
    expect(cmd).toBeInstanceOf(Command);
  });

  it('has the name "scan"', () => {
    expect(cmd.name()).toBe('scan');
  });

  it('has a required <target> argument', () => {
    const args = cmd.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('target');
    expect(args[0].required).toBe(true);
  });

  it.each([
    '--focus',
    '--model',
    '--format',
    '--output',
    '--fail-on',
    '--redact',
    '--issue',
    '--max-files',
    '--budget',
    '--branch',
    '--timeout',
    '--verbose',
    '--yes',
  ])('has %s option', (longFlag) => {
    const opt = cmd.options.find((o) => o.long === longFlag);
    expect(opt).toBeDefined();
  });

  it('defaults --format to markdown', () => {
    const opt = cmd.options.find((o) => o.long === '--format');
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe('markdown');
  });

  it('defaults --max-files to 50', () => {
    const opt = cmd.options.find((o) => o.long === '--max-files');
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe(50);
  });

  it('defaults --budget to 100000', () => {
    const opt = cmd.options.find((o) => o.long === '--budget');
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe(100000);
  });
});
