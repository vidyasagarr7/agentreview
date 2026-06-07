import { describe, it, expect } from 'vitest';
import { redactSecrets, shannonEntropy } from './redact.js';

describe('redactSecrets', () => {
  it('redacts AWS access keys', () => {
    const input = 'aws_key = "AKIA1234567890ABCDEF"';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_AWS_KEY]');
    expect(redacted).not.toContain('AKIA1234567890ABCDEF');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts GitHub tokens (ghp_)', () => {
    const input = 'token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_GH_TOKEN]');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts GitHub tokens (gho_)', () => {
    const input = 'token = "gho_abcdefghijklmnopqrstuvwxyz1234567890"';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_GH_TOKEN]');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts OpenAI keys', () => {
    const input = 'openai_key = "sk-abcdefghijklmnopqrstuvwxyz12345678901234567890ab"';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_OPENAI_KEY]');
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz12345678901234567890ab');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts private key blocks', () => {
    const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB
aFDrBz9vFqU4yplnMPGwsV/k1JuZ4o1JjP0q5fE3JkB1JZqP2J8e5R0
-----END RSA PRIVATE KEY-----`;
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
    expect(redacted).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(count).toBe(1);
  });

  it('redacts connection strings', () => {
    const input = 'DATABASE_URL="postgres://user:pass@host:5432/db"';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_CONN_STRING]');
    expect(redacted).not.toContain('postgres://user:pass@host:5432/db');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts mongodb connection strings', () => {
    const input = 'MONGO_URI="mongodb://admin:secret@mongo.example.com:27017/mydb"';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_CONN_STRING]');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('passes normal code through unchanged', () => {
    const input = `function hello() {
  const name = "world";
  console.log(\`Hello, \${name}!\`);
  return 42;
}`;
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toBe(input);
    expect(count).toBe(0);
  });

  it('returns accurate count', () => {
    const input = `
      key1 = "AKIA1234567890ABCDEF"
      key2 = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
      key3 = "sk-abcdefghijklmnopqrstuvwxyz12345678901234567890ab"
    `;
    const { count } = redactSecrets(input);
    expect(count).toBe(3);
  });

  it('catches multiple secrets in one file', () => {
    const input = `
      AWS_KEY=AKIA1234567890ABCDEF
      GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890
      OPENAI=sk-abcdefghijklmnopqrstuvwxyz12345678901234567890ab
      DB=postgres://user:pass@host:5432/db
    `;
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_AWS_KEY]');
    expect(redacted).toContain('[REDACTED_GH_TOKEN]');
    expect(redacted).toContain('[REDACTED_OPENAI_KEY]');
    expect(redacted).toContain('[REDACTED_CONN_STRING]');
    expect(count).toBe(4);
  });

  // --- New patterns from vibeshub analysis ---

  it('redacts JWTs', () => {
    const input = 'token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_JWT]');
    expect(redacted).not.toContain('eyJhbGci');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts env assignments with secret-like keys', () => {
    const input = 'MY_SECRET_KEY=abcdef1234567890abcdef1234567890';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('MY_SECRET_KEY=[REDACTED_ENV]');
    expect(redacted).not.toContain('abcdef1234567890abcdef1234567890');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts env assignments for TOKEN patterns', () => {
    const input = 'API_TOKEN=xK9mL2pQ7rS4tU6wY8zA1bC3dE5fG7hI';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('API_TOKEN=[REDACTED_ENV]');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('does not redact normal env assignments', () => {
    const input = 'NODE_ENV=production';
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toBe(input);
    expect(count).toBe(0);
  });

  it('redacts GitHub tokens with ghs_ and ghr_ prefixes', () => {
    const input = 'token = "ghs_abcdefghijklmnopqrstuvwxyz1234567890"';
    const { redacted } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_GH_TOKEN]');
  });
});

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('returns 0 for single repeated character', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBe(0);
  });

  it('returns 1 for two equally distributed characters', () => {
    expect(shannonEntropy('abababab')).toBeCloseTo(1.0, 4);
  });

  it('returns high entropy for random-looking strings', () => {
    // A string with many unique chars should have high entropy
    const highEntropy = 'aB3$cD7!eF9@gH2#iJ5%kL8^mN0&oP4';
    expect(shannonEntropy(highEntropy)).toBeGreaterThan(4.0);
  });

  it('returns low entropy for repetitive strings', () => {
    const lowEntropy = 'aaabbbcccaaabbbcccaaabbbcccaaabbb';
    expect(shannonEntropy(lowEntropy)).toBeLessThan(2.0);
  });
});

describe('entropy-based redaction', () => {
  it('redacts high-entropy quoted tokens >= 32 chars', () => {
    const token = 'xK9mL2pQ7rS4tU6wY8zA1bC3dE5fG7hI';
    const input = `secret = "${token}"`;
    const { redacted, count } = redactSecrets(input);
    expect(redacted).toContain('[REDACTED_HIGH_ENTROPY]');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('does NOT redact low-entropy quoted tokens', () => {
    const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const input = `value = "${token}"`;
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('[REDACTED_HIGH_ENTROPY]');
  });

  it('does NOT redact short tokens even with high entropy', () => {
    const input = 'short = "xK9mL2p"';
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('[REDACTED');
  });
});
