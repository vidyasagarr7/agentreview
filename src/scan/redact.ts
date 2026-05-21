const REDACT_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  { name: 'GitHub Token', regex: /ghp_[a-zA-Z0-9]{36}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { name: 'GitHub Token (gho)', regex: /gho_[a-zA-Z0-9]{36}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { name: 'OpenAI Key', regex: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { name: 'Connection String', regex: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s'"]+/g, replacement: '[REDACTED_CONN_STRING]' },
  { name: 'Generic High-Entropy', regex: /(?<=['"])[A-Za-z0-9+\/]{40,}={0,2}(?=['"])/g, replacement: '[REDACTED_BASE64]' },
];

export function redactSecrets(content: string): { redacted: string; count: number } {
  let count = 0;
  let redacted = content;
  for (const pattern of REDACT_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    redacted = redacted.replace(regex, () => { count++; return pattern.replacement; });
  }
  return { redacted, count };
}
