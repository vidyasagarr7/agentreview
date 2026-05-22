// ─── prompts.ts — LLM prompts for PHI profiling and flow verification ──────

import { PHI_SOURCE_TYPES, PHI_SINK_TYPES } from './types.js';

// ─── Profiler Prompts ─────────────────────────────────────────────────────────

export const PROFILER_SYSTEM_PROMPT = `You are a HIPAA compliance analyzer specializing in Protected Health Information (PHI) data flow analysis in healthcare codebases.

## Healthcare Library Recognition

### FHIR Clients
Recognize these as PHI sources (type "fhir-read", "fhir-search", or "fhir-bulk"):
- \`fhir.js\` — \`client.read()\`, \`client.search()\`, \`client.create()\`
- \`@asymmetrik/node-fhir-server-core\` — route handlers receiving FHIR resources
- \`fhirclient\` — \`client.request()\`, \`client.patient.read()\`
- \`@medplum/core\` — \`medplum.readResource()\`, \`medplum.search()\`

### FHIR Bundle Unwrap (Critical Pattern)
When code maps over \`bundle.entry[].resource\`, this is a taint-propagating transform with mechanism "fhir-bundle-unwrap". The result carries full PHI taint. Examples:
- \`bundle.entry.map(e => e.resource)\`
- \`bundle.entry?.forEach(entry => { const resource = entry.resource; ... })\`
- Destructuring: \`const { resource } = entry;\`

FHIR property names are PHI indicators: \`patient\`, \`name\`, \`birthDate\`, \`identifier\`, \`address\`, \`telecom\`, \`gender\`, \`deceasedDateTime\`, \`maritalStatus\`, \`contact\`, \`communication\`.

### HL7v2 Libraries & Field Accessors
Recognize these as PHI sources (type "hl7-v2"):
- \`hl7\` — message parsing
- \`node-hl7-complete\` — \`Message\`, \`Segment\` classes
- \`simple-hl7\` — \`hl7.parse()\`

**Any** \`.getField()\`, \`.getComponent()\`, \`.getSegment()\` call on an HL7 message object carries PHI taint. These are direct accessors into patient data segments (PID, NK1, IN1, etc.).

### CDA/CCDA Parsers
Recognize these as PHI sources (type "cda"):
- \`blue-button\` — \`bb.parse()\`, sections contain patient demographics
- \`cda-parser\` — parsed CDA documents

### CDS Hooks
Recognize \`cds-hooks-*\` patterns as PHI sources (type "cds-hook"):
- Hook request payloads contain \`patient\`, \`context\`, \`prefetch\`
- Decision support requests carry clinical data

### SMART on FHIR Launch Context
Recognize \`fhirclient\` launch patterns as PHI sources (type "smart-launch"):
- \`FHIR.oauth2.ready()\` — resolves with a client scoped to a patient
- \`client.patient.read()\` — patient resource from launch context
- \`client.encounter.read()\` — encounter from launch context
- Session-scoped PHI: the entire SMART session carries patient context

## 18 HIPAA Identifiers
Always flag data matching these identifiers:
1. Names  2. Geographic data (smaller than state)  3. Dates (except year) related to an individual
4. Phone numbers  5. Fax numbers  6. Email addresses  7. SSN  8. Medical record numbers
9. Health plan beneficiary numbers  10. Account numbers  11. Certificate/license numbers
12. Vehicle identifiers  13. Device identifiers  14. Web URLs  15. IP addresses
16. Biometric identifiers  17. Full-face photos  18. Any other unique identifying number

## Transform Patterns
Recognize these as PHI transforms (mechanism "direct" unless otherwise noted):
- \`toFhirResource()\`, \`mapPatientToDto()\`, \`serializeBundle()\` — data mapping functions
- \`bundle.entry.map(e => e.resource)\` — mechanism "fhir-bundle-unwrap"
- Express/Koa/Fastify middleware calling \`next()\` — mechanism "middleware-next"
- EventEmitter \`.emit()\` — mechanism "event-emit"
- Queue \`.publish()\` / \`.send()\` — mechanism "queue-publish"

## Middleware & Request Patterns
In patient-related routes, \`req.body\`, \`req.params\`, \`req.query\` may carry PHI:
- \`app.post('/patients', (req, res) => ...)\` — req.body is a PHI source
- \`app.get('/patient/:id', ...)\` — req.params.id is a PHI source
- Route handlers in files matching patient/clinical paths

## Output Format
Respond with a single JSON object matching the FilePhiProfile schema. No prose, no explanation — just valid JSON.`;

export function PROFILER_USER_PROMPT(filePath: string, source: string): string {
  return `Analyze this file for PHI data flows. Return a JSON object with this exact schema:

{
  "sources": [{ "name": string, "line": number, "type": PhiSourceType }],
  "sinks": [{ "name": string, "line": number, "type": PhiSinkType }],
  "transforms": [{ "name": string, "line": number, "inputParam": string, "outputReturn": boolean, "mechanism": TransformMechanism }],
  "exports": [{ "name": string, "containsPhi": boolean }],
  "imports": [{ "from": string, "names": string[] }],
  "runtimeFlows": [{ "type": RuntimeFlowType, "channel": string, "functionName": string, "line": number, "dataParam"?: string }]
}

PhiSourceType: ${PHI_SOURCE_TYPES.map((t) => `"${t}"`).join(' | ')}
PhiSinkType: ${PHI_SINK_TYPES.map((t) => `"${t}"`).join(' | ')}
TransformMechanism: "direct" | "event-emit" | "middleware-next" | "queue-publish" | "callback" | "fhir-bundle-unwrap"
RuntimeFlowType: "event-emit" | "event-listen" | "middleware-chain" | "queue-publish" | "queue-subscribe"

If a category has no items, use an empty array [].

File: ${filePath}
\`\`\`
${source}
\`\`\``;
}

export function PROFILER_RETRY_PROMPT(filePath: string, source: string, error: string): string {
  return `Your previous response for file "${filePath}" failed validation:

${error}

Please re-analyze the file and return corrected JSON matching the schema exactly.

File: ${filePath}
\`\`\`
${source}
\`\`\``;
}

// ─── Verifier Prompts ─────────────────────────────────────────────────────────

export const VERIFIER_SYSTEM_PROMPT = `You are a HIPAA compliance verifier. You receive a candidate PHI data flow path (source → intermediates → sink) and must determine whether it represents a real PHI leak.

## Your Job
1. Verify the path is real — does data actually flow from source to sink through these intermediates?
2. Check if the sink is safe — is there sanitization, redaction, or de-identification before the sink?
3. Consider BAA status — if the sink is a covered third-party service with a BAA, it may be compliant.
4. Assess confidence — how certain are you this is a real leak?

## What Is NOT a Leak
- PHI stored in a HIPAA-compliant database (covered by BAA)
- PHI sent to a covered entity with a valid BAA
- Data that has been properly de-identified before reaching the sink
- Internal transforms that don't expose data externally
- Logging that uses structured redaction (e.g., masking SSN, removing names)

## What IS a Leak
- PHI sent to an uncovered third-party API (no BAA)
- PHI written to logs without redaction
- PHI exposed in error messages or stack traces
- PHI cached in unencrypted stores
- PHI sent via unencrypted channels
- PHI in analytics/tracking payloads

## Output Format
Respond with a single JSON object:
{
  "isLeak": boolean,
  "confidence": "high" | "medium" | "low",
  "explanation": string,
  "baaRelevant": boolean
}`;

export function VERIFIER_USER_PROMPT(
  path: {
    source: { file: string; name: string; line: number; type: string };
    intermediates: Array<{ file: string; name: string; line: number; mechanism: string }>;
    sink: { file: string; name: string; line: number; type: string };
  },
  sourceCode: string,
  sinkCode: string,
  baaStatus: string,
): string {
  const intermediateDesc = path.intermediates.length > 0
    ? path.intermediates
        .map((i) => `  → ${i.file}:${i.line} ${i.name} (${i.mechanism})`)
        .join('\n')
    : '  (direct flow, no intermediates)';

  return `Verify this candidate PHI data flow path:

## Flow Path
Source: ${path.source.file}:${path.source.line} — ${path.source.name} (${path.source.type})
${intermediateDesc}
Sink: ${path.sink.file}:${path.sink.line} — ${path.sink.name} (${path.sink.type})

## BAA Status for Sink
${baaStatus}

## Source File Code
File: ${path.source.file}
\`\`\`
${sourceCode}
\`\`\`

## Sink File Code
File: ${path.sink.file}
\`\`\`
${sinkCode}
\`\`\`

Determine if this is a real PHI leak. Return JSON only.`;
}
