// Fixture: HIPAA violations in patient service

import { db } from '../db';
import { httpClient } from '../http';

interface Patient {
  id: string;
  ssn: string;
  name: string;
  dob: string;
  mrn: string;
}

export async function getPatient(id: string): Promise<Patient> {
  // BAD: Logging PHI directly
  const patient = await db.query(`SELECT * FROM patients WHERE id = $1`, [id]);
  console.log(patient.ssn);

  // BAD: Broad SQL query exposes all columns including PHI
  const allPatients = await db.query(`SELECT * FROM patients`);

  // BAD: Internal FHIR API call without audit
  const fhirData = await httpClient.get(`http://api.internal/fhir/Patient/${id}`);

  return patient;
}

export async function updatePatient(id: string, data: Partial<Patient>): Promise<void> {
  await db.query(`UPDATE patients SET name = $1 WHERE id = $2`, [data.name, id]);
}
