import { describe, it, expect } from 'vitest';
import { hipaaLens } from './hipaa.js';

describe('hipaaLens', () => {
  it('has correct id, name, and severity', () => {
    expect(hipaaLens.id).toBe('hipaa');
    expect(hipaaLens.name).toBe('HIPAA Compliance');
    expect(hipaaLens.severity).toBe('strict');
  });

  it('system prompt mentions PHI and HIPAA', () => {
    expect(hipaaLens.systemPrompt).toContain('PHI');
    expect(hipaaLens.systemPrompt).toContain('HIPAA');
  });

  it('system prompt mentions Privacy Rule and Security Rule', () => {
    expect(hipaaLens.systemPrompt).toContain('Privacy Rule');
    expect(hipaaLens.systemPrompt).toContain('Security Rule');
  });

  it('system prompt mentions Safe Harbor and de-identification', () => {
    expect(hipaaLens.systemPrompt).toContain('Safe Harbor');
    expect(hipaaLens.systemPrompt).toContain('de-identification');
  });

  it('system prompt instructs JSON output format', () => {
    expect(hipaaLens.systemPrompt).toContain('Return ONLY a JSON array');
    expect(hipaaLens.systemPrompt).toContain('"id"');
    expect(hipaaLens.systemPrompt).toContain('"severity"');
  });

  it('focus areas include PHI-related items', () => {
    const areas = hipaaLens.focusAreas.join(' ').toLowerCase();
    expect(areas).toContain('phi');
    expect(areas).toContain('audit');
    expect(areas).toContain('de-identification');
    expect(areas).toContain('fhir');
  });

  it('has a substantial system prompt', () => {
    expect(hipaaLens.systemPrompt.length).toBeGreaterThan(500);
  });
});
