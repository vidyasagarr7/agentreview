import type { HipaaConfig } from '../config/repo-config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BaaRegistry {
  covered: string[];   // Domains/patterns with signed BAA
  noBaa: string[];     // Domains/patterns explicitly without BAA
}

// ─── Default Well-Known BAA-Capable Services ──────────────────────────────────

export const DEFAULT_BAA_COVERED = [
  '*.amazonaws.com',      // AWS (BAA available)
  '*.azure.com',          // Azure (BAA available)
  '*.azure-api.net',
  '*.google.com',         // GCP (BAA available)
  '*.googleapis.com',
  '*.twilio.com',         // Twilio (BAA available)
  '*.salesforce.com',     // Salesforce (BAA available)
  '*.redoxengine.com',    // Redox (healthcare middleware, BAA standard)
  '*.1up.health',         // 1upHealth (BAA available)
];

// ─── Default Well-Known Services Without BAA ──────────────────────────────────

export const DEFAULT_NO_BAA = [
  'api.openai.com',        // OpenAI (no BAA as of 2026)
  '*.anthropic.com',       // Anthropic (no BAA)
  '*.datadog.com',         // Datadog (no BAA for PHI)
  '*.sentry.io',           // Sentry (no BAA)
  '*.logrocket.com',       // LogRocket (no BAA)
  '*.mixpanel.com',        // Mixpanel (no BAA)
  '*.segment.com',         // Segment (limited BAA)
  '*.hotjar.com',          // Hotjar (no BAA)
  '*.intercom.io',         // Intercom (no BAA)
  '*.slack.com',           // Slack (no BAA for PHI)
];

// ─── Glob Pattern Matching ────────────────────────────────────────────────────

/**
 * Match a hostname against a glob-style pattern.
 * Supports leading `*.` wildcard (matches any subdomain).
 * Exact match otherwise.
 */
function matchesPattern(hostname: string, pattern: string): boolean {
  const lowerHost = hostname.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  if (lowerPattern.startsWith('*.')) {
    const suffix = lowerPattern.slice(1); // e.g. ".amazonaws.com"
    return lowerHost.endsWith(suffix) || lowerHost === lowerPattern.slice(2);
  }

  return lowerHost === lowerPattern;
}

// ─── Build Registry ───────────────────────────────────────────────────────────

/**
 * Build a BAA registry by merging defaults with user configuration.
 * User overrides take precedence — if a user puts a domain in baaCovered
 * that exists in DEFAULT_NO_BAA, it moves to covered.
 */
export function buildBaaRegistry(config?: HipaaConfig): BaaRegistry {
  const userCovered = new Set((config?.baaCovered ?? []).map((d) => d.toLowerCase()));
  const userNoBaa = new Set((config?.noBaa ?? []).map((d) => d.toLowerCase()));

  // Start with defaults
  const coveredSet = new Set(DEFAULT_BAA_COVERED.map((d) => d.toLowerCase()));
  const noBaaSet = new Set(DEFAULT_NO_BAA.map((d) => d.toLowerCase()));

  // User baaCovered additions: add to covered, remove from noBaa
  for (const domain of userCovered) {
    coveredSet.add(domain);
    noBaaSet.delete(domain);
  }

  // User noBaa additions: add to noBaa, remove from covered
  for (const domain of userNoBaa) {
    noBaaSet.add(domain);
    coveredSet.delete(domain);
  }

  return {
    covered: [...coveredSet],
    noBaa: [...noBaaSet],
  };
}

// ─── Classify Endpoint ────────────────────────────────────────────────────────

/**
 * Classify a URL or hostname against the BAA registry.
 * Returns 'covered', 'no-baa', or 'unknown'.
 */
export function classifyEndpoint(urlOrHostname: string, registry: BaaRegistry): 'covered' | 'no-baa' | 'unknown' {
  let hostname: string;

  try {
    // Try parsing as URL first
    const url = new URL(urlOrHostname.includes('://') ? urlOrHostname : `https://${urlOrHostname}`);
    hostname = url.hostname;
  } catch {
    // Fall back to treating it as a raw hostname
    hostname = urlOrHostname;
  }

  // Check covered first (more specific)
  for (const pattern of registry.covered) {
    if (matchesPattern(hostname, pattern)) {
      return 'covered';
    }
  }

  // Check no-baa
  for (const pattern of registry.noBaa) {
    if (matchesPattern(hostname, pattern)) {
      return 'no-baa';
    }
  }

  return 'unknown';
}
