import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LensRegistry, validateLens } from './registry.js';

// Mock fs/promises for loadCustomLenses tests
vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

import { readdir, readFile } from 'fs/promises';

const mockedReaddir = vi.mocked(readdir);
const mockedReadFile = vi.mocked(readFile);

// Helper: minimal valid lens object
function validLensData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-lens',
    name: 'Test Lens',
    description: 'A test lens',
    systemPrompt: 'You are a test reviewer.',
    focusAreas: ['testing', 'quality'],
    ...overrides,
  };
}

// ─── validateLens ────────────────────────────────────────────────────────────

describe('validateLens', () => {
  it('returns a valid lens when all fields are correct', () => {
    const data = validLensData();
    const result = validateLens(data, 'test.json');
    expect(result).toEqual(data);
  });

  it('throws on null input', () => {
    expect(() => validateLens(null, 'null.json')).toThrowError(
      /must be a JSON object/
    );
  });

  it('throws on undefined input', () => {
    expect(() => validateLens(undefined, 'undef.json')).toThrowError(
      /must be a JSON object/
    );
  });

  it('throws on array input', () => {
    expect(() => validateLens([1, 2], 'arr.json')).toThrowError(
      /must be a JSON object/
    );
  });

  it('throws on primitive input', () => {
    expect(() => validateLens('string', 'str.json')).toThrowError(
      /must be a JSON object/
    );
  });

  it('throws when id is missing', () => {
    const data = validLensData();
    delete (data as Record<string, unknown>).id;
    expect(() => validateLens(data, 'no-id.json')).toThrowError(
      /missing required string field: "id"/
    );
  });

  it('throws when name is missing', () => {
    const data = validLensData();
    delete (data as Record<string, unknown>).name;
    expect(() => validateLens(data, 'no-name.json')).toThrowError(
      /missing required string field: "name"/
    );
  });

  it('throws when description is missing', () => {
    const data = validLensData();
    delete (data as Record<string, unknown>).description;
    expect(() => validateLens(data, 'no-desc.json')).toThrowError(
      /missing required string field: "description"/
    );
  });

  it('throws when systemPrompt is missing', () => {
    const data = validLensData();
    delete (data as Record<string, unknown>).systemPrompt;
    expect(() => validateLens(data, 'no-prompt.json')).toThrowError(
      /missing required string field: "systemPrompt"/
    );
  });

  it('throws when a required string field is a number instead of string', () => {
    const data = validLensData({ id: 42 });
    expect(() => validateLens(data, 'bad-id.json')).toThrowError(
      /missing required string field: "id"/
    );
  });

  it('throws when a required string field is empty string', () => {
    const data = validLensData({ name: '' });
    expect(() => validateLens(data, 'empty-name.json')).toThrowError(
      /missing required string field: "name"/
    );
  });

  it('throws when focusAreas is not an array', () => {
    const data = validLensData({ focusAreas: 'not-array' });
    expect(() => validateLens(data, 'bad-fa.json')).toThrowError(
      /focusAreas must be an array/
    );
  });

  it('throws when focusAreas is an object', () => {
    const data = validLensData({ focusAreas: { a: 1 } });
    expect(() => validateLens(data, 'obj-fa.json')).toThrowError(
      /focusAreas must be an array/
    );
  });

  it('throws when focusAreas contains non-string items', () => {
    const data = validLensData({ focusAreas: ['valid', 123, 'also-valid'] });
    expect(() => validateLens(data, 'mixed-fa.json')).toThrowError(
      /focusAreas\[1\] must be a string, got number/
    );
  });

  it('throws when focusAreas contains null items', () => {
    const data = validLensData({ focusAreas: [null] });
    expect(() => validateLens(data, 'null-fa.json')).toThrowError(
      /focusAreas\[0\] must be a string, got object/
    );
  });

  it('throws when systemPrompt exceeds 10KB', () => {
    const longPrompt = 'x'.repeat(10 * 1024 + 1);
    const data = validLensData({ systemPrompt: longPrompt });
    expect(() => validateLens(data, 'long.json')).toThrowError(
      /exceeding 10240 bytes/
    );
  });

  it('allows systemPrompt exactly at 10KB limit', () => {
    const exactPrompt = 'x'.repeat(10 * 1024);
    const data = validLensData({ systemPrompt: exactPrompt });
    const result = validateLens(data, 'exact.json');
    expect(result.systemPrompt).toHaveLength(10 * 1024);
  });

  it('allows empty focusAreas array', () => {
    const data = validLensData({ focusAreas: [] });
    const result = validateLens(data, 'empty-fa.json');
    expect(result.focusAreas).toEqual([]);
  });

  it('includes source in error messages', () => {
    expect(() => validateLens(null, '/custom/path/my-lens.json')).toThrowError(
      /\/custom\/path\/my-lens\.json/
    );
  });
});

// ─── LensRegistry ────────────────────────────────────────────────────────────

describe('LensRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // getBuiltinLenses
  describe('getBuiltinLenses', () => {
    it('returns 5 built-in lenses', () => {
      const registry = new LensRegistry();
      const lenses = registry.getBuiltinLenses();
      expect(lenses).toHaveLength(5);
    });

    it('returns correct lens IDs', () => {
      const registry = new LensRegistry();
      const ids = registry.getBuiltinLenses().map((l) => l.id);
      expect(ids).toEqual(
        expect.arrayContaining(['security', 'architecture', 'quality', 'hipaa', 'soc2'])
      );
    });

    it('returns a copy (not the internal array)', () => {
      const registry = new LensRegistry();
      const a = registry.getBuiltinLenses();
      const b = registry.getBuiltinLenses();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('built-in lenses have substantial system prompts', () => {
      const registry = new LensRegistry();
      for (const lens of registry.getBuiltinLenses()) {
        expect(lens.systemPrompt.length).toBeGreaterThan(500);
      }
    });
  });

  // loadCustomLenses
  describe('loadCustomLenses', () => {
    it('returns empty array when directory does not exist', async () => {
      mockedReaddir.mockRejectedValue(new Error('ENOENT: no such file or directory'));
      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/nonexistent');
      expect(lenses).toEqual([]);
    });

    it('loads valid JSON lens files', async () => {
      const lensData = validLensData({ id: 'custom-1', name: 'Custom One' });
      mockedReaddir.mockResolvedValue(['custom-1.json'] as any);
      mockedReadFile.mockResolvedValue(JSON.stringify(lensData));

      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/custom-lenses');
      expect(lenses).toHaveLength(1);
      expect(lenses[0].id).toBe('custom-1');
    });

    it('skips non-JSON files', async () => {
      const lensData = validLensData();
      mockedReaddir.mockResolvedValue(['readme.md', 'lens.json', 'notes.txt'] as any);
      mockedReadFile.mockResolvedValue(JSON.stringify(lensData));

      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/dir');
      expect(lenses).toHaveLength(1);
      expect(mockedReadFile).toHaveBeenCalledTimes(1);
    });

    it('skips files with invalid JSON and warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockedReaddir.mockResolvedValue(['bad.json'] as any);
      mockedReadFile.mockResolvedValue('not valid json {{{');

      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/dir');
      expect(lenses).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping custom lens bad.json'));
      warnSpy.mockRestore();
    });

    it('skips files with invalid lens structure and warns', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Valid JSON but missing required fields
      mockedReaddir.mockResolvedValue(['incomplete.json'] as any);
      mockedReadFile.mockResolvedValue(JSON.stringify({ id: 'x' }));

      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/dir');
      expect(lenses).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping custom lens incomplete.json')
      );
      warnSpy.mockRestore();
    });

    it('loads multiple valid lenses from a directory', async () => {
      const lens1 = validLensData({ id: 'a', name: 'A' });
      const lens2 = validLensData({ id: 'b', name: 'B' });
      mockedReaddir.mockResolvedValue(['a.json', 'b.json'] as any);
      mockedReadFile
        .mockResolvedValueOnce(JSON.stringify(lens1))
        .mockResolvedValueOnce(JSON.stringify(lens2));

      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/dir');
      expect(lenses).toHaveLength(2);
      expect(lenses.map((l) => l.id)).toEqual(['a', 'b']);
    });

    it('loads valid lenses even when some files are invalid', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const goodLens = validLensData({ id: 'good', name: 'Good' });
      mockedReaddir.mockResolvedValue(['bad.json', 'good.json'] as any);
      mockedReadFile
        .mockResolvedValueOnce('{{invalid json}}')
        .mockResolvedValueOnce(JSON.stringify(goodLens));

      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/dir');
      expect(lenses).toHaveLength(1);
      expect(lenses[0].id).toBe('good');
      warnSpy.mockRestore();
    });

    it('returns empty array when directory has no JSON files', async () => {
      mockedReaddir.mockResolvedValue(['readme.md', 'notes.txt'] as any);

      const registry = new LensRegistry();
      const lenses = await registry.loadCustomLenses('/dir');
      expect(lenses).toEqual([]);
    });
  });

  // getAllLenses
  describe('getAllLenses', () => {
    it('returns only builtins when no custom lenses loaded', () => {
      const registry = new LensRegistry();
      const all = registry.getAllLenses();
      expect(all).toHaveLength(5);
    });

    it('returns builtins + custom lenses after loading', async () => {
      const customLens = validLensData({ id: 'custom', name: 'Custom' });
      mockedReaddir.mockResolvedValue(['custom.json'] as any);
      mockedReadFile.mockResolvedValue(JSON.stringify(customLens));

      const registry = new LensRegistry();
      await registry.loadCustomLenses('/dir');
      const all = registry.getAllLenses();
      expect(all).toHaveLength(6);
      expect(all.map((l) => l.id)).toContain('custom');
    });

    it('returns a copy (not the internal array)', () => {
      const registry = new LensRegistry();
      const a = registry.getAllLenses();
      const b = registry.getAllLenses();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  // resolveLenses
  describe('resolveLenses', () => {
    it('"all" returns all lenses', () => {
      const registry = new LensRegistry();
      const lenses = registry.resolveLenses('all');
      expect(lenses).toHaveLength(5);
    });

    it('"all" includes custom lenses after loading', async () => {
      const customLens = validLensData({ id: 'custom', name: 'Custom' });
      mockedReaddir.mockResolvedValue(['custom.json'] as any);
      mockedReadFile.mockResolvedValue(JSON.stringify(customLens));

      const registry = new LensRegistry();
      await registry.loadCustomLenses('/dir');
      const lenses = registry.resolveLenses('all');
      expect(lenses).toHaveLength(6);
    });

    it('resolves a single known ID', () => {
      const registry = new LensRegistry();
      const lenses = registry.resolveLenses(['security']);
      expect(lenses).toHaveLength(1);
      expect(lenses[0].id).toBe('security');
    });

    it('resolves multiple known IDs', () => {
      const registry = new LensRegistry();
      const lenses = registry.resolveLenses(['security', 'hipaa', 'soc2']);
      expect(lenses).toHaveLength(3);
      expect(lenses.map((l) => l.id)).toEqual(['security', 'hipaa', 'soc2']);
    });

    it('throws on unknown lens IDs with helpful message', () => {
      const registry = new LensRegistry();
      expect(() => registry.resolveLenses(['unknown-lens'])).toThrowError(
        /Unknown lens ID\(s\): unknown-lens/
      );
    });

    it('includes available lenses in error message', () => {
      const registry = new LensRegistry();
      expect(() => registry.resolveLenses(['nope'])).toThrowError(
        /Available lenses:/
      );
    });

    it('reports all unknown IDs in error', () => {
      const registry = new LensRegistry();
      expect(() => registry.resolveLenses(['foo', 'bar'])).toThrowError(
        /foo, bar/
      );
    });

    it('throws when mix of known and unknown IDs', () => {
      const registry = new LensRegistry();
      expect(() => registry.resolveLenses(['security', 'nonexistent'])).toThrowError(
        /nonexistent/
      );
    });

    it('resolves empty array without error', () => {
      const registry = new LensRegistry();
      const lenses = registry.resolveLenses([]);
      expect(lenses).toEqual([]);
    });

    it('resolves custom lens IDs after loading', async () => {
      const customLens = validLensData({ id: 'my-custom', name: 'My Custom' });
      mockedReaddir.mockResolvedValue(['my-custom.json'] as any);
      mockedReadFile.mockResolvedValue(JSON.stringify(customLens));

      const registry = new LensRegistry();
      await registry.loadCustomLenses('/dir');
      const lenses = registry.resolveLenses(['my-custom']);
      expect(lenses).toHaveLength(1);
      expect(lenses[0].id).toBe('my-custom');
    });
  });
});
