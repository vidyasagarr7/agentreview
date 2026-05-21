import type { HipaaConfig } from '../config/repo-config.js';

// ─── Default PHI Field Names ──────────────────────────────────────────────────
// Based on HIPAA Safe Harbor 18 identifiers + healthcare-specific fields

export const DEFAULT_PHI_FIELDS = [
  // Direct identifiers (Safe Harbor #1 — Names)
  'patientName', 'patient_name', 'firstName', 'lastName', 'fullName',
  // Safe Harbor #2 — Geographic (smaller than state)
  'address', 'zipCode', 'zip',
  // Safe Harbor #3 — Dates (except year)
  'dateOfBirth', 'dob', 'birthDate', 'birth_date',
  // Safe Harbor #3 — Fax
  'fax', 'faxNumber', 'fax_number',
  // Safe Harbor #4 — Phone
  'phone', 'phoneNumber',
  // Safe Harbor #5 — Email
  'email',
  // Safe Harbor #6 — SSN
  'ssn', 'socialSecurityNumber', 'social_security',
  // Safe Harbor #7 — MRN
  'mrn', 'medicalRecordNumber', 'medical_record_number',
  // Safe Harbor #8 — Health plan beneficiary
  'memberId', 'member_id', 'subscriberId',
  // Safe Harbor #9 — Health plan beneficiary numbers
  'beneficiaryId', 'beneficiary_id', 'healthPlanId', 'health_plan_id',
  // Safe Harbor #10 — Certificate/license numbers
  'licenseNumber', 'license_number', 'certificateNumber', 'certificate_number',
  'driverLicense', 'drivers_license',
  // Safe Harbor #11 — Account numbers
  'accountNumber', 'account_number', 'bankAccount', 'bank_account',
  // Safe Harbor #12 — Web URLs
  'personalUrl', 'personal_url', 'profileUrl', 'profile_url',
  // Safe Harbor #13 — IP addresses
  'ipAddress', 'ip_address', 'clientIp', 'client_ip', 'remoteAddr', 'remote_addr',
  // Safe Harbor #14 — Biometric identifiers
  'biometric', 'fingerprint', 'faceId', 'retinalScan', 'voicePrint',
  // Safe Harbor #15 — Full-face photos (handled via image analysis, not field names)
  // Safe Harbor #16 — Vehicle identifiers
  'vin', 'vehicleId', 'vehicle_id', 'licensePlate', 'license_plate',
  // Safe Harbor #17 — Device identifiers
  'deviceId', 'device_id', 'serialNumber', 'serial_number', 'udid', 'imei',
  // Safe Harbor #18 — Any other unique identifying number
  // (covered by specific fields above and project-specific phiFields config)
  // Clinical
  'diagnosis', 'icdCode', 'icd_code', 'cptCode', 'cpt_code',
  'medication', 'prescription', 'labResult', 'lab_result',
  'procedure', 'treatment', 'condition',
  // FHIR resources
  'Patient', 'Condition', 'Observation', 'MedicationRequest',
  'DiagnosticReport', 'Encounter', 'AllergyIntolerance',
  'Immunization', 'Procedure', 'CarePlan',
  // Insurance
  'insuranceId', 'insurance_id', 'policyNumber', 'groupNumber',
  'npi', 'providerNpi',
];

// ─── Build PHI Field Set ──────────────────────────────────────────────────────

/**
 * Build a merged set of PHI field names from defaults + user-defined fields.
 */
export function buildPhiFieldSet(config?: HipaaConfig): Set<string> {
  const fields = new Set(DEFAULT_PHI_FIELDS);

  if (config?.phiFields) {
    for (const field of config.phiFields) {
      fields.add(field);
    }
  }

  return fields;
}
