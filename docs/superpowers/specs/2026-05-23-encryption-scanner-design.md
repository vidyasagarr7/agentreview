# Design Spec: Encryption Scanner

**Date:** 2026-05-23
**Author:** Vex (subagent)
**Status:** DRAFT
**Regulation:** HIPAA §164.312(a)(2)(iv) — Encryption and Decryption, §164.312(e)(2)(ii) — Encryption (Transmission Security)

---

## 1. Problem Statement

HIPAA requires encryption of PHI at rest and in transit. Codebases frequently contain database connection strings, cloud storage configurations, cache connections, and API client setups that transmit or store PHI without proper encryption. The existing `http-phi` scanner only catches plain HTTP URLs in PHI-relevant files — it doesn't cover database connections, cloud storage, cache layers, or weak cryptographic algorithm usage.

**Goal:** Detect unencrypted data channels and weak/deprecated cryptographic primitives that could expose PHI, with deterministic 100% confidence findings.

---

## 2. Detection Categories

### 2.1 Unencrypted Database Connections

Detect connection strings and configuration objects missing encryption:

```typescript
// MongoDB without TLS — CRITICAL
mongoose.connect('mongodb://db.internal/patients')        // no ?tls=true or ?ssl=true
new MongoClient('mongodb://host:27017/ehr')               // no ssl/tls params
MongoClient.connect(url, { })                             // missing ssl: true / tls: true in options

// PostgreSQL without SSL — CRITICAL
postgres://user:pass@host/patients                         // no ?sslmode=require
pg.connect({ host: 'db', database: 'ehr' })              // missing ssl: true or ssl: { ... }
new Pool({ connectionString: 'postgres://...' })          // no sslmode in string

// MySQL without SSL — CRITICAL
mysql.createConnection({ host: 'db' })                    // missing ssl option
mysql://user:pass@host/encounters                          // no ssl params
```

**Pattern strategy:**
- Match connection string patterns (URI schemes: `mongodb://`, `postgres://`, `postgresql://`, `mysql://`)
- Check for absence of SSL/TLS query parameters in URI strings
- Match config objects for `mongoose.connect`, `MongoClient`, `pg.connect`, `new Pool`, `mysql.createConnection` etc. and verify SSL/TLS options within nearby lines (±5 lines window)
- Only flag in PHI-relevant files (same heuristic as `http-phi`: path keywords + `phiSourcePatterns`)

**Severity:** CRITICAL — unencrypted database connections carrying PHI

### 2.2 Cloud Storage Without Encryption Configuration

Detect S3, Azure Blob, and GCS operations missing encryption settings:

```typescript
// S3 PutObject without ServerSideEncryption — HIGH
s3.putObject({ Bucket: 'phi-records', Key: '...' })       // no ServerSideEncryption
s3.upload({ Bucket: 'patient-data', ... })                 // no ServerSideEncryption

// Azure Blob without encryption mention — HIGH  
blobClient.upload(data, length)                            // no encryption context

// GCS without encryption — HIGH
bucket.upload('./patient.pdf')                             // no encryptionKey / kmsKeyName
```

**Pattern strategy:**
- Match S3 API calls (`putObject`, `upload`, `send(PutObjectCommand`) in PHI-relevant files
- Check for `ServerSideEncryption` or `SSECustomerAlgorithm` within the same statement block (±5 lines)
- For Azure/GCS, match upload calls and check for encryption configuration nearby
- Only flag when the bucket/container name or file context suggests PHI (path keywords, bucket name contains PHI keywords like `patient`, `phi`, `ehr`, `clinical`, `health`, `fhir`)

**Severity:** HIGH — missing encryption at rest for PHI storage

### 2.3 Weak/Deprecated Cryptographic Algorithms

Detect usage of broken or deprecated crypto:

```typescript
// Deprecated algorithms — HIGH
crypto.createCipher('des', key)           // DES — broken
crypto.createCipher('des-ede3', key)      // 3DES — deprecated
crypto.createCipheriv('rc4', key, iv)     // RC4 — broken
crypto.createCipheriv('aes-128-ecb', ...) // ECB mode — no semantic security
CryptoJS.DES.encrypt(...)                 // DES via CryptoJS
CryptoJS.RC4.encrypt(...)                 // RC4 via CryptoJS

// Weak hashing for integrity/signing — HIGH
crypto.createHash('md5')                  // MD5 for integrity — broken
crypto.createHash('sha1')                 // SHA1 for signing — deprecated
CryptoJS.MD5(...)                         // MD5 via CryptoJS
CryptoJS.SHA1(...)                        // SHA1 via CryptoJS
```

**Pattern strategy:**
- Regex match for `createCipher(iv)?` with algorithm string containing `des`, `rc4`, `ecb`
- Regex match for `createHash` with `md5` or `sha1`
- Match CryptoJS equivalents: `CryptoJS.DES`, `CryptoJS.RC4`, `CryptoJS.MD5`, `CryptoJS.SHA1`
- Match Java/Python equivalents if file extensions match: `Cipher.getInstance("DES")`, `hashlib.md5()`
- This category applies to ALL files (not just PHI-relevant) since weak crypto is a systemic risk

**Severity:** HIGH — weak crypto undermines PHI protection guarantees

### 2.4 Unencrypted Cache Connections

Detect Redis/Memcached without TLS:

```typescript
// Redis without TLS — HIGH
new Redis('redis://cache:6379')            // redis:// not rediss://
redis.createClient({ host: 'cache' })      // no tls option
new Redis({ host: 'cache', port: 6379 })   // no tls: {} option

// Memcached — MEDIUM (informational, harder to detect encryption)
new Memcached('cache:11211')               // no TLS support natively
```

**Pattern strategy:**
- Match `redis://` scheme (vs `rediss://` which is TLS)
- Match Redis client constructors and check for `tls` option within ±5 lines
- Match Memcached connections (inherently unencrypted) — lower severity since Memcached TLS is less standard
- Only flag in PHI-relevant files

**Severity:** HIGH (Redis), MEDIUM (Memcached)

### 2.5 API Clients Without HTTPS Enforcement

Detect HTTP API clients that could transmit PHI without TLS:

```typescript
// axios baseURL without HTTPS — HIGH
axios.create({ baseURL: 'http://api.internal' })
const client = axios.create({ baseURL: config.apiUrl }) // can't determine — skip

// fetch to HTTP in PHI files — already covered by http-phi scanner
// This scanner adds: axios/got/superagent/node-fetch baseURL patterns
```

**Pattern strategy:**
- Match `baseURL` or `base_url` assignments containing `http://` (excluding localhost)
- Match `got.extend({ prefixUrl: 'http://...' })`
- Reuse `http-phi` scanner's allowlisted hosts (localhost, 127.0.0.1, etc.)
- Only flag in PHI-relevant files
- Avoids overlap with `http-phi` by focusing on client configuration, not individual URLs

**Severity:** HIGH

---

## 3. Architecture

### Scanner Interface

```typescript
export const encryptionScanner: Scanner = {
  id: 'encryption',
  name: 'Encryption at Rest & Transit',
  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[]
};
```

### Internal Structure

```
src/hipaa/scanners/encryption.ts
├── SCANNER_ID = 'encryption'
├── Sub-detectors (private functions):
│   ├── detectUnencryptedDatabases(filePath, content, lines, options) → findings
│   ├── detectUnencryptedStorage(filePath, content, lines, options) → findings
│   ├── detectWeakCrypto(filePath, content, lines) → findings
│   ├── detectUnencryptedCache(filePath, content, lines, options) → findings
│   └── detectInsecureApiClients(filePath, content, lines, options) → findings
└── scan() orchestrates all sub-detectors
```

### PHI-Relevance Gating

Categories 2.1, 2.2, 2.4, 2.5 only fire in PHI-relevant files (reuses `http-phi` heuristic):
- File path contains PHI keywords (`fhir`, `patient`, `hl7`, `clinical`, `health`, `medical`, `ehr`, `phi`, `hipaa`)
- File path matches `phiSourcePatterns` from config

Category 2.3 (weak crypto) fires on ALL files — weak crypto is a systemic issue regardless of PHI context.

### File Types

- Primary: `.ts`, `.js`, `.tsx`, `.jsx`, `.mjs`, `.cjs`
- Extended: `.py`, `.java`, `.rb`, `.go` (for crypto patterns only, since they're universal)
- Skip: test files (default), `node_modules`, generated files

---

## 4. False Positive Mitigation

| Risk | Mitigation |
|------|-----------|
| MongoDB connection in test fixtures | Skip test files (default behavior) |
| Connection strings in documentation/comments | Check that the match isn't inside a comment block (`//`, `/*...*/`, `#`) |
| Variables that happen to contain `redis://` | Only match in assignment/call contexts |
| `crypto.createHash('md5')` for non-security use (checksums) | Still flag as HIGH — md5 shouldn't be in healthcare code even for checksums (use SHA-256) |
| S3 calls with server-default encryption (bucket policy) | Note in suggestion that bucket-level encryption may suffice, but explicit is better |
| `localhost` database connections | Allowlist localhost/127.0.0.1/[::1] for database connections too |

---

## 5. Configuration

The scanner respects the standard `hipaaConfig.scanners.encryption` toggle (boolean, default `true`).

No additional scanner-specific configuration needed for v1. Future: configurable allowlisted hosts, additional PHI table/bucket name patterns.

---

## 6. Regulation Mapping

| Detection | HIPAA Regulation | Requirement |
|-----------|-----------------|-------------|
| Unencrypted DB connections | §164.312(a)(2)(iv) | Encryption at rest |
| Unencrypted cloud storage | §164.312(a)(2)(iv) | Encryption at rest |
| Weak crypto algorithms | §164.312(a)(2)(iv), §164.312(e)(2)(ii) | Addressable encryption implementation |
| Unencrypted cache | §164.312(e)(2)(ii) | Encryption in transit |
| Insecure API clients | §164.312(e)(2)(ii) | Transmission security |
