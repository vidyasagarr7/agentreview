// Fixture: FHIR search with PHI exposure risks

import { fhirClient } from '../client';

export async function searchPatientByName(name: string) {
  // BAD: FHIR search without _elements restriction — returns full resource
  const results = await fhirClient.search(`/Patient?name=${name}`);
  return results;
}

export async function getPatientEverything(id: string) {
  // BAD: $everything returns full patient record
  const bundle = await fhirClient.get(`/Patient/${id}/$everything`);
  return bundle;
}

export async function bulkExport() {
  // BAD: Bulk $export without access controls
  const exportUrl = await fhirClient.post('/Patient/$export');
  return exportUrl;
}

export function getScopes() {
  // BAD: Overly broad SMART scope
  return { scope: 'user/*.*' };
}
