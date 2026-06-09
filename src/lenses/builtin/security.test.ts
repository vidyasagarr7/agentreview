import { describe, it, expect } from 'vitest';
import { securityLens } from './security.js';

describe('securityLens', () => {
  it('has correct id, name, and severity', () => {
    expect(securityLens.id).toBe('security');
    expect(securityLens.name).toBe('Security');
    expect(securityLens.severity).toBe('strict');
  });

  it('system prompt covers OWASP categories', () => {
    expect(securityLens.systemPrompt).toContain('Broken Access Control');
    expect(securityLens.systemPrompt).toContain('Cryptographic Failures');
    expect(securityLens.systemPrompt).toContain('Injection');
  });

  it('system prompt mentions injection and authentication', () => {
    const prompt = securityLens.systemPrompt.toLowerCase();
    expect(prompt).toContain('injection');
    expect(prompt).toContain('authentication');
  });

  it('system prompt instructs JSON output format', () => {
    expect(securityLens.systemPrompt).toContain('Return ONLY a JSON array');
    expect(securityLens.systemPrompt).toContain('"id"');
    expect(securityLens.systemPrompt).toContain('"severity"');
  });

  it('focus areas include security-related items', () => {
    const areas = securityLens.focusAreas.join(' ').toLowerCase();
    expect(areas).toContain('injection');
    expect(areas).toContain('authentication');
    expect(areas).toContain('secrets');
    expect(areas).toContain('csrf');
  });

  it('has a substantial system prompt', () => {
    expect(securityLens.systemPrompt.length).toBeGreaterThan(500);
  });
});
