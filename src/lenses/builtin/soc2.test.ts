import { describe, it, expect } from 'vitest';
import { soc2Lens } from './soc2.js';

describe('soc2Lens', () => {
  it('has correct id, name, and severity', () => {
    expect(soc2Lens.id).toBe('soc2');
    expect(soc2Lens.name).toBe('SOC 2 Compliance');
    expect(soc2Lens.severity).toBe('strict');
  });

  it('system prompt mentions SOC 2 and Trust Service Criteria', () => {
    expect(soc2Lens.systemPrompt).toContain('SOC 2');
    expect(soc2Lens.systemPrompt).toContain('Trust Service Criteria');
  });

  it('system prompt covers all 5 Trust Service Criteria', () => {
    expect(soc2Lens.systemPrompt).toContain('Security');
    expect(soc2Lens.systemPrompt).toContain('Availability');
    expect(soc2Lens.systemPrompt).toContain('Processing Integrity');
    expect(soc2Lens.systemPrompt).toContain('Confidentiality');
    expect(soc2Lens.systemPrompt).toContain('Privacy');
  });

  it('system prompt instructs JSON output format', () => {
    expect(soc2Lens.systemPrompt).toContain('Return ONLY a JSON array');
    expect(soc2Lens.systemPrompt).toContain('"id"');
    expect(soc2Lens.systemPrompt).toContain('"severity"');
  });

  it('has a substantial system prompt', () => {
    expect(soc2Lens.systemPrompt.length).toBeGreaterThan(500);
  });
});
