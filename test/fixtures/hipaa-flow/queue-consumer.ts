// queue-consumer.ts — Kafka subscribe + log (sink via queue)
import { Kafka, Consumer } from 'kafkajs';

const kafka = new Kafka({ brokers: ['localhost:9092'] });
const consumer: Consumer = kafka.consumer({ groupId: 'phi-processor' });

export async function startConsumer() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'phi-events', fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const payload = JSON.parse(message.value?.toString() ?? '{}');
      console.log('[PHI-EVENT]', {
        topic,
        partition,
        patientId: payload.patientId,
        name: payload.name,
        ssn: payload.ssn,
        fullPayload: payload,
      });
    },
  });
}
