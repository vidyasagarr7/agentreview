import { describe, it, expect } from 'vitest';
import { architectureLens } from './architecture.js';

describe('architectureLens', () => {
  it('has correct id, name, and severity', () => {
    expect(architectureLens.id).toBe('architecture');
    expect(architectureLens.name).toBe('Architecture');
    expect(architectureLens.severity).toBe('normal');
  });

  it('system prompt mentions SOLID and coupling', () => {
    expect(architectureLens.systemPrompt).toContain('SOLID');
    const prompt = architectureLens.systemPrompt.toLowerCase();
    expect(prompt).toContain('coupling');
  });

  it('system prompt mentions scalability', () => {
    const prompt = architectureLens.systemPrompt.toLowerCase();
    expect(prompt).toContain('scalability');
  });

  it('system prompt instructs JSON output format', () => {
    expect(architectureLens.systemPrompt).toContain('Return ONLY a JSON array');
    expect(architectureLens.systemPrompt).toContain('"id"');
    expect(architectureLens.systemPrompt).toContain('"severity"');
  });

  it('focus areas include architecture-related items', () => {
    const areas = architectureLens.focusAreas.join(' ').toLowerCase();
    expect(areas).toContain('solid');
    expect(areas).toContain('coupling');
    expect(areas).toContain('circular dependencies');
  });

  it('has a substantial system prompt', () => {
    expect(architectureLens.systemPrompt.length).toBeGreaterThan(500);
  });
});
