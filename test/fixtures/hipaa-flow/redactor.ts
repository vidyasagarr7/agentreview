// redactor.ts — PHI redaction utility (safe pattern)

const PHI_FIELDS = ['ssn', 'dateOfBirth', 'address', 'phone', 'name'];

export function redactPhi(data: Record<string, any>): Record<string, any> {
  const redacted = { ...data };
  for (const field of PHI_FIELDS) {
    if (field in redacted) {
      redacted[field] = '[REDACTED]';
    }
  }
  return redacted;
}

export function stripPhi(data: Record<string, any>): Record<string, any> {
  const stripped = { ...data };
  for (const field of PHI_FIELDS) {
    delete stripped[field];
  }
  return stripped;
}

export function isRedacted(data: Record<string, any>): boolean {
  return PHI_FIELDS.every(
    (field) => !(field in data) || data[field] === '[REDACTED]',
  );
}
