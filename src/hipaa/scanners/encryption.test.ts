import { describe, it, expect, beforeEach } from 'vitest';
import { encryptionScanner } from './encryption.js';
import { type ScannerOptions } from './types.js';
import { buildPhiFieldSet } from '../phi-patterns.js';

describe('encryption scanner', () => {
  let options: ScannerOptions;

  beforeEach(() => {
    options = { phiFields: buildPhiFieldSet(), skipTests: true };
  });

  // ── 2.1 Unencrypted Database Connections ──────────────────────────

  describe('unencrypted database connections', () => {
    it('flags mongodb:// without tls in PHI file → CRITICAL', () => {
      const files = new Map([
        ['src/patient/db.ts', `mongoose.connect('mongodb://db.internal/patients');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
      expect(findings[0].scannerId).toBe('encryption');
    });

    it('allows mongodb:// with ?tls=true', () => {
      const files = new Map([
        ['src/patient/db.ts', `mongoose.connect('mongodb://db.internal/patients?tls=true');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows mongodb:// with ?ssl=true', () => {
      const files = new Map([
        ['src/patient/db.ts', `mongoose.connect('mongodb://db.internal/patients?ssl=true');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags postgres:// without sslmode in PHI file → CRITICAL', () => {
      const files = new Map([
        ['src/clinical/conn.ts', `const url = 'postgres://user:pass@host/patients';`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('allows postgres:// with sslmode=require', () => {
      const files = new Map([
        ['src/clinical/conn.ts', `const url = 'postgres://user:pass@host/patients?sslmode=require';`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags mysql:// without ssl in PHI file → CRITICAL', () => {
      const files = new Map([
        ['src/ehr/db.ts', `const url = 'mysql://user:pass@host/encounters';`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('allows mysql:// with ssl param', () => {
      const files = new Map([
        ['src/ehr/db.ts', `const url = 'mysql://user:pass@host/encounters?ssl=true';`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows localhost connections (allowlisted)', () => {
      const files = new Map([
        ['src/patient/db.ts', `mongoose.connect('mongodb://localhost/patients');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows 127.0.0.1 connections (allowlisted)', () => {
      const files = new Map([
        ['src/patient/db.ts', `mongoose.connect('mongodb://127.0.0.1/patients');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('skips connections in non-PHI file', () => {
      const files = new Map([
        ['src/analytics/db.ts', `mongoose.connect('mongodb://db.internal/analytics');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('skips test files by default', () => {
      const files = new Map([
        ['src/patient/db.test.ts', `mongoose.connect('mongodb://db.internal/patients');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });
  });

  // ── 2.2 Cloud Storage Without Encryption ──────────────────────────

  describe('unencrypted cloud storage', () => {
    it('flags s3.putObject without ServerSideEncryption → HIGH', () => {
      const files = new Map([
        ['src/phi/upload.ts', `s3.putObject({ Bucket: 'patient-records', Key: 'file.pdf', Body: data });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows s3.putObject with ServerSideEncryption', () => {
      const files = new Map([
        ['src/phi/upload.ts', `s3.putObject({ Bucket: 'patient-records', Key: 'file.pdf', Body: data, ServerSideEncryption: 'AES256' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows s3.upload with SSECustomerAlgorithm', () => {
      const files = new Map([
        ['src/phi/upload.ts', `s3.upload({ Bucket: 'patient-data', Key: 'f', Body: d, SSECustomerAlgorithm: 'AES256' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags PutObjectCommand without encryption → HIGH', () => {
      const files = new Map([
        ['src/phi/upload.ts', `client.send(new PutObjectCommand({ Bucket: 'phi-data', Key: 'f' }));`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('skips generic bucket name without PHI keywords in non-PHI file', () => {
      const files = new Map([
        ['src/assets/upload.ts', `s3.putObject({ Bucket: 'static-assets', Key: 'logo.png', Body: data });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags ALL storage upload calls without encryption in PHI files', () => {
      // Even with generic bucket names, if in a PHI-relevant file path, flag it
      const files = new Map([
        ['src/patient/upload.ts', `s3.upload({ Bucket: 'my-bucket', Key: 'data.csv', Body: d });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });
  });

  // ── 2.3 Weak/Deprecated Cryptographic Algorithms ─────────────────

  describe('weak crypto algorithms', () => {
    it('flags crypto.createCipher with des → HIGH', () => {
      const files = new Map([
        ['src/utils/crypto.ts', `const cipher = crypto.createCipher('des', key);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags ALL createCipher calls (non-iv variant) as HIGH', () => {
      // createCipher (without iv) is deprecated entirely — flag regardless of algorithm
      const files = new Map([
        ['src/utils/crypto.ts', `const cipher = crypto.createCipher('aes-256-cbc', key);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags crypto.createCipheriv with rc4 → HIGH', () => {
      const files = new Map([
        ['src/utils/crypto.ts', `const cipher = crypto.createCipheriv('rc4', key, iv);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags crypto.createCipheriv with ecb mode → HIGH', () => {
      const files = new Map([
        ['src/utils/crypto.ts', `const cipher = crypto.createCipheriv('aes-128-ecb', key, iv);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows crypto.createCipheriv with aes-256-cbc (safe)', () => {
      const files = new Map([
        ['src/utils/crypto.ts', `const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags crypto.createHash(md5) → HIGH', () => {
      const files = new Map([
        ['src/utils/hash.ts', `const hash = crypto.createHash('md5');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags crypto.createHash(sha1) → HIGH', () => {
      const files = new Map([
        ['src/utils/hash.ts', `const hash = crypto.createHash('sha1');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows crypto.createHash(sha256) (safe)', () => {
      const files = new Map([
        ['src/utils/hash.ts', `const hash = crypto.createHash('sha256');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags CryptoJS.DES.encrypt → HIGH', () => {
      const files = new Map([
        ['src/encrypt.ts', `const encrypted = CryptoJS.DES.encrypt(data, key);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags CryptoJS.MD5 → HIGH', () => {
      const files = new Map([
        ['src/hash.ts', `const hash = CryptoJS.MD5(data);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows CryptoJS.AES.encrypt (safe)', () => {
      const files = new Map([
        ['src/encrypt.ts', `const encrypted = CryptoJS.AES.encrypt(data, key);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags weak crypto in ANY file (not just PHI-relevant)', () => {
      const files = new Map([
        ['src/unrelated/util.ts', `const hash = crypto.createHash('md5');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
    });

    // ── TLS validation patterns (design review findings) ──
    it('flags rejectUnauthorized: false → CRITICAL', () => {
      const files = new Map([
        ['src/patient/api.ts', `const opts = { rejectUnauthorized: false };`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags NODE_TLS_REJECT_UNAUTHORIZED=0 → CRITICAL', () => {
      const files = new Map([
        ['src/patient/api.ts', `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('CRITICAL');
    });

    it('flags TLSv1 usage → HIGH', () => {
      const files = new Map([
        ['src/patient/api.ts', `const ctx = tls.createSecureContext({ minVersion: 'TLSv1' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('flags TLSv1.1 usage → HIGH', () => {
      const files = new Map([
        ['src/patient/api.ts', `const ctx = tls.createSecureContext({ minVersion: 'TLSv1.1' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    // ── Key management patterns (design review findings) ──
    it('flags hardcoded encryption keys (string literal as crypto key) → HIGH', () => {
      const files = new Map([
        ['src/utils/crypto.ts', `const cipher = crypto.createCipheriv('aes-256-cbc', 'mySecretKey12345', iv);`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      // Should get flagged for hardcoded key (the algorithm is fine)
      expect(findings.some(f => f.summary.toLowerCase().includes('hardcoded') || f.summary.toLowerCase().includes('key'))).toBe(true);
    });
  });

  // ── 2.4 Unencrypted Cache Connections ─────────────────────────────

  describe('unencrypted cache connections', () => {
    it('flags redis:// scheme in PHI file → HIGH', () => {
      const files = new Map([
        ['src/patient/cache.ts', `const client = new Redis('redis://cache:6379');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows rediss:// scheme (TLS)', () => {
      const files = new Map([
        ['src/patient/cache.ts', `const client = new Redis('rediss://cache:6379');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags new Redis({ host }) without tls in PHI file → HIGH', () => {
      const files = new Map([
        ['src/patient/cache.ts', `const client = new Redis({ host: 'cache', port: 6379 });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows new Redis({ host, tls }) with tls option', () => {
      const files = new Map([
        ['src/patient/cache.ts', [
          `const client = new Redis({`,
          `  host: 'cache',`,
          `  port: 6379,`,
          `  tls: {},`,
          `});`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('skips redis in non-PHI file', () => {
      const files = new Map([
        ['src/analytics/cache.ts', `const client = new Redis('redis://cache:6379');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags Memcached in PHI file → MEDIUM', () => {
      const files = new Map([
        ['src/patient/cache.ts', `const mc = new Memcached('cache:11211');`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('MEDIUM');
    });
  });

  // ── 2.5 API Clients Without HTTPS ────────────────────────────────

  describe('insecure API clients', () => {
    it('flags axios baseURL with http:// in PHI file → HIGH', () => {
      const files = new Map([
        ['src/fhir/client.ts', `const api = axios.create({ baseURL: 'http://api.internal' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });

    it('allows axios baseURL with https://', () => {
      const files = new Map([
        ['src/fhir/client.ts', `const api = axios.create({ baseURL: 'https://api.internal' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('allows axios baseURL with http://localhost', () => {
      const files = new Map([
        ['src/fhir/client.ts', `const api = axios.create({ baseURL: 'http://localhost:3000' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(0);
    });

    it('flags got.extend prefixUrl with http:// in PHI file → HIGH', () => {
      const files = new Map([
        ['src/health/api.ts', `const client = got.extend({ prefixUrl: 'http://api.internal' });`],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
    });
  });

  // ── 2.6 Azure Blob Upload Without Encryption ──────────────────────

  describe('Azure Blob upload encryption', () => {
    it('flags blobClient.upload without encrypt nearby in PHI file → HIGH', () => {
      const files = new Map([
        ['src/patient/azure-upload.ts', [
          `const data = getPatientData();`,
          `await blobClient.upload(data, data.length);`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
      expect(findings[0].category).toBe('Unencrypted Cloud Storage');
      expect(findings[0].summary).toContain('Azure');
    });

    it('allows blobClient.upload with encryptionScope nearby in PHI file', () => {
      const files = new Map([
        ['src/patient/azure-upload.ts', [
          `const options = { encryptionScope: 'phi-scope' };`,
          `await blobClient.upload(data, data.length, options);`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      const azureFindings = findings.filter(f => f.summary.includes('Azure'));
      expect(azureFindings).toHaveLength(0);
    });

    it('skips blobClient.upload in non-PHI file', () => {
      const files = new Map([
        ['src/assets/azure-upload.ts', [
          `await blobClient.upload(data, data.length);`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      const azureFindings = findings.filter(f => f.summary.includes('Azure'));
      expect(azureFindings).toHaveLength(0);
    });
  });

  // ── 2.7 GCS Upload Without Encryption ─────────────────────────────

  describe('GCS upload encryption', () => {
    it('flags bucket.upload without encryptionKey/kmsKeyName nearby in PHI file → HIGH', () => {
      const files = new Map([
        ['src/hipaa/gcs-upload.ts', [
          `const bucket = storage.bucket('phi-records');`,
          `await bucket.upload('./patient-data.csv');`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('HIGH');
      expect(findings[0].category).toBe('Unencrypted Cloud Storage');
      expect(findings[0].summary).toContain('GCS');
    });

    it('allows bucket.upload with encryptionKey nearby in PHI file', () => {
      const files = new Map([
        ['src/hipaa/gcs-upload.ts', [
          `const opts = { encryptionKey: Buffer.from(key) };`,
          `await bucket.upload('./patient-data.csv', opts);`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      const gcsFindings = findings.filter(f => f.summary.includes('GCS'));
      expect(gcsFindings).toHaveLength(0);
    });

    it('allows bucket.upload with kmsKeyName nearby in PHI file', () => {
      const files = new Map([
        ['src/hipaa/gcs-upload.ts', [
          `const opts = { kmsKeyName: 'projects/my-project/locations/us/keyRings/ring/cryptoKeys/key' };`,
          `await bucket.upload('./patient-data.csv', opts);`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      const gcsFindings = findings.filter(f => f.summary.includes('GCS'));
      expect(gcsFindings).toHaveLength(0);
    });

    it('skips bucket.upload in non-PHI file', () => {
      const files = new Map([
        ['src/assets/gcs-upload.ts', [
          `await bucket.upload('./logo.png');`,
        ].join('\n')],
      ]);
      const findings = encryptionScanner.scan(files, options);
      const gcsFindings = findings.filter(f => f.summary.includes('GCS'));
      expect(gcsFindings).toHaveLength(0);
    });
  });
});
