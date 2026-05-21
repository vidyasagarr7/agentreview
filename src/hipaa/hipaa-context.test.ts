import { describe, it, expect } from 'vitest';
import { buildHipaaContext } from '../lenses/builtin/hipaa.js';

describe('buildHipaaContext', () => {
  it('produces context string with defaults when no config provided', () => {
    const context = buildHipaaContext();
    expect(context).toContain('## BAA Registry');
    expect(context).toContain('*.amazonaws.com');
    expect(context).toContain('api.openai.com');
    expect(context).toContain('MUST NOT be transmitted');
  });

  it('includes BAA covered list', () => {
    const context = buildHipaaContext({
      baaCovered: ['api.custom-health.com'],
    });
    expect(context).toContain('api.custom-health.com');
    expect(context).toContain('signed Business Associate Agreements');
  });

  it('includes no-BAA list', () => {
    const context = buildHipaaContext({
      noBaa: ['*.sketchy-api.com'],
    });
    expect(context).toContain('*.sketchy-api.com');
    expect(context).toContain('do NOT have BAAs');
  });

  it('includes custom PHI fields when provided', () => {
    const context = buildHipaaContext({
      phiFields: ['chartId', 'encounterDate'],
    });
    expect(context).toContain('## Project-Specific PHI Fields');
    expect(context).toContain('`chartId`');
    expect(context).toContain('`encounterDate`');
  });

  it('does not show project-specific PHI section when only default fields exist', () => {
    const context = buildHipaaContext({});
    expect(context).not.toContain('## Project-Specific PHI Fields');
  });

  it('includes PHI source file patterns when provided', () => {
    const context = buildHipaaContext({
      phiSources: ['src/services/patient/**', 'src/fhir/**'],
    });
    expect(context).toContain('## PHI Source Files');
    expect(context).toContain('`src/services/patient/**`');
    expect(context).toContain('`src/fhir/**`');
  });

  it('does not show PHI source section when no sources provided', () => {
    const context = buildHipaaContext({});
    expect(context).not.toContain('## PHI Source Files');
  });

  it('includes enforcement rules', () => {
    const context = buildHipaaContext();
    expect(context).toContain('Flag any PHI transmission');
    expect(context).toContain('unknown BAA status');
  });
});
