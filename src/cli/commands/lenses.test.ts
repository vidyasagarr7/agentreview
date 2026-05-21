import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createLensesCommand } from './lenses.js';
import { LensRegistry } from '../../lenses/registry.js';

describe('createLensesCommand', () => {
  it('returns a Command instance', () => {
    const cmd = createLensesCommand();
    expect(cmd).toBeInstanceOf(Command);
  });

  it('has the name "lenses"', () => {
    const cmd = createLensesCommand();
    expect(cmd.name()).toBe('lenses');
  });

  it('has a "list" subcommand', () => {
    const cmd = createLensesCommand();
    const listCmd = cmd.commands.find((c) => c.name() === 'list');
    expect(listCmd).toBeDefined();
    expect(listCmd!.description()).toContain('List');
  });

  it('has an "add" subcommand', () => {
    const cmd = createLensesCommand();
    const addCmd = cmd.commands.find((c) => c.name() === 'add');
    expect(addCmd).toBeDefined();
    expect(addCmd!.description()).toContain('Add');
  });
});

describe('LensRegistry.resolveLenses', () => {
  it('returns built-in lenses for "all"', () => {
    const registry = new LensRegistry();
    const lenses = registry.resolveLenses('all');
    expect(lenses.length).toBeGreaterThanOrEqual(3);

    const ids = lenses.map((l) => l.id);
    expect(ids).toContain('security');
    expect(ids).toContain('architecture');
    expect(ids).toContain('quality');
  });
});
