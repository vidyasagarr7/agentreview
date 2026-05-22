import { describe, it, expect } from 'vitest';
import { detectRuntimeFlows } from './runtime-detector.js';

describe('detectRuntimeFlows', () => {
  it('detects EventEmitter emit + on with channel name', () => {
    const source = `
const emitter = new EventEmitter();
emitter.emit('patient-updated', data);
emitter.on('patient-updated', (d) => handle(d));
`;
    const flows = detectRuntimeFlows('test.ts', source);
    const emit = flows.find(f => f.type === 'event-emit');
    const listen = flows.find(f => f.type === 'event-listen');

    expect(emit).toBeDefined();
    expect(emit!.channel).toBe('patient-updated');
    expect(emit!.line).toBeGreaterThan(0);

    expect(listen).toBeDefined();
    expect(listen!.channel).toBe('patient-updated');
  });

  it('detects Express middleware chain', () => {
    const source = `
app.use('/api/patients', authMiddleware);
router.get('/patients/:id', (req, res, next) => {
  next();
});
router.post('/patients', createHandler);
`;
    const flows = detectRuntimeFlows('routes.ts', source);
    const middlewares = flows.filter(f => f.type === 'middleware-chain');

    // app.use, router.get, next(), router.post
    expect(middlewares.length).toBeGreaterThanOrEqual(3);
  });

  it('detects Kafka producer.send + consumer.run with topic', () => {
    const source = `
await producer.send({
  topic: 'phi-events',
  messages: [{ value: JSON.stringify(record) }],
});
await consumer.run({
  topic: 'phi-events',
  eachMessage: async ({ message }) => { process(message); },
});
`;
    const flows = detectRuntimeFlows('kafka.ts', source);
    const pub = flows.find(f => f.type === 'queue-publish');
    const sub = flows.find(f => f.type === 'queue-subscribe');

    expect(pub).toBeDefined();
    expect(pub!.channel).toBe('phi-events');

    expect(sub).toBeDefined();
    expect(sub!.channel).toBe('phi-events');
  });

  it('detects Redis publish/subscribe', () => {
    const source = `
redis.publish('patient-channel', JSON.stringify(data));
redis.subscribe('patient-channel', (msg) => handle(msg));
`;
    const flows = detectRuntimeFlows('redis.ts', source);
    const pub = flows.find(f => f.type === 'queue-publish');
    const sub = flows.find(f => f.type === 'queue-subscribe');

    expect(pub).toBeDefined();
    expect(pub!.channel).toBe('patient-channel');

    expect(sub).toBeDefined();
    expect(sub!.channel).toBe('patient-channel');
  });

  it('returns empty array when no patterns found', () => {
    const source = `
const x = 1 + 2;
console.log('hello world');
function add(a: number, b: number) { return a + b; }
`;
    const flows = detectRuntimeFlows('plain.ts', source);
    expect(flows).toEqual([]);
  });

  it('detects nested patterns (emit inside middleware)', () => {
    const source = `
app.use('/webhook', (req, res, next) => {
  emitter.emit('webhook-received', req.body);
  next();
});
`;
    const flows = detectRuntimeFlows('nested.ts', source);
    const types = flows.map(f => f.type);

    expect(types).toContain('middleware-chain');
    expect(types).toContain('event-emit');
  });

  it('detects dynamic channel names', () => {
    const source = `
const channel = getChannelName();
emitter.emit(channel, data);
`;
    const flows = detectRuntimeFlows('dynamic.ts', source);
    const emit = flows.find(f => f.type === 'event-emit');

    expect(emit).toBeDefined();
    expect(emit!.channel).toBe('<dynamic>');
  });

  it('detects Asymmetrik FHIR server patterns', () => {
    const source = `
import { FhirServer } from '@asymmetrik/node-fhir-server-core';
const server = new FhirServer(config);
`;
    const flows = detectRuntimeFlows('fhir-server.ts', source);
    const middlewares = flows.filter(f => f.type === 'middleware-chain');

    // FhirServer class + @asymmetrik/node-fhir-server-core import
    expect(middlewares.length).toBeGreaterThanOrEqual(2);
  });

  it('detects Medplum patterns', () => {
    const source = `
import { MedplumClient } from '@medplum/core';
const client = new MedplumClient({ baseUrl: 'https://api.medplum.com' });
`;
    const flows = detectRuntimeFlows('medplum.ts', source);
    const middlewares = flows.filter(f => f.type === 'middleware-chain');

    // MedplumClient class + @medplum/core import
    expect(middlewares.length).toBeGreaterThanOrEqual(2);
  });

  it('detects fhirclient patterns', () => {
    const source = `
import fhirclient from 'fhirclient';
const client = fhirclient(settings);
`;
    const flows = detectRuntimeFlows('smart.ts', source);
    const middlewares = flows.filter(f => f.type === 'middleware-chain');

    expect(middlewares.length).toBeGreaterThanOrEqual(1);
  });
});
