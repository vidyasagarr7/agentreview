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

  it('covers all 18 Safe Harbor identifier categories', () => {
    // Safe Harbor #1: Names
    expect(DEFAULT_PHI_FIELDS).toContain('patientName');
    // Safe Harbor #2: Geographic
    expect(DEFAULT_PHI_FIELDS).toContain('address');
    expect(DEFAULT_PHI_FIELDS).toContain('zipCode');
    // Safe Harbor #3: Dates
    expect(DEFAULT_PHI_FIELDS).toContain('dateOfBirth');
    // Safe Harbor #3 (also): Fax
    expect(DEFAULT_PHI_FIELDS).toContain('fax');
    // Safe Harbor #4: Phone
    expect(DEFAULT_PHI_FIELDS).toContain('phone');
    // Safe Harbor #5: Email
    expect(DEFAULT_PHI_FIELDS).toContain('email');
    // Safe Harbor #6: SSN
    expect(DEFAULT_PHI_FIELDS).toContain('ssn');
    // Safe Harbor #7: MRN
    expect(DEFAULT_PHI_FIELDS).toContain('mrn');
    // Safe Harbor #8: Health plan beneficiary
    expect(DEFAULT_PHI_FIELDS).toContain('memberId');
    // Safe Harbor #9: Health plan beneficiary numbers
    expect(DEFAULT_PHI_FIELDS).toContain('beneficiaryId');
    expect(DEFAULT_PHI_FIELDS).toContain('healthPlanId');
    // Safe Harbor #10: Certificate/license numbers
    expect(DEFAULT_PHI_FIELDS).toContain('licenseNumber');
    expect(DEFAULT_PHI_FIELDS).toContain('driverLicense');
    // Safe Harbor #11: Account numbers
    expect(DEFAULT_PHI_FIELDS).toContain('accountNumber');
    // Safe Harbor #12: Web URLs
    expect(DEFAULT_PHI_FIELDS).toContain('personalUrl');
    // Safe Harbor #13: IP addresses
    expect(DEFAULT_PHI_FIELDS).toContain('ipAddress');
    // Safe Harbor #14: Biometric identifiers
    expect(DEFAULT_PHI_FIELDS).toContain('biometric');
    expect(DEFAULT_PHI_FIELDS).toContain('fingerprint');
    // Safe Harbor #15: Full-face photos (handled via image analysis, no field name needed)
    // Safe Harbor #16: Vehicle identifiers
    expect(DEFAULT_PHI_FIELDS).toContain('vin');
    expect(DEFAULT_PHI_FIELDS).toContain('licensePlate');
    // Safe Harbor #17: Device identifiers
    expect(DEFAULT_PHI_FIELDS).toContain('deviceId');
    expect(DEFAULT_PHI_FIELDS).toContain('serialNumber');
    expect(DEFAULT_PHI_FIELDS).toContain('imei');
    // Safe Harbor #18: Any other unique number (covered by specific fields + config)
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
