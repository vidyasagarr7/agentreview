import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createFixCommand } from './fix.js';

describe('createFixCommand', () => {
  const cmd = createFixCommand();

  it('returns a Command instance', () => {
    expect(cmd).toBeInstanceOf(Command);
  });

  it('has the name "fix"', () => {
    expect(cmd.name()).toBe('fix');
  });

  it('has a required <pr-url> argument', () => {
    const args = cmd.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('pr-url');
    expect(args[0].required).toBe(true);
  });

  it('has --model option', () => {
    const opt = cmd.options.find((o) => o.long === '--model');
    expect(opt).toBeDefined();
  });

  it('has --output option', () => {
    const opt = cmd.options.find((o) => o.long === '--output');
    expect(opt).toBeDefined();
  });

  it('has --dry-run option', () => {
    const opt = cmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeDefined();
  });

  it('has --min-confidence option', () => {
    const opt = cmd.options.find((o) => o.long === '--min-confidence');
    expect(opt).toBeDefined();
  });

  it('has --verbose option', () => {
    const opt = cmd.options.find((o) => o.long === '--verbose');
    expect(opt).toBeDefined();
  });

  it('has --yes option', () => {
    const opt = cmd.options.find((o) => o.long === '--yes');
    expect(opt).toBeDefined();
  });

  it('has --repo-dir option', () => {
    const opt = cmd.options.find((o) => o.long === '--repo-dir');
    expect(opt).toBeDefined();
  });
});
