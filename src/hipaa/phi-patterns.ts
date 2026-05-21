import type { HipaaConfig } from '../config/repo-config.js';

// ─── Default PHI Field Names ──────────────────────────────────────────────────
// Based on HIPAA Safe Harbor 18 identifiers + healthcare-specific fields

export const DEFAULT_PHI_FIELDS = [
  // Direct identifiers
  'patientName', 'patient_name', 'firstName', 'lastName', 'fullName',
  'dateOfBirth', 'dob', 'birthDate', 'birth_date',
  'ssn', 'socialSecurityNumber', 'social_security',
  'mrn', 'medicalRecordNumber', 'medical_record_number',
  'memberId', 'member_id', 'subscriberId',
  // Contact info
  'email', 'phone', 'phoneNumber', 'address', 'zipCode', 'zip',
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

// ─── External Sink Patterns ───────────────────────────────────────────────────
// Patterns that suggest external API calls or data sinks

export const EXTERNAL_SINK_PATTERNS = [
  'fetch(', 'axios.', 'http.request', 'https.request',
  '.post(', '.put(', '.patch(',
  'request(', 'got(', 'ky.',
  'sendgrid', 'twilio', 'sns.publish', 'sqs.sendMessage',
  'kafka.produce', 'rabbitmq', 'amqp',
  'console.log', 'console.error', 'logger.', 'log.',
  'analytics.track', 'mixpanel.track', 'segment.track',
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
