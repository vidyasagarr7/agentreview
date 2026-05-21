// Fixture: HL7 parser with PHI logging violations

import { HL7Parser } from '../lib/hl7';

interface HL7Message {
  raw: string;
  segments: Record<string, unknown>;
}

export function parseMessage(rawData: string): HL7Message {
  const hl7Message = HL7Parser.parse(rawData);

  // BAD: Logging entire HL7 message (contains PID, insurance, diagnosis)
  console.log(hl7Message);

  return hl7Message;
}

export function extractPatientId(message: HL7Message): string {
  // BAD: Raw PID segment with pipe delimiters
  const example = 'PID|1||MRN123^^^HOSP||DOE^JOHN||19800101|M';

  const pid = message.segments['PID'];
  return String(pid);
}

export function processADT(raw: string): void {
  const parsed = HL7Parser.parse(raw);
  // Safe: no logging of parsed data
  const eventType = parsed.segments['MSH']?.['9'];
  if (eventType === 'A01') {
    // handle admit
  }
}
