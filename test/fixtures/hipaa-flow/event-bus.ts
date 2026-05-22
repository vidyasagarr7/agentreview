// event-bus.ts — EventEmitter for patient events (runtime flow: event-emit)
import { EventEmitter } from 'events';
import { PatientRecord } from './patient-service';

export const patientEvents = new EventEmitter();

export function emitPatientUpdated(patient: PatientRecord) {
  patientEvents.emit('patient-updated', {
    patientId: patient.id,
    name: patient.name,
    ssn: patient.ssn,
    dateOfBirth: patient.dateOfBirth,
    address: patient.address,
    updatedAt: new Date().toISOString(),
  });
}

export function onPatientUpdated(handler: (data: any) => void) {
  patientEvents.on('patient-updated', handler);
}
