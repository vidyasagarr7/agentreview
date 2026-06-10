import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createLensesCommand } from './lenses.js';
import { LensRegistry } from '../../lenses/registry.js';
import { mkdir, copyFile, access, readFile } from 'fs/promises';

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
  readdir: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

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

// Collects every argument passed to a console spy into one searchable string.
function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

describe('lenses list action', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('prints built-in and custom lenses', async () => {
    const builtins = [
      { id: 'security', description: 'Security review', severity: 'high' },
      { id: 'quality', description: 'Code quality' },
    ];
    const custom = [{ id: 'my-lens', description: 'My custom lens' }];

    vi.spyOn(LensRegistry.prototype, 'loadCustomLenses').mockResolvedValue(custom as never);
    vi.spyOn(LensRegistry.prototype, 'getBuiltinLenses').mockReturnValue(builtins as never);
    vi.spyOn(LensRegistry.prototype, 'getAllLenses').mockReturnValue([
      ...builtins,
      ...custom,
    ] as never);

    const cmd = createLensesCommand();
    await cmd.parseAsync(['list'], { from: 'user' });

    const output = collectOutput(logSpy);
    expect(output).toContain('Available Lenses');
    expect(output).toContain('Built-in:');
    expect(output).toContain('security [high] — Security review');
    expect(output).toContain('quality — Code quality');
    expect(output).toContain('Custom:');
    expect(output).toContain('my-lens — My custom lens');
  });

  it('shows a hint when there are no custom lenses', async () => {
    const builtins = [{ id: 'security', description: 'Security review', severity: 'high' }];

    vi.spyOn(LensRegistry.prototype, 'loadCustomLenses').mockResolvedValue([] as never);
    vi.spyOn(LensRegistry.prototype, 'getBuiltinLenses').mockReturnValue(builtins as never);
    vi.spyOn(LensRegistry.prototype, 'getAllLenses').mockReturnValue(builtins as never);

    const cmd = createLensesCommand();
    await cmd.parseAsync(['list'], { from: 'user' });

    const output = collectOutput(logSpy);
    expect(output).toContain('Custom: (none)');
    expect(output).toContain('agentreview lenses add ./my-lens.json');
  });
});

describe('lenses add action', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const validLens = {
    id: 'my-custom',
    name: 'My Custom Lens',
    description: 'A custom lens',
    systemPrompt: 'Review carefully.',
    focusAreas: ['area-one', 'area-two'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    vi.mocked(mkdir).mockResolvedValue(undefined as never);
    vi.mocked(copyFile).mockResolvedValue(undefined as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(validLens) as never);
    // Default: destination file does not exist yet.
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
  });

  it('copies the lens file and reports success on the happy path', async () => {
    const cmd = createLensesCommand();
    await cmd.parseAsync(['add', './my-lens.json'], { from: 'user' });

    expect(copyFile).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    const output = collectOutput(logSpy);
    expect(output).toContain('Lens "my-custom" (My Custom Lens) added successfully');
    expect(output).toContain('--lens my-custom');
  });

  it('reports a file-not-found error when the source is missing', async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' })
    );

    const cmd = createLensesCommand();
    await expect(cmd.parseAsync(['add', './missing.json'], { from: 'user' })).rejects.toThrow(
      'process.exit(1)'
    );

    expect(collectOutput(errorSpy)).toContain('File not found: ./missing.json');
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('reports an invalid-JSON error when the file is malformed', async () => {
    vi.mocked(readFile).mockResolvedValue('{ not valid json' as never);

    const cmd = createLensesCommand();
    await expect(cmd.parseAsync(['add', './broken.json'], { from: 'user' })).rejects.toThrow(
      'process.exit(1)'
    );

    expect(collectOutput(errorSpy)).toContain('Invalid JSON in lens file');
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('rejects a lens whose id conflicts with a built-in', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ ...validLens, id: 'security' }) as never
    );

    const cmd = createLensesCommand();
    await expect(cmd.parseAsync(['add', './sec.json'], { from: 'user' })).rejects.toThrow();

    expect(collectOutput(errorSpy)).toContain(
      'Lens ID "security" conflicts with a built-in lens'
    );
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('warns when updating an existing custom lens', async () => {
    // Destination already exists.
    vi.mocked(access).mockResolvedValue(undefined as never);

    const cmd = createLensesCommand();
    await cmd.parseAsync(['add', './my-lens.json'], { from: 'user' });

    const output = collectOutput(logSpy);
    expect(output).toContain('Updating existing lens at:');
    expect(output).toContain('added successfully');
    expect(copyFile).toHaveBeenCalledTimes(1);
  });
});
