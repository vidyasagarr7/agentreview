import type { AgentFinding } from '../../types/index.js';
import { createDeterministicFinding, type Scanner, type ScannerOptions } from './types.js';

const SCANNER_ID = 'encryption';

// Hosts that are safe for plain connections
const ALLOWLISTED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
]);

// File-path keywords that indicate PHI-relevant context
const PHI_PATH_KEYWORDS = [
  'fhir', 'patient', 'hl7', 'clinical',
  'health', 'medical', 'ehr', 'phi', 'hipaa',
];

// Bucket/container name keywords that indicate PHI data
const PHI_BUCKET_KEYWORDS = [
  'patient', 'phi', 'ehr', 'clinical', 'health', 'fhir', 'medical', 'hipaa',
];

// Test-file patterns to skip
const TEST_FILE_PATTERN = /(?:\.test\.[tj]sx?|\.spec\.[tj]sx?|__tests__\/)/;

// JS/TS file extensions
const JS_TS_PATTERN = /\.[tj]sx?$/;

// Weak/deprecated algorithms for createCipheriv
const WEAK_CIPHER_ALGORITHMS = /\b(des|des-ede3|rc4|ecb)\b/i;

// Weak hash algorithms
const WEAK_HASH_ALGORITHMS = /\b(md5|sha1)\b/i;

// Weak CryptoJS modules
const WEAK_CRYPTOJS_RE = /CryptoJS\.(DES|TripleDES|RC4|MD5|SHA1)\b/;

function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERN.test(path);
}

function isPhiRelevantPath(path: string, phiSourcePatterns?: string[]): boolean {
  const lower = path.toLowerCase();
  if (PHI_PATH_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  if (phiSourcePatterns) {
    return phiSourcePatterns.some((pat) => {
      const escaped = pat.replace(/[+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(escaped).test(path);
    });
  }
  return false;
}

function extractHost(uri: string): string {
  // URI format: scheme://[user:pass@]host[:port]/...
  const afterScheme = uri.replace(/^[a-z]+:\/\//, '');
  const afterAuth = afterScheme.includes('@') ? afterScheme.split('@')[1] : afterScheme;
  const hostPort = afterAuth.split('/')[0].split('?')[0];
  return hostPort.replace(/:\d+$/, '');
}

function hasBucketPhiKeyword(line: string): boolean {
  // Check if line contains a bucket name with PHI keywords
  const bucketMatch = line.match(/Bucket:\s*['"]([^'"]+)['"]/i);
  if (bucketMatch) {
    const bucketName = bucketMatch[1].toLowerCase();
    return PHI_BUCKET_KEYWORDS.some((kw) => bucketName.includes(kw));
  }
  return false;
}

function hasNearbyText(lines: string[], lineIdx: number, pattern: RegExp, window: number): boolean {
  const start = Math.max(0, lineIdx - window);
  const end = Math.min(lines.length - 1, lineIdx + window);
  for (let i = start; i <= end; i++) {
    if (pattern.test(lines[i])) return true;
  }
  return false;
}

// ── Sub-detectors ───────────────────────────────────────────────────

function detectUnencryptedDatabases(
  filePath: string,
  content: string,
  lines: string[],
  _options: ScannerOptions,
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  // Connection URI patterns: mongodb://, postgres://, postgresql://, mysql://
  const DB_URI_RE = /['"`]((?:mongodb|postgres|postgresql|mysql):\/\/[^'"`]+)['"`]/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    DB_URI_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = DB_URI_RE.exec(line)) !== null) {
      const uri = match[1];
      const host = extractHost(uri);

      // Skip allowlisted hosts
      if (ALLOWLISTED_HOSTS.has(host)) continue;

      // Check for TLS/SSL in URI params
      const uriLower = uri.toLowerCase();
      const scheme = uri.split('://')[0].toLowerCase();

      let hasEncryption = false;
      if (scheme === 'mongodb') {
        hasEncryption = /[?&](tls|ssl)=true/i.test(uriLower);
      } else if (scheme === 'postgres' || scheme === 'postgresql') {
        hasEncryption = /[?&]sslmode=(require|verify-ca|verify-full)/i.test(uriLower);
      } else if (scheme === 'mysql') {
        hasEncryption = /[?&]ssl=true/i.test(uriLower);
      }

      if (!hasEncryption) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'CRITICAL',
            category: 'Unencrypted Database Connection',
            location: `${filePath}:${i + 1}`,
            summary: `Unencrypted ${scheme} connection without TLS/SSL`,
            detail: `Database connection string uses ${scheme}:// without encryption parameters. PHI in transit to the database is unprotected.`,
            suggestion: `Add TLS/SSL parameters to the connection string (e.g., ?tls=true for MongoDB, ?sslmode=require for PostgreSQL, ?ssl=true for MySQL).`,
            regulation: '45 CFR §164.312(a)(2)(iv), §164.312(e)(2)(ii)',
          }),
        );
      }
    }
  }

  return findings;
}

function detectUnencryptedStorage(
  filePath: string,
  _content: string,
  lines: string[],
  _options: ScannerOptions,
  isPhiFile: boolean,
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  // S3 upload patterns
  const S3_CALL_RE = /\b(?:s3\.(?:putObject|upload)|(?:new\s+)?PutObjectCommand|s3Client\.send)\s*\(/i;
  const S3_ENCRYPTION_RE = /ServerSideEncryption|SSECustomerAlgorithm|KMSMasterKeyID/;

  // Azure/GCS upload patterns
  const AZURE_UPLOAD_RE = /blobClient\.upload\b/i;
  const GCS_UPLOAD_RE = /bucket\.upload\b/i;
  const GCS_ENCRYPTION_RE = /encryptionKey|kmsKeyName/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (S3_CALL_RE.test(line)) {
      // Check if this line or nearby lines have encryption config
      if (hasNearbyText(lines, i, S3_ENCRYPTION_RE, 5)) continue;

      // Flag if bucket has PHI keyword OR if the file path is PHI-relevant
      if (hasBucketPhiKeyword(line) || isPhiFile) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Unencrypted Cloud Storage',
            location: `${filePath}:${i + 1}`,
            summary: 'S3 upload without server-side encryption',
            detail: 'S3 PutObject/upload call without ServerSideEncryption or SSECustomerAlgorithm. PHI stored without encryption at rest.',
            suggestion: 'Add ServerSideEncryption: "AES256" or "aws:kms" to the upload params, or configure bucket-level default encryption.',
            regulation: '45 CFR §164.312(a)(2)(iv)',
          }),
        );
      }
    }

    if (isPhiFile && AZURE_UPLOAD_RE.test(line)) {
      if (!hasNearbyText(lines, i, /encrypt/i, 5)) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Unencrypted Cloud Storage',
            location: `${filePath}:${i + 1}`,
            summary: 'Azure Blob upload without encryption configuration',
            detail: 'Azure Blob upload without explicit encryption context in a PHI-handling file.',
            suggestion: 'Configure Azure Storage Service Encryption or use client-side encryption for PHI data.',
            regulation: '45 CFR §164.312(a)(2)(iv)',
          }),
        );
      }
    }

    if (isPhiFile && GCS_UPLOAD_RE.test(line)) {
      if (!hasNearbyText(lines, i, GCS_ENCRYPTION_RE, 5)) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Unencrypted Cloud Storage',
            location: `${filePath}:${i + 1}`,
            summary: 'GCS upload without encryption configuration',
            detail: 'GCS bucket upload without encryptionKey or kmsKeyName in a PHI-handling file.',
            suggestion: 'Add encryptionKey or kmsKeyName to the upload options for PHI data.',
            regulation: '45 CFR §164.312(a)(2)(iv)',
          }),
        );
      }
    }
  }

  return findings;
}

function detectWeakCrypto(
  filePath: string,
  _content: string,
  lines: string[],
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  // createCipher (non-iv variant) — ALL calls are flagged as deprecated
  const CREATE_CIPHER_NO_IV_RE = /crypto\.createCipher\s*\(/;
  // createCipheriv with weak algorithm
  const CREATE_CIPHER_IV_RE = /crypto\.createCipheriv\s*\(\s*['"]([^'"]+)['"]/;
  // createHash with weak algorithm
  const CREATE_HASH_RE = /crypto\.createHash\s*\(\s*['"]([^'"]+)['"]/;
  // CryptoJS weak modules
  // rejectUnauthorized: false
  const REJECT_UNAUTH_RE = /rejectUnauthorized\s*:\s*false/;
  // NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const NODE_TLS_RE = /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]0['"]/;
  // TLSv1 or TLSv1.1 usage
  const WEAK_TLS_RE = /['"]TLSv1(?:\.1)?['"]/;
  // Hardcoded crypto keys — string literal passed directly to createCipheriv as key argument
  const HARDCODED_KEY_RE = /crypto\.createCipheriv\s*\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // createCipher (non-iv) — always flagged
    if (CREATE_CIPHER_NO_IV_RE.test(line)) {
      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'HIGH',
          category: 'Weak Cryptography',
          location: `${filePath}:${i + 1}`,
          summary: 'Deprecated crypto.createCipher() — use createCipheriv() instead',
          detail: 'crypto.createCipher() is deprecated and derives key without a salt, making it vulnerable. Use createCipheriv() with a proper key and IV.',
          suggestion: 'Replace crypto.createCipher() with crypto.createCipheriv() using a strong algorithm (aes-256-cbc/aes-256-gcm), proper key derivation, and random IV.',
          regulation: '45 CFR §164.312(a)(2)(iv)',
        }),
      );
      // Don't continue — also check for hardcoded key below (but createCipher already flagged)
      continue;
    }

    // createCipheriv with weak algorithm
    const cipherIvMatch = CREATE_CIPHER_IV_RE.exec(line);
    if (cipherIvMatch) {
      const algo = cipherIvMatch[1];
      if (WEAK_CIPHER_ALGORITHMS.test(algo)) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Weak Cryptography',
            location: `${filePath}:${i + 1}`,
            summary: `Weak/deprecated cipher algorithm: ${algo}`,
            detail: `The cipher algorithm "${algo}" is weak or deprecated. ${algo.includes('ecb') ? 'ECB mode lacks semantic security.' : 'This algorithm is cryptographically broken.'}`,
            suggestion: 'Use AES-256-GCM or AES-256-CBC with HMAC for encryption.',
            regulation: '45 CFR §164.312(a)(2)(iv)',
          }),
        );
      }

      // Check for hardcoded key
      if (HARDCODED_KEY_RE.test(line)) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Hardcoded Encryption Key',
            location: `${filePath}:${i + 1}`,
            summary: 'Hardcoded encryption key detected in crypto call',
            detail: 'A string literal is used directly as the encryption key. Hardcoded keys are easily extracted from source code.',
            suggestion: 'Use environment variables, a key management service (KMS), or a secrets manager instead of hardcoding keys.',
            regulation: '45 CFR §164.312(a)(2)(iv)',
          }),
        );
      }
    }

    // createHash with weak algorithm
    const hashMatch = CREATE_HASH_RE.exec(line);
    if (hashMatch) {
      const algo = hashMatch[1];
      if (WEAK_HASH_ALGORITHMS.test(algo)) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Weak Cryptography',
            location: `${filePath}:${i + 1}`,
            summary: `Weak hash algorithm: ${algo}`,
            detail: `${algo.toUpperCase()} is cryptographically broken and should not be used for integrity or security purposes in healthcare applications.`,
            suggestion: 'Use SHA-256 or SHA-3 instead.',
            regulation: '45 CFR §164.312(a)(2)(iv)',
          }),
        );
      }
    }

    // CryptoJS weak modules
    const cryptoJsMatch = WEAK_CRYPTOJS_RE.exec(line);
    if (cryptoJsMatch) {
      const module = cryptoJsMatch[1];
      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'HIGH',
          category: 'Weak Cryptography',
          location: `${filePath}:${i + 1}`,
          summary: `Weak CryptoJS algorithm: ${module}`,
          detail: `CryptoJS.${module} uses a weak/deprecated algorithm that should not be used in healthcare applications.`,
          suggestion: `Replace with CryptoJS.AES (for encryption) or use SHA-256/SHA-3 (for hashing).`,
          regulation: '45 CFR §164.312(a)(2)(iv)',
        }),
      );
    }

    // TLS validation: rejectUnauthorized: false
    if (REJECT_UNAUTH_RE.test(line)) {
      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'CRITICAL',
          category: 'TLS Validation Disabled',
          location: `${filePath}:${i + 1}`,
          summary: 'TLS certificate validation disabled (rejectUnauthorized: false)',
          detail: 'Setting rejectUnauthorized to false disables TLS certificate validation, allowing man-in-the-middle attacks on PHI in transit.',
          suggestion: 'Remove rejectUnauthorized: false and configure proper CA certificates.',
          regulation: '45 CFR §164.312(e)(2)(ii)',
        }),
      );
    }

    // NODE_TLS_REJECT_UNAUTHORIZED = '0'
    if (NODE_TLS_RE.test(line)) {
      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'CRITICAL',
          category: 'TLS Validation Disabled',
          location: `${filePath}:${i + 1}`,
          summary: 'TLS validation globally disabled via NODE_TLS_REJECT_UNAUTHORIZED',
          detail: 'Setting NODE_TLS_REJECT_UNAUTHORIZED to "0" globally disables TLS certificate validation for all HTTPS connections.',
          suggestion: 'Remove this setting and configure proper CA certificates instead.',
          regulation: '45 CFR §164.312(e)(2)(ii)',
        }),
      );
    }

    // Weak TLS versions (TLSv1, TLSv1.1)
    if (WEAK_TLS_RE.test(line) && !/TLSv1\.[23]/.test(line)) {
      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'HIGH',
          category: 'Weak TLS Version',
          location: `${filePath}:${i + 1}`,
          summary: 'Deprecated TLS version (TLSv1/1.1) in use',
          detail: 'TLSv1 and TLSv1.1 are deprecated and have known vulnerabilities. HIPAA requires strong encryption for PHI in transit.',
          suggestion: 'Use TLSv1.2 or TLSv1.3 as the minimum version.',
          regulation: '45 CFR §164.312(e)(2)(ii)',
        }),
      );
    }
  }

  return findings;
}

function detectUnencryptedCache(
  filePath: string,
  _content: string,
  lines: string[],
  _options: ScannerOptions,
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  // redis:// (not rediss://)
  const REDIS_URI_RE = /['"`](redis:\/\/[^'"`]+)['"`]/gi;
  // Redis constructor with config object (no tls)
  const REDIS_CONSTRUCTOR_RE = /new\s+Redis\s*\(\s*\{/;
  // Memcached
  const MEMCACHED_RE = /new\s+Memcached\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // redis:// URI
    REDIS_URI_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REDIS_URI_RE.exec(line)) !== null) {
      // rediss:// check — it won't match since regex requires redis:// not rediss://
      // But double-check to be safe
      const beforeMatch = line.substring(0, match.index);
      // Check if this is actually rediss:// (the 's' might be just before our match)
      if (/rediss:\/\//.test(line)) continue;

      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'HIGH',
          category: 'Unencrypted Cache Connection',
          location: `${filePath}:${i + 1}`,
          summary: 'Redis connection without TLS (redis:// vs rediss://)',
          detail: 'Redis connection uses redis:// (plaintext) instead of rediss:// (TLS). PHI cached without transport encryption.',
          suggestion: 'Use rediss:// scheme for TLS, or configure the Redis client with tls: {} option.',
          regulation: '45 CFR §164.312(e)(2)(ii)',
        }),
      );
    }

    // Redis constructor with object config
    if (REDIS_CONSTRUCTOR_RE.test(line)) {
      // Check ±5 lines for tls option
      if (!hasNearbyText(lines, i, /\btls\s*:/i, 5)) {
        findings.push(
          createDeterministicFinding({
            scannerId: SCANNER_ID,
            severity: 'HIGH',
            category: 'Unencrypted Cache Connection',
            location: `${filePath}:${i + 1}`,
            summary: 'Redis client created without TLS configuration',
            detail: 'Redis client constructor does not include a tls option. Data in transit to Redis (potentially including cached PHI) is unencrypted.',
            suggestion: 'Add tls: {} to the Redis client options to enable TLS.',
            regulation: '45 CFR §164.312(e)(2)(ii)',
          }),
        );
      }
    }

    // Memcached
    if (MEMCACHED_RE.test(line)) {
      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'MEDIUM',
          category: 'Unencrypted Cache Connection',
          location: `${filePath}:${i + 1}`,
          summary: 'Memcached connection — inherently unencrypted',
          detail: 'Memcached does not natively support TLS. PHI stored in Memcached is transmitted in plaintext.',
          suggestion: 'Use a TLS-capable cache (Redis with TLS) for PHI data, or use stunnel/mcrouter for Memcached TLS.',
          regulation: '45 CFR §164.312(e)(2)(ii)',
        }),
      );
    }
  }

  return findings;
}

function detectInsecureApiClients(
  filePath: string,
  _content: string,
  lines: string[],
  _options: ScannerOptions,
): AgentFinding[] {
  const findings: AgentFinding[] = [];

  // baseURL / prefixUrl with http://
  const API_CLIENT_RE = /(?:baseURL|base_url|prefixUrl)\s*:\s*['"`](http:\/\/[^'"`]+)['"`]/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = API_CLIENT_RE.exec(line);
    if (match) {
      const url = match[1];
      const host = extractHost(url);
      if (ALLOWLISTED_HOSTS.has(host)) continue;

      findings.push(
        createDeterministicFinding({
          scannerId: SCANNER_ID,
          severity: 'HIGH',
          category: 'Insecure API Client',
          location: `${filePath}:${i + 1}`,
          summary: 'API client configured with HTTP instead of HTTPS',
          detail: `API client baseURL/prefixUrl uses http:// (${host}). PHI transmitted to this endpoint is unencrypted.`,
          suggestion: 'Use https:// for all API client base URLs handling PHI.',
          regulation: '45 CFR §164.312(e)(2)(ii)',
        }),
      );
    }
  }

  return findings;
}

// ── Main Scanner ────────────────────────────────────────────────────

export const encryptionScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Encryption at Rest & Transit',

  scan(files: Map<string, string>, options: ScannerOptions): AgentFinding[] {
    const findings: AgentFinding[] = [];

    for (const [filePath, content] of files) {
      // Skip test files
      if (options.skipTests !== false && isTestFile(filePath)) continue;
      // Only scan JS/TS files
      if (!JS_TS_PATTERN.test(filePath)) continue;

      const lines = content.split('\n');
      const isPhiFile = isPhiRelevantPath(filePath, options.phiSourcePatterns);

      // Weak crypto runs on ALL files (systemic risk)
      findings.push(...detectWeakCrypto(filePath, content, lines));

      // PHI-gated detectors
      if (isPhiFile) {
        findings.push(...detectUnencryptedDatabases(filePath, content, lines, options));
        findings.push(...detectUnencryptedStorage(filePath, content, lines, options, true));
        findings.push(...detectUnencryptedCache(filePath, content, lines, options));
        findings.push(...detectInsecureApiClients(filePath, content, lines, options));
      } else {
        // For storage, check even in non-PHI files if bucket name has PHI keywords
        findings.push(...detectUnencryptedStorage(filePath, content, lines, options, false));
      }
    }

    return findings;
  },
};
