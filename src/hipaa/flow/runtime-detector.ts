// ─── runtime-detector.ts — Detect async/runtime PHI flow patterns ────────────

import type { RuntimeFlowDescriptor, RuntimeFlowType } from './types.js';

// ─── Pattern Definitions ──────────────────────────────────────────────────────

interface PatternDef {
  type: RuntimeFlowType;
  regex: RegExp;
  /** Index of capture group containing channel/topic name (if any) */
  channelGroup?: number;
}

const PATTERNS: PatternDef[] = [
  // Event emitters — emit
  {
    type: 'event-emit',
    regex: /\.emit\(\s*(?:['"`]([^'"`]+)['"`]|([^,)]+))/g,
    channelGroup: 1,
  },
  // Event listeners — on / addEventListener / once
  {
    type: 'event-listen',
    regex: /\.(?:on|addEventListener|once)\(\s*(?:['"`]([^'"`]+)['"`]|([^,)]+))/g,
    channelGroup: 1,
  },
  // Middleware chains — app.use / router.verb / next()
  {
    type: 'middleware-chain',
    regex: /(?:app\.use|router\.(?:get|post|put|delete|use))\(\s*(?:['"`]([^'"`]+)['"`])?/g,
    channelGroup: 1,
  },
  {
    type: 'middleware-chain',
    regex: /\bnext\(/g,
  },
  // Redis publish (before general .publish to avoid shadowing)
  {
    type: 'queue-publish',
    regex: /redis\.publish\(\s*(?:['"`]([^'"`]+)['"`]|([^,)]+))/g,
    channelGroup: 1,
  },
  // Redis subscribe (before general .subscribe to avoid shadowing)
  {
    type: 'queue-subscribe',
    regex: /redis\.subscribe\(\s*(?:['"`]([^'"`]+)['"`]|([^,)]+))/g,
    channelGroup: 1,
  },
  // Queue publish — .send / .publish / .produce / producer.send (exclude redis.)
  {
    type: 'queue-publish',
    regex: /(?:producer\.send|(?<!redis)\.(?:send|publish|produce))\(\s*(?:\{[^}]*topic:\s*['"`]([^'"`]+)['"`])?/g,
    channelGroup: 1,
  },
  // Queue subscribe — .subscribe / .consume / consumer.run / consumer.subscribe (exclude redis.)
  {
    type: 'queue-subscribe',
    regex: /(?:consumer\.(?:run|subscribe)|(?<!redis)\.(?:subscribe|consume))\(\s*(?:\{[^}]*topic:\s*['"`]([^'"`]+)['"`])?/g,
    channelGroup: 1,
  },
  // Healthcare middleware — Asymmetrik
  {
    type: 'middleware-chain',
    regex: /\bFhirServer\b/g,
  },
  {
    type: 'middleware-chain',
    regex: /@asymmetrik\/node-fhir-server-core/g,
  },
  // Healthcare middleware — Medplum
  {
    type: 'middleware-chain',
    regex: /\bMedplumClient\b/g,
  },
  {
    type: 'middleware-chain',
    regex: /@medplum\/core/g,
  },
  // Healthcare middleware — fhirclient
  {
    type: 'middleware-chain',
    regex: /\bfhirclient\b/g,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a character offset in `source` to a 1-based line number. */
function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Try to extract the enclosing function name for a given offset. */
function findEnclosingFunction(source: string, offset: number): string {
  // Look backwards from offset for function/method/arrow declarations
  const before = source.slice(0, offset);

  // Named function: function foo(
  const fnMatch = before.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>))[^]*$/);
  if (fnMatch) {
    return fnMatch[1] ?? fnMatch[2] ?? '<anonymous>';
  }

  // Method: foo( or async foo(
  const methodMatch = before.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{[^]*$/);
  if (methodMatch && methodMatch[1] !== 'if' && methodMatch[1] !== 'for' && methodMatch[1] !== 'while') {
    return methodMatch[1]!;
  }

  return '<anonymous>';
}

// ─── Main Detector ────────────────────────────────────────────────────────────

export function detectRuntimeFlows(
  filePath: string,
  source: string,
): RuntimeFlowDescriptor[] {
  const results: RuntimeFlowDescriptor[] = [];

  for (const pattern of PATTERNS) {
    // Reset regex state (important since /g is stateful)
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(source)) !== null) {
      const offset = match.index;
      const line = offsetToLine(source, offset);
      const functionName = findEnclosingFunction(source, offset);

      let channel = '<unknown>';
      if (pattern.channelGroup !== undefined) {
        const literal = match[pattern.channelGroup];
        const dynamic = match[pattern.channelGroup + 1];
        if (literal) {
          channel = literal;
        } else if (dynamic) {
          channel = '<dynamic>';
        } else {
          channel = '<unknown>';
        }
      }

      results.push({
        type: pattern.type,
        channel,
        functionName,
        line,
      });
    }
  }

  // Deduplicate: if the same type+line appears multiple times, keep the first (which has better channel info)
  const seen = new Set<string>();
  return results.filter(r => {
    const key = `${r.type}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
