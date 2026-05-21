import { createDeterministicFinding } from './types.js';
import type { Scanner, ScannerOptions } from './types.js';

const SCANNER_ID = 'http-phi';

// Hosts that are safe for plain HTTP
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

const HTTP_URL_RE = /http:\/\/([^\s"'`,;)}\]]+)/gi;

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(path) || /\/__tests__\//.test(path);
}

function isPhiRelevantPath(path: string): boolean {
  const lower = path.toLowerCase();
  return PHI_PATH_KEYWORDS.some((kw) => lower.includes(kw));
}

function matchesPhiSourcePatterns(path: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pat) => {
    // Simple glob: convert * to .* for matching
    const re = new RegExp(pat.replace(/\*/g, '.*'));
    return re.test(path);
  });
}

function extractHost(urlFragment: string): string {
  // urlFragment is everything after "http://"
  // Extract host (possibly with port)
  const hostPort = urlFragment.split('/')[0].split('?')[0].split('#')[0];
  // Strip port
  const host = hostPort.replace(/:\d+$/, '');
  return host;
}

export const httpPhiScanner: Scanner = {
  id: SCANNER_ID,
  name: 'HTTP URLs in PHI-handling code',

  scan(files, options) {
    const findings: ReturnType<typeof createDeterministicFinding>[] = [];

    for (const [filePath, content] of files) {
      // Skip test files
      if (options.skipTests !== false && isTestFile(filePath)) continue;

      // Determine if file is PHI-relevant
      const phiRelevant =
        isPhiRelevantPath(filePath) ||
        matchesPhiSourcePatterns(filePath, options.phiSourcePatterns);

      // Only flag in PHI-relevant files
      if (!phiRelevant) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match: RegExpExecArray | null;
        HTTP_URL_RE.lastIndex = 0;

        while ((match = HTTP_URL_RE.exec(line)) !== null) {
          const host = extractHost(match[1]);
          if (ALLOWLISTED_HOSTS.has(host)) continue;

          findings.push(
            createDeterministicFinding({
              scannerId: SCANNER_ID,
              severity: 'CRITICAL',
              category: 'Unencrypted Transport',
              location: `${filePath}:${i + 1}`,
              summary: `Plain HTTP URL in PHI-handling file`,
              detail: `Found \`http://${match[1]}\` — PHI must be transmitted over TLS (HTTPS). Plain HTTP exposes data in transit.`,
              suggestion: `Change to \`https://\` or confirm this URL never carries PHI and add to the scanner allowlist.`,
              regulation: '45 CFR §164.312(e)',
            }),
          );
        }
      }
    }

    return findings;
  },
};
