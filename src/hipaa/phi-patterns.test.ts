import { describe, it, expect } from 'vitest';
import { buildPhiFieldSet, DEFAULT_PHI_FIELDS } from './phi-patterns.js';

describe('DEFAULT_PHI_FIELDS', () => {
  it('includes standard HIPAA identifiers', () => {
    expect(DEFAULT_PHI_FIELDS).toContain('ssn');
    expect(DEFAULT_PHI_FIELDS).toContain('dateOfBirth');
    expect(DEFAULT_PHI_FIELDS).toContain('mrn');
    expect(DEFAULT_PHI_FIELDS).toContain('patientName');
    expect(DEFAULT_PHI_FIELDS).toContain('email');
    expect(DEFAULT_PHI_FIELDS).toContain('phone');
  });

  it('includes FHIR resource names', () => {
    expect(DEFAULT_PHI_FIELDS).toContain('Patient');
    expect(DEFAULT_PHI_FIELDS).toContain('Observation');
    expect(DEFAULT_PHI_FIELDS).toContain('MedicationRequest');
    expect(DEFAULT_PHI_FIELDS).toContain('DiagnosticReport');
  });

  it('includes clinical fields', () => {
    expect(DEFAULT_PHI_FIELDS).toContain('diagnosis');
    expect(DEFAULT_PHI_FIELDS).toContain('medication');
    expect(DEFAULT_PHI_FIELDS).toContain('labResult');
    expect(DEFAULT_PHI_FIELDS).toContain('icdCode');
  });
});

describe('buildPhiFieldSet', () => {
  it('returns defaults when no config provided', () => {
    const fields = buildPhiFieldSet();
    expect(fields.size).toBe(DEFAULT_PHI_FIELDS.length);
    for (const f of DEFAULT_PHI_FIELDS) {
      expect(fields.has(f)).toBe(true);
    }
  });

  it('returns defaults when config is empty', () => {
    const fields = buildPhiFieldSet({});
    expect(fields.size).toBe(DEFAULT_PHI_FIELDS.length);
  });

  it('merges user-defined fields with defaults', () => {
    const fields = buildPhiFieldSet({
      phiFields: ['chartId', 'encounterDate', 'providerNpi'],
    });
    // Custom fields added
    expect(fields.has('chartId')).toBe(true);
    expect(fields.has('encounterDate')).toBe(true);
    // providerNpi already in defaults
    expect(fields.has('providerNpi')).toBe(true);
    // Defaults still present
    expect(fields.has('ssn')).toBe(true);
    expect(fields.has('Patient')).toBe(true);
  });

  it('produces no duplicates when user adds existing field', () => {
    const fields = buildPhiFieldSet({
      phiFields: ['ssn', 'email', 'newField'],
    });
    // Set naturally deduplicates
    const arr = [...fields];
    const unique = new Set(arr);
    expect(arr.length).toBe(unique.size);
    // newField should be added
    expect(fields.has('newField')).toBe(true);
  });
});
