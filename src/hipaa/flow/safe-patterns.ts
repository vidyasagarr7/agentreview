// ─── safe-patterns.ts — Safe pattern matching for PHI flow paths ─────────────

import type { FlowSafePatternConfig, PhiFlowPath } from './types.js';

// ─── Glob → RegExp ────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcard = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${withWildcard}$`, 'i');
}

// ─── Default Built-in Patterns ────────────────────────────────────────────────

const DEFAULT_PATTERNS: FlowSafePatternConfig[] = [
  { pattern: 'redact*', type: 'sanitizer' },
  { pattern: 'mask*', type: 'sanitizer' },
  { pattern: 'sanitize*', type: 'sanitizer' },
  { pattern: 'toPublic*', type: 'sanitizer' },
];

// ─── Confidence downgrade helper ──────────────────────────────────────────────

function downgradeConfidence(c: PhiFlowPath['confidence']): PhiFlowPath['confidence'] {
  if (c === 'high') return 'medium';
  if (c === 'medium') return 'low';
  return 'low';
}

// ─── SafePatternMatcher ──────────────────────────────────────────────────────

export class SafePatternMatcher {
  private readonly sanitizers: RegExp[];
  private readonly expectedSinks: RegExp[];
  private readonly compliantSinks: RegExp[];
  private readonly projections: RegExp[];

  constructor(patterns: FlowSafePatternConfig[]) {
    const all = [...DEFAULT_PATTERNS, ...patterns];

    this.sanitizers = all
      .filter((p) => p.type === 'sanitizer')
      .map((p) => globToRegex(p.pattern));

    this.expectedSinks = all
      .filter((p) => p.type === 'expected-sink')
      .map((p) => globToRegex(p.pattern));

    this.compliantSinks = all
      .filter((p) => p.type === 'compliant-sink')
      .map((p) => globToRegex(p.pattern));

    this.projections = all
      .filter((p) => p.type === 'projection')
      .map((p) => globToRegex(p.pattern));
  }

  matchSanitizer(functionName: string): boolean {
    return this.sanitizers.some((re) => re.test(functionName));
  }

  matchExpectedSink(sinkName: string): boolean {
    return this.expectedSinks.some((re) => re.test(sinkName));
  }

  matchCompliantSink(sinkName: string): boolean {
    return this.compliantSinks.some((re) => re.test(sinkName));
  }

  matchProjection(functionName: string): boolean {
    return this.projections.some((re) => re.test(functionName));
  }

  applySafePatterns(paths: PhiFlowPath[]): PhiFlowPath[] {
    return paths.map((path) => {
      let result = { ...path };

      // Check intermediates for sanitizers and projections
      for (const intermediate of path.intermediates) {
        if (this.matchSanitizer(intermediate.name)) {
          result = { ...result, confidence: downgradeConfidence(result.confidence) };
        }
        if (this.matchProjection(intermediate.name)) {
          result = { ...result, confidence: downgradeConfidence(result.confidence) };
        }
      }

      // Check sink for expected-sink or compliant-sink
      if (this.matchExpectedSink(path.sink.name) || this.matchCompliantSink(path.sink.name)) {
        result = { ...result, severity: 'INFO' };
      }

      return result;
    });
  }
}
