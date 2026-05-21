import type { SecurityDomain, ClassifiedFile, SourceReader } from './types.js';

// ─── Priority Classification ──────────────────────────────────────────────────

const P0_PATTERNS = [
  /auth/i,
  /login/i,
  /session/i,
  /\bjwt\b/i,
  /oauth/i,
  /permission/i,
  /\brbac\b/i,
  /\bacl\b/i,
  /middleware[./].*auth/i,
  /\bcrypto\b/i,
];

const P1_PATTERNS = [
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)Dockerfile/,
  /(?:^|\/)docker-compose/,
  /(?:^|\/)\.github\/workflows\//,
  /(?:^|\/)config\//,
  /\.key$/,
  /\.pem$/,
  /\.cert$/,
  /credentials/i,
  /secrets/i,
];

const P2_PATTERNS = [
  /(?:^|\/)routes\//,
  /(?:^|\/)controllers\//,
  /(?:^|\/)handlers\//,
  /(?:^|\/)api\//,
  /(?:^|\/)graphql\//,
  /(?:^|\/)mutations\//,
  /(?:^|\/)validators\//,
  /(?:^|\/)middleware\//,
];

const P3_PATTERNS = [
  /(?:^|\/)models\//,
  /(?:^|\/)services\//,
  /(?:^|\/)repositories\//,
  /(?:^|\/)database\//,
  /(?:^|\/)migrations\//,
];

const P4_PATTERNS = [
  /(?:^|\/)test\//,
  /(?:^|\/)spec\//,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)scripts\//,
  /(?:^|\/)docs\//,
  /(?:^|\/)README/,
  /(?:^|\/)LICENSE/,
];

/**
 * Classify a file path into a security priority level (0 = highest, 4 = lowest).
 */
export function classifyPriority(filePath: string): number {
  // Check P4 first — test/docs/scripts are always low priority
  if (P4_PATTERNS.some((p) => p.test(filePath))) return 4;
  if (P0_PATTERNS.some((p) => p.test(filePath))) return 0;
  if (P1_PATTERNS.some((p) => p.test(filePath))) return 1;
  if (P2_PATTERNS.some((p) => p.test(filePath))) return 2;
  if (P3_PATTERNS.some((p) => p.test(filePath))) return 3;
  return 4;
}

// ─── Domain Classification ────────────────────────────────────────────────────

const DOMAIN_RULES: Array<{ domain: SecurityDomain; patterns: RegExp[] }> = [
  {
    domain: 'auth',
    patterns: [
      /auth/i,
      /login/i,
      /session/i,
      /\bjwt\b/i,
      /oauth/i,
      /permission/i,
      /\brbac\b/i,
      /\bacl\b/i,
    ],
  },
  {
    domain: 'secrets',
    patterns: [
      /(?:^|\/)\.env(?:\.|$)/,
      /credentials/i,
      /secret/i,
      /\.key$/,
      /\.pem$/,
      /(?:^|\/)docker-compose.*\.ya?ml$/,
    ],
  },
  {
    domain: 'injection',
    patterns: [
      /(?:^|\/)routes\//,
      /(?:^|\/)controllers\//,
      /(?:^|\/)handlers\//,
      /(?:^|\/)api\//,
      /(?:^|\/)graphql\//,
      /query/i,
      /(?:^|\/)validators\//,
    ],
  },
  {
    domain: 'config',
    patterns: [
      /(?:^|\/)Dockerfile/,
      /(?:^|\/)docker-compose/,
      /(?:^|\/)terraform\/.*\.tf$/,
      /(?:^|\/)k8s\//,
      /\.hcl$/,
      /nginx\.conf$/,
      /(?:^|\/)\.github\/workflows\//,
    ],
  },
  {
    domain: 'deps',
    patterns: [
      /(?:^|\/)package\.json$/,
      /(?:^|\/)requirements\.txt$/,
      /(?:^|\/)go\.mod$/,
      /(?:^|\/)Cargo\.toml$/,
      /(?:^|\/)Gemfile$/,
      /(?:^|\/)pom\.xml$/,
      /(?:^|\/)build\.gradle$/,
      /(?:^|\/)pyproject\.toml$/,
    ],
  },
  {
    domain: 'crypto',
    patterns: [
      /crypto/i,
      /crypt/i,
      /cipher/i,
      /\bhash\b/i,
      /\bsign\b/i,
      /certificate/i,
      /\btls\b/i,
      /\bssl\b/i,
    ],
  },
  {
    domain: 'data-flow',
    patterns: [
      /pipe/i,
      /stream/i,
      /transform/i,
      /\betl\b/i,
      /queue/i,
      /worker/i,
      /consumer/i,
      /producer/i,
    ],
  },
];

/**
 * Classify a file path into a security domain.
 */
export function classifyDomain(filePath: string): SecurityDomain {
  for (const rule of DOMAIN_RULES) {
    if (rule.patterns.some((p) => p.test(filePath))) {
      return rule.domain;
    }
  }
  return 'general';
}

// ─── File Discovery ───────────────────────────────────────────────────────────

/**
 * Discover and classify all files from a source reader, optionally filtering
 * to specific security domains. Results are sorted by priority (P0 first).
 */
export async function discoverFiles(
  reader: SourceReader,
  focus?: SecurityDomain[],
): Promise<ClassifiedFile[]> {
  const entries = await reader.listFiles();

  let classified: ClassifiedFile[] = entries.map((entry) => ({
    path: entry.path,
    size: entry.size,
    priority: classifyPriority(entry.path),
    domain: classifyDomain(entry.path),
  }));

  if (focus && focus.length > 0) {
    const focusSet = new Set(focus);
    classified = classified.filter((f) => focusSet.has(f.domain));
  }

  classified.sort((a, b) => a.priority - b.priority);

  return classified;
}
