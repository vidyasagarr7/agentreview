type ReplaceFn = (match: string, ...args: string[]) => string;

const REDACT_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string | ReplaceFn }> = [
  // Specific patterns first (order matters — more specific before general)
  { name: 'Anthropic Key', regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  { name: 'GitHub Token', regex: /gh[pousr]_[a-zA-Z0-9]{30,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { name: 'OpenAI Key', regex: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { name: 'Stripe Key', regex: /(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{10,}/g, replacement: '[REDACTED_STRIPE_KEY]' },
  { name: 'Slack Token', regex: /xox[bprs]-[a-zA-Z0-9-]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { name: 'Connection String', regex: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s'"]+/g, replacement: '[REDACTED_CONN_STRING]' },
  // New patterns from vibeshub analysis
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED_JWT]' },
  { name: 'Env Assignment', regex: /([A-Z][A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD|PASS))=([A-Za-z0-9/+=_-]{16,})/g, replacement: (_match: string, key: string) => `${key}=[REDACTED_ENV]` },
  { name: 'AWS Secret Key', regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, replacement: '[REDACTED_AWS_SECRET]' },
  { name: 'Generic High-Entropy', regex: /(?<=['"])[A-Za-z0-9+\/]{40,}={0,2}(?=['"])/g, replacement: '[REDACTED_BASE64]' },
];

/**
 * Compute Shannon entropy of a string in bits.
 * Used to detect high-entropy tokens that may be secrets.
 */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  const n = s.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ENTROPY_THRESHOLD = 4.0;
const ENTROPY_MIN_LENGTH = 32;
const ENTROPY_TOKEN_RE = /"([A-Za-z0-9_+/=-]{32,})"/g;

export function redactSecrets(content: string): { redacted: string; count: number } {
  let count = 0;
  let redacted = content;

  // Pass 1: Named patterns
  for (const pattern of REDACT_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    if (typeof pattern.replacement === 'function') {
      const fn = pattern.replacement as ReplaceFn;
      redacted = redacted.replace(regex, (...args: string[]) => {
        count++;
        return fn(...args);
      });
    } else {
      redacted = redacted.replace(regex, () => { count++; return pattern.replacement as string; });
    }
  }

  // Pass 2: Shannon entropy detection for unknown high-entropy tokens
  redacted = redacted.replace(ENTROPY_TOKEN_RE, (fullMatch: string, token: string) => {
    if (token.length >= ENTROPY_MIN_LENGTH && shannonEntropy(token) >= ENTROPY_THRESHOLD) {
      // Skip if already redacted
      if (token.startsWith('[REDACTED')) return fullMatch;
      count++;
      return '"[REDACTED_HIGH_ENTROPY]"';
    }
    return fullMatch;
  });

  return { redacted, count };
}
