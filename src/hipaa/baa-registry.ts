import type { HipaaConfig } from '../config/repo-config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BaaRegistry {
  covered: string[];   // Domains/patterns with signed BAA
  noBaa: string[];     // Domains/patterns explicitly without BAA
}

// ─── Default Well-Known BAA-Capable Services ──────────────────────────────────
// Default BAA-covered services (verified as of 2024-2026).
// Organizations should customize via .agentreview.yml hipaa.baa-covered.
// Having a BAA available does NOT mean it's signed — always verify with your compliance team.

export const DEFAULT_BAA_COVERED = [
  '*.amazonaws.com',           // AWS (BAA available)
  '*.azure.com',               // Azure (BAA available)
  '*.azure-api.net',
  '*.google.com',              // GCP (BAA available)
  '*.googleapis.com',
  '*.twilio.com',              // Twilio (BAA available)
  '*.salesforce.com',          // Salesforce (BAA available)
  '*.redoxengine.com',         // Redox (healthcare middleware, BAA standard)
  '*.1up.health',              // 1upHealth (BAA available)
  '*.snowflakecomputing.com',  // Snowflake (BAA available)
  '*.databricks.com',          // Databricks (BAA available for healthcare)
  '*.supabase.co',             // Supabase (BAA available)
  '*.mongodb.net',             // MongoDB Atlas (BAA available)
  '*.openai.com',              // OpenAI (BAA available since 2024 via API enterprise)
  '*.anthropic.com',           // Anthropic (BAA available since 2024)
];

// ─── Default Well-Known Services Without BAA ──────────────────────────────────

export const DEFAULT_NO_BAA = [
  '*.sentry.io',           // Sentry (no BAA)
  '*.logrocket.com',       // LogRocket (no BAA)
  '*.mixpanel.com',        // Mixpanel (no BAA)
  '*.hotjar.com',          // Hotjar (no BAA)
  '*.intercom.io',         // Intercom (no BAA)
];

// ─── Domain Sanitization ──────────────────────────────────────────────────────

/**
 * Sanitize a domain string to prevent prompt injection and normalize input.
 * Strips newlines, control characters, and excessive whitespace.
 */
function sanitizeDomain(domain: string): string {
  return domain.replace(/[\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 253);
}

// ─── Glob Pattern Matching ────────────────────────────────────────────────────

/**
 * Simple prefix glob matching. Supports `*.example.com` patterns only.
 * Does NOT support complex globs like `s3.*.amazonaws.com` or `**` patterns.
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
    covered: [...coveredSet].map(sanitizeDomain).filter(Boolean),
    noBaa: [...noBaaSet].map(sanitizeDomain).filter(Boolean),
  };
}

// ─── Classify Endpoint ────────────────────────────────────────────────────────

/**
 * Classify a URL or hostname against the BAA registry.
 * Returns 'covered', 'no-baa', or 'unknown'.
 */
/**
 * Classify a URL or hostname against the BAA registry.
 * Returns 'covered', 'no-baa', or 'unknown'.
 *
 * noBaa is checked FIRST (fail-closed): if a domain appears in both lists,
 * it is treated as no-baa for HIPAA safety. Unknown domains also remain
 * 'unknown' so they can be flagged for manual BAA verification.
 */
export function classifyEndpoint(urlOrHostname: string, registry: BaaRegistry): 'covered' | 'no-baa' | 'unknown' {
  const hostname = extractHostname(urlOrHostname);
  if (!hostname) return 'unknown';

  // Check no-BAA first (fail-closed for HIPAA safety)
  if (registry.noBaa.some(pattern => matchesPattern(hostname, pattern))) {
    return 'no-baa';
  }
  if (registry.covered.some(pattern => matchesPattern(hostname, pattern))) {
    return 'covered';
  }
  return 'unknown';
}

/**
 * Extract a hostname from a URL string or raw hostname.
 * Returns null for malformed inputs.
 */
function extractHostname(urlOrHostname: string): string | null {
  if (!urlOrHostname || typeof urlOrHostname !== 'string') return null;
  try {
    const url = new URL(urlOrHostname.includes('://') ? urlOrHostname : `https://${urlOrHostname}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}
