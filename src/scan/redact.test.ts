import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact.js';

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
});
