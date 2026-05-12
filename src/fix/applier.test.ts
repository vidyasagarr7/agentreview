import { describe, it, expect, vi } from 'vitest';
import { applyPatch, revertPatch } from './applier.js';
import { execFile } from 'child_process';
import { writeFile, unlink } from 'fs/promises';

// Mock child_process and fs
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

const mockExecFile = vi.mocked(execFile);

describe('applyPatch', () => {
  it('calls git apply with the patch file', async () => {
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      // Check it's a forward apply (no --reverse)
      expect(args).toBeDefined();
      expect((args as string[]).includes('--reverse')).toBe(false);
      (cb as (err: Error | null) => void)(null);
      return undefined as never;
    });

    const result = await applyPatch('--- a/f\n+++ b/f\n', '/tmp/repo');

    expect(result).toBe(true);
    expect(writeFile).toHaveBeenCalled();
  });

  it('returns false when git apply fails', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (err: Error | null) => void)(new Error('patch failed'));
      return undefined as never;
    });

    const result = await applyPatch('bad patch', '/tmp/repo');

    expect(result).toBe(false);
  });
});

describe('revertPatch', () => {
  it('calls git apply --reverse', async () => {
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      expect((args as string[]).includes('--reverse')).toBe(true);
      (cb as (err: Error | null) => void)(null);
      return undefined as never;
    });

    const result = await revertPatch('--- a/f\n+++ b/f\n', '/tmp/repo');

    expect(result).toBe(true);
  });

  it('returns false on failure', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (err: Error | null) => void)(new Error('revert failed'));
      return undefined as never;
    });

    const result = await revertPatch('bad', '/tmp/repo');

    expect(result).toBe(false);
  });
});
