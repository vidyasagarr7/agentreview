// queue-publisher.ts — Kafka publish (runtime flow: queue-publish)
import { Kafka, Producer } from 'kafkajs';
import { PatientRecord } from './patient-service';

const kafka = new Kafka({ brokers: ['localhost:9092'] });
const producer: Producer = kafka.producer();

export async function publishPatientEvent(patient: PatientRecord) {
  await producer.connect();
  await producer.send({
    topic: 'phi-events',
    messages: [
      {
        key: patient.id,
        value: JSON.stringify({
          type: 'patient-updated',
          patientId: patient.id,
          name: patient.name,
          ssn: patient.ssn,
          dateOfBirth: patient.dateOfBirth,
          address: patient.address,
          phone: patient.phone,
        }),
      },
    ],
  });
}
