import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkDataDisclosure, checkScanDisclosure } from './disclosure.js';

describe('checkDataDisclosure', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  describe('non-TTY stdin', () => {
    const originalIsTTY = process.stdin.isTTY;

    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
    });

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('writes a non-interactive error and exits when not acknowledged and not nonInteractive', async () => {
      await expect(checkDataDisclosure(false, false)).rejects.toThrow('process.exit');
      expect(process.exit).toHaveBeenCalledWith(1);
      const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
      const output = calls.map((c: unknown[]) => c[0]).join('');
      expect(output).toContain('Non-interactive environment');
    });
  });

  it('returns immediately when acknowledged is true', async () => {
    await expect(checkDataDisclosure(true, false)).resolves.toBeUndefined();
  });

  it('returns immediately when nonInteractive (yes) is true', async () => {
    await expect(checkDataDisclosure(false, true)).resolves.toBeUndefined();
  });

  it('writes disclosure message when not acknowledged and yes flag passed', async () => {
    await checkDataDisclosure(false, true);
    expect(process.stderr.write).toHaveBeenCalled();
    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const output = calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('AgentReview sends your PR diff');
    expect(output).toContain('--yes flag');
  });
});

describe('checkScanDisclosure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  const baseMeta = { fileCount: 10, provider: 'openai', model: 'gpt-4o' };

  it('returns immediately when acknowledged is true', async () => {
    await expect(checkScanDisclosure(true, false, baseMeta)).resolves.toBeUndefined();
  });

  it('returns immediately when yes is true', async () => {
    await expect(checkScanDisclosure(false, true, baseMeta)).resolves.toBeUndefined();
  });

  it('writes scan message with file count and provider info', async () => {
    await checkScanDisclosure(false, true, baseMeta);
    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const output = calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('10 files');
    expect(output).toContain('openai');
    expect(output).toContain('gpt-4o');
  });

  it('includes secrets warning when focus includes secrets', async () => {
    await checkScanDisclosure(false, true, { ...baseMeta, focus: ['secrets'] });
    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const output = calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain("'secrets' focus");
    expect(output).toContain('--redact');
  });

  it('does not include secrets warning without secrets focus', async () => {
    await checkScanDisclosure(false, true, { ...baseMeta, focus: ['quality'] });
    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const output = calls.map((c: unknown[]) => c[0]).join('');
    expect(output).not.toContain("'secrets' focus");
  });

  describe('non-TTY stdin', () => {
    const originalIsTTY = process.stdin.isTTY;

    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
    });

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('writes a non-interactive error and exits when not acknowledged and yes is false', async () => {
      await expect(checkScanDisclosure(false, false, baseMeta)).rejects.toThrow('process.exit');
      expect(process.exit).toHaveBeenCalledWith(1);
      const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
      const output = calls.map((c: unknown[]) => c[0]).join('');
      expect(output).toContain('Non-interactive environment');
    });
  });
});
