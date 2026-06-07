import { describe, it, expect, beforeEach } from 'vitest';
import { auditTrailScanner } from './audit-trail.js';
import { type ScannerOptions } from './types.js';
import { buildPhiFieldSet } from '../phi-patterns.js';

describe('audit-trail scanner', () => {
  let options: ScannerOptions;

  beforeEach(() => {
    options = { phiFields: buildPhiFieldSet(), skipTests: true };
  });

  // ── 2.1 Routes Without Audit ──────────────────────────────────────

  describe('routes without audit', () => {
    it('flags Express GET /patients/:id with DB call, no audit → HIGH', () => {
      const code = [
        `router.get('/patients/:id', async (req, res) => {`,
        `  const patient = await Patient.findById(req.params.id);`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      // Route detector + DB detector both fire
      expect(findings.length).toBeGreaterThanOrEqual(1);
      const routeFindings = findings.filter(f => f.category === 'Route Without Audit Trail');
      expect(routeFindings).toHaveLength(1);
      expect(routeFindings[0].severity).toBe('HIGH');
      expect(routeFindings[0].scannerId).toBe('audit-trail');
    });

    it('flags Express POST /patients with DB write, no audit → HIGH', () => {
      const code = [
        `router.post('/patients', async (req, res) => {`,
        `  const patient = await Patient.create(req.body);`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      const routeFindings = findings.filter(f => f.category === 'Route Without Audit Trail');
      expect(routeFindings).toHaveLength(1);
      expect(routeFindings[0].severity).toBe('HIGH');
    });

    it('allows route with auditLog.record nearby → no finding', () => {
      const code = [
        `router.get('/patients/:id', async (req, res) => {`,
        `  const patient = await Patient.findById(req.params.id);`,
        `  await auditLog.record({ action: 'read', userId: req.user.id, resource: 'Patient', timestamp: Date.now(), ip: req.ip });`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows route with auditMiddleware in handler args → no finding', () => {
      const code = [
        `router.get('/patients/:id', auditMiddleware, async (req, res) => {`,
        `  const patient = await Patient.findById(req.params.id);`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags Fastify GET /fhir/Patient/:id without audit → HIGH', () => {
      const code = [
        `fastify.get('/fhir/Patient/:id', async (request, reply) => {`,
        `  const resource = await fhirClient.read('Patient', request.params.id);`,
        `  return resource;`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/fhir.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings.length).toBeGreaterThanOrEqual(1);
    });

    it('skips route with non-PHI path → no finding', () => {
      const code = [
        `router.get('/config', async (req, res) => {`,
        `  const config = await Config.findOne();`,
        `  res.json(config);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/config.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows route when app.use(auditMiddleware) earlier in file → no finding', () => {
      const code = [
        `app.use(auditMiddleware);`,
        ``,
        `router.get('/patients/:id', async (req, res) => {`,
        `  const patient = await Patient.findById(req.params.id);`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('skips test files → no finding', () => {
      const code = [
        `router.get('/patients/:id', async (req, res) => {`,
        `  const patient = await Patient.findById(req.params.id);`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.test.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    // ── Design review: service-layer heuristic ──
    it('downgrades to MEDIUM when route delegates to service layer', () => {
      const code = [
        `router.get('/patients/:id', async (req, res) => {`,
        `  const patient = await patientService.getById(req.params.id);`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      // Service layer may handle audit internally — downgrade to MEDIUM
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('MEDIUM');
    });

    // ── Design review: decorator patterns ──
    it('allows route with @Audited decorator → no finding', () => {
      const code = [
        `@Audited`,
        `router.get('/patients/:id', async (req, res) => {`,
        `  const patient = await Patient.findById(req.params.id);`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    // ── Design review: event-based audit ──
    it('allows route with event-based audit (emit audit) → no finding', () => {
      const code = [
        `router.get('/patients/:id', async (req, res) => {`,
        `  const patient = await Patient.findById(req.params.id);`,
        `  eventBus.emit('audit', { action: 'read' });`,
        `  res.json(patient);`,
        `});`,
      ].join('\n');
      const files = new Map([['src/routes/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });
  });

  // ── 2.2 FHIR Without Audit ───────────────────────────────────────

  describe('FHIR without audit', () => {
    it('flags fhirClient.read without AuditEvent nearby → HIGH', () => {
      const code = [
        `async function getPatient(id) {`,
        `  const patient = await fhirClient.read('Patient', id);`,
        `  return patient;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/fhir/service.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags fhirClient.create (write op) without AuditEvent → CRITICAL', () => {
      const code = [
        `async function createPatient(data) {`,
        `  const result = await fhirClient.create('Patient', data);`,
        `  return result;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/fhir/service.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags fhirClient.update without AuditEvent → CRITICAL', () => {
      const code = [
        `async function updatePatient(id, data) {`,
        `  const result = await fhirClient.update('Patient', id, data);`,
        `  return result;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/fhir/service.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags fhirClient.delete without AuditEvent → CRITICAL', () => {
      const code = [
        `async function deletePatient(id) {`,
        `  await fhirClient.delete('Patient', id);`,
        `}`,
      ].join('\n');
      const files = new Map([['src/fhir/service.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags fhirClient.search without AuditEvent → HIGH', () => {
      const code = [
        `async function searchObs(patientId) {`,
        `  const results = await fhirClient.search('Observation', { patient: patientId });`,
        `  return results;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/fhir/service.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows fhirClient.read followed by AuditEvent creation → no finding', () => {
      const code = [
        `async function getPatient(id) {`,
        `  const patient = await fhirClient.read('Patient', id);`,
        `  await fhirClient.create('AuditEvent', {`,
        `    type: { code: 'rest' },`,
        `    agent: [{ who: { reference: 'Practitioner/1' } }],`,
        `  });`,
        `  return patient;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/fhir/service.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('does not flag fhirClient.create("AuditEvent") itself as missing audit', () => {
      const code = [
        `async function logAudit(event) {`,
        `  await fhirClient.create('AuditEvent', event);`,
        `}`,
      ].join('\n');
      const files = new Map([['src/fhir/audit.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });
  });

  // ── 2.3 DB Without Audit ──────────────────────────────────────────

  describe('DB operations without audit', () => {
    it('flags SELECT FROM patients without audit → HIGH', () => {
      const code = [
        `async function getPatient(id) {`,
        `  const result = await db.query('SELECT * FROM patients WHERE id = $1', [id]);`,
        `  return result.rows[0];`,
        `}`,
      ].join('\n');
      const files = new Map([['src/db/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags INSERT INTO patients without audit → CRITICAL', () => {
      const code = [
        `async function createPatient(data) {`,
        `  await db.query('INSERT INTO patients (name) VALUES ($1)', [data.name]);`,
        `}`,
      ].join('\n');
      const files = new Map([['src/db/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags UPDATE encounters without audit → CRITICAL', () => {
      const code = [
        `async function updateEncounter(id, data) {`,
        `  await db.query('UPDATE encounters SET status = $1 WHERE id = $2', [data.status, id]);`,
        `}`,
      ].join('\n');
      const files = new Map([['src/db/encounter.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags DELETE FROM patients without audit → CRITICAL', () => {
      const code = [
        `async function deletePatient(id) {`,
        `  await db.query('DELETE FROM patients WHERE id = $1', [id]);`,
        `}`,
      ].join('\n');
      const files = new Map([['src/db/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags Patient.findById without audit → HIGH', () => {
      const code = [
        `async function getPatient(id) {`,
        `  const patient = await Patient.findById(id);`,
        `  return patient;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/services/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags Patient.create without audit → CRITICAL', () => {
      const code = [
        `async function createPatient(data) {`,
        `  const patient = await Patient.create(data);`,
        `  return patient;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/services/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('allows Patient.findById with auditLog.record within 15 lines → no finding', () => {
      const code = [
        `async function getPatient(id, userId, req) {`,
        `  const patient = await Patient.findById(id);`,
        `  await auditLog.record({`,
        `    action: 'read',`,
        `    userId: userId,`,
        `    resource: 'Patient',`,
        `    resourceId: id,`,
        `    timestamp: Date.now(),`,
        `    ipAddress: req.ip,`,
        `  });`,
        `  return patient;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/services/patient.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('skips db.query on non-PHI table → no finding', () => {
      const code = [
        `async function getLogs() {`,
        `  const result = await db.query('SELECT * FROM audit_logs');`,
        `  return result.rows;`,
        `}`,
      ].join('\n');
      const files = new Map([['src/db/logs.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });
  });

  // ── 2.4 Incomplete Audit ──────────────────────────────────────────

  describe('incomplete audit entries', () => {
    it('flags audit call missing who/what/when/where (2+ missing) → MEDIUM', () => {
      const code = `auditLog.record({ action: 'read' });`;
      const files = new Map([['src/audit/log.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('MEDIUM');
    });

    it('allows audit call missing only 1 category (where) → no finding', () => {
      const code = [
        `auditLog.record({`,
        `  action: 'read',`,
        `  userId: req.user.id,`,
        `  resource: 'Patient',`,
        `  timestamp: new Date(),`,
        `});`,
      ].join('\n');
      const files = new Map([['src/audit/log.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows complete audit entry → no finding', () => {
      const code = [
        `auditLog.record({`,
        `  action: 'read',`,
        `  userId: req.user.id,`,
        `  resource: 'Patient',`,
        `  resourceId: id,`,
        `  timestamp: new Date(),`,
        `  ipAddress: req.ip,`,
        `});`,
      ].join('\n');
      const files = new Map([['src/audit/log.ts', code]]);
      const findings = auditTrailScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });
  });
});
