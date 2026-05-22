// analytics-sender.ts — Mixpanel analytics (sink: analytics, no BAA)
import Mixpanel from 'mixpanel';
import { getPatient, PatientRecord } from './patient-service';

const mixpanel = Mixpanel.init('YOUR_MIXPANEL_TOKEN');

export async function trackPatientView(patientId: string) {
  const patient = await getPatient(patientId);

  mixpanel.track('Patient Viewed', {
    distinct_id: patient.id,
    patient_name: patient.name,
    patient_ssn: patient.ssn,
    date_of_birth: patient.dateOfBirth,
    diagnosis_count: patient.diagnosis.length,
    timestamp: new Date().toISOString(),
  });
}

export function trackPatientEvent(event: string, patient: PatientRecord) {
  mixpanel.track(event, {
    distinct_id: patient.id,
    patient_name: patient.name,
    address: patient.address,
    phone: patient.phone,
  });
}
