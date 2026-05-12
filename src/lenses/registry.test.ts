import { describe, it, expect } from 'vitest';
import { LensRegistry } from './registry.js';

describe('LensRegistry', () => {
  it('returns 3 built-in lenses', () => {
    const registry = new LensRegistry();
    const lenses = registry.getBuiltinLenses();
    expect(lenses).toHaveLength(3);
  });

  it('built-in lens IDs are correct', () => {
    const registry = new LensRegistry();
    const ids = registry.getBuiltinLenses().map((l) => l.id);
    expect(ids).toContain('security');
    expect(ids).toContain('architecture');
    expect(ids).toContain('quality');
  });

  it('built-in lenses have substantial system prompts', () => {
    const registry = new LensRegistry();
    for (const lens of registry.getBuiltinLenses()) {
      expect(lens.systemPrompt.length).toBeGreaterThan(500);
    }
  });

  it('resolveLenses("all") returns all 3 built-ins', () => {
    const registry = new LensRegistry();
    const lenses = registry.resolveLenses('all');
    expect(lenses).toHaveLength(3);
  });

  it('resolveLenses(["security"]) returns 1 lens', () => {
    const registry = new LensRegistry();
    const lenses = registry.resolveLenses(['security']);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].id).toBe('security');
  });

  it('resolveLenses with unknown ID throws with helpful message', () => {
    const registry = new LensRegistry();
    expect(() => registry.resolveLenses(['unknown-lens'])).toThrowError(/Available lenses/);
  });

  it('resolveLenses includes unknown ID in error message', () => {
    const registry = new LensRegistry();
    expect(() => registry.resolveLenses(['mystery-lens'])).toThrowError(/mystery-lens/);
  });

  it('loadCustomLenses returns empty array for non-existent directory', async () => {
    const registry = new LensRegistry();
    const lenses = await registry.loadCustomLenses('/tmp/nonexistent-dir-12345');
    expect(lenses).toEqual([]);
  });
});
