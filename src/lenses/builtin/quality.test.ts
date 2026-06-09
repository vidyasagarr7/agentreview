import { describe, it, expect } from 'vitest';
import { qualityLens } from './quality.js';

describe('qualityLens', () => {
  it('has correct id, name, and severity', () => {
    expect(qualityLens.id).toBe('quality');
    expect(qualityLens.name).toBe('Code Quality');
    expect(qualityLens.severity).toBe('advisory');
  });

  it('system prompt mentions error handling and test coverage', () => {
    const prompt = qualityLens.systemPrompt.toLowerCase();
    expect(prompt).toContain('error handling');
    expect(prompt).toContain('test');
  });

  it('system prompt mentions readability and maintainability', () => {
    const prompt = qualityLens.systemPrompt.toLowerCase();
    expect(prompt).toContain('readability');
    expect(prompt).toContain('maintainability');
  });

  it('system prompt instructs JSON output format', () => {
    expect(qualityLens.systemPrompt).toContain('Return ONLY a JSON array');
    expect(qualityLens.systemPrompt).toContain('"id"');
    expect(qualityLens.systemPrompt).toContain('"severity"');
  });

  it('focus areas include quality-related items', () => {
    const areas = qualityLens.focusAreas.join(' ').toLowerCase();
    expect(areas).toContain('error handling');
    expect(areas).toContain('dead code');
    expect(areas).toContain('magic numbers');
  });

  it('has a substantial system prompt', () => {
    expect(qualityLens.systemPrompt.length).toBeGreaterThan(500);
  });
});
