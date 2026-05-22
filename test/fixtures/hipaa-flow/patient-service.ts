// patient-service.ts — FHIR read (PHI source)
import Client from 'fhirclient';

const fhirClient = Client({ serverUrl: 'https://fhir.example.com/r4' });

export interface PatientRecord {
  id: string;
  name: string;
  ssn: string;
  dateOfBirth: string;
  address: string;
  phone: string;
  diagnosis: string[];
}

export async function getPatient(patientId: string): Promise<PatientRecord> {
  const resource = await fhirClient.request(`Patient/${patientId}`);
  return {
    id: resource.id,
    name: `${resource.name?.[0]?.given?.join(' ')} ${resource.name?.[0]?.family}`,
    ssn: resource.identifier?.find((i: any) => i.system === 'http://hl7.org/fhir/sid/us-ssn')?.value ?? '',
    dateOfBirth: resource.birthDate,
    address: resource.address?.[0]?.text ?? '',
    phone: resource.telecom?.find((t: any) => t.system === 'phone')?.value ?? '',
    diagnosis: [],
  };
}
