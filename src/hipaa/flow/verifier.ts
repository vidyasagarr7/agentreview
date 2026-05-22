// ─── verifier.ts — LLM-based PHI flow path verification ─────────────────────

import pLimit from 'p-limit';
import type { FindingSeverity } from '../../types/index.js';
import type {
  PhiFlowPath,
  VerifiedPath,
  LLMClient,
  FileContentMap,
  FlowProgressCallback,
} from './types.js';
import { VerifierResponseSchema, validateWithRetry } from './schema.js';
import { VERIFIER_SYSTEM_PROMPT, VERIFIER_USER_PROMPT } from './prompts.js';
import type { BaaRegistry } from '../baa-registry.js';
import { classifyEndpoint } from '../baa-registry.js';

// ─── Severity Escalation ────────────────────────────────────────────────────

const SEVERITY_UP: Record<FindingSeverity, FindingSeverity> = {
  INFO: 'LOW',
  LOW: 'MEDIUM',
  MEDIUM: 'HIGH',
  HIGH: 'CRITICAL',
  CRITICAL: 'CRITICAL',
};

// ─── External Sink Types ────────────────────────────────────────────────────

const EXTERNAL_SINK_TYPES = new Set([
  'external-api',
  'webhook',
  'storage',
  'analytics',
  'error-tracking',
  'notification',
]);

// ─── Code Snippet Extraction ────────────────────────────────────────────────

function getSnippet(
  fileContents: FileContentMap,
  file: string,
  line: number,
  radius = 5,
): string {
  const content = fileContents.get(file);
  if (!content) return `(file not available: ${file})`;
  const lines = content.split('\n');
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines
    .slice(start, end)
    .map((l, i) => {
      const lineNum = start + i + 1;
      const marker = lineNum === line ? '>>>' : '   ';
      return `${marker} ${lineNum}: ${l}`;
    })
    .join('\n');
}

// ─── Prompt Helpers ─────────────────────────────────────────────────────────
// Uses prompts from prompts.ts (single source of truth)

function buildBaaStatusLabel(baaStatus: 'covered' | 'no-baa' | 'unknown' | null): string {
  if (!baaStatus) return 'N/A — sink is not an external service';
  if (baaStatus === 'covered') return 'BAA IN PLACE — data transfer may be permissible under BAA terms';
  if (baaStatus === 'no-baa') return 'NO BAA — sending PHI to this endpoint is a HIPAA violation';
  return 'BAA STATUS UNKNOWN — treat as potential violation';
}

function buildPromptForPath(
  path: PhiFlowPath,
  fileContents: FileContentMap,
  baaStatus: 'covered' | 'no-baa' | 'unknown' | null,
): { system: string; user: string } {
  const sourceCode = getSnippet(fileContents, path.source.file, path.source.line, 8);
  const sinkCode = getSnippet(fileContents, path.sink.file, path.sink.line, 8);
  const baaLabel = buildBaaStatusLabel(baaStatus);

  return {
    system: VERIFIER_SYSTEM_PROMPT,
    user: VERIFIER_USER_PROMPT(path, sourceCode, sinkCode, baaLabel),
  };
}

// ─── Timeout Utility ────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ─── Main Verifier ──────────────────────────────────────────────────────────

export async function verifyPaths(
  paths: PhiFlowPath[],
  fileContents: FileContentMap,
  llm: LLMClient,
  baaRegistry: BaaRegistry | undefined,
  options: {
    concurrency?: number;
    callTimeoutMs?: number;
    failureAbortThreshold?: number;
    onProgress?: FlowProgressCallback;
  } = {},
): Promise<VerifiedPath[]> {
  const {
    concurrency = 3,
    callTimeoutMs = 30_000,
    failureAbortThreshold = 0.3,
    onProgress,
  } = options;

  if (paths.length === 0) return [];

  const limit = pLimit(concurrency);
  const results: VerifiedPath[] = [];
  let completed = 0;
  let failures = 0;
  let aborted = false;

  const tasks = paths.map((path) =>
    limit(async () => {
      if (aborted) return;

      // Determine BAA status for external sinks
      let baaStatus: 'covered' | 'no-baa' | 'unknown' | null = null;
      if (EXTERNAL_SINK_TYPES.has(path.sink.type) && baaRegistry) {
        baaStatus = classifyEndpoint(path.sink.name, baaRegistry);
      }

      const { system, user } = buildPromptForPath(path, fileContents, baaStatus);

      try {
        const rawResponse = await withTimeout(
          llm.chat([
            { role: 'system', content: system },
            { role: 'user', content: user },
          ]),
          callTimeoutMs,
          `verify ${path.source.file}→${path.sink.file}`,
        );

        const validated = await validateWithRetry(
          rawResponse,
          VerifierResponseSchema,
          async (error) => {
            return withTimeout(
              llm.chat([
                { role: 'system', content: system },
                { role: 'user', content: user },
                {
                  role: 'user' as const,
                  content: `Your previous response failed validation:\n${error}\n\nPlease respond again with valid JSON matching the required schema.`,
                },
              ]),
              callTimeoutMs,
              `retry-verify ${path.source.file}→${path.sink.file}`,
            );
          },
        );

        if (!validated) {
          failures++;
          return;
        }

        // Build the verified path
        // Use verifier's confidence if it's higher than heuristic
        const verifierConf = validated.confidence;
        let finalConfidence = path.confidence;
        const confOrder = { low: 0, medium: 1, high: 2 } as const;
        if (confOrder[verifierConf] > confOrder[finalConfidence]) {
          finalConfidence = verifierConf;
        }

        let finalSeverity = path.severity;
        const baaRelevant = validated.baaRelevant;

        // If verifier confirmed with high confidence, upgrade severity
        if (validated.isLeak && verifierConf === 'high' && finalSeverity === 'MEDIUM') {
          finalSeverity = 'HIGH';
        }

        // Severity escalation: external sink without BAA
        if (
          validated.isLeak &&
          baaStatus === 'no-baa' &&
          EXTERNAL_SINK_TYPES.has(path.sink.type)
        ) {
          finalSeverity = SEVERITY_UP[finalSeverity];
        }

        const verifiedPath: VerifiedPath = {
          ...path,
          confidence: finalConfidence,
          severity: finalSeverity,
          isLeak: validated.isLeak,
          explanation: validated.explanation,
          baaRelevant,
          verifierConfidence: verifierConf,
          ...(baaStatus ? { baaStatus: baaStatus } : {}),
        };

        // Only keep verified leaks
        if (verifiedPath.isLeak) {
          results.push(verifiedPath);
        }
      } catch {
        failures++;
      } finally {
        completed++;
        onProgress?.('verifying', completed, paths.length);
        // Check abort threshold after every attempt (completed includes failures)
        if (completed >= 3 && failures / completed > failureAbortThreshold) {
          aborted = true;
        }
      }
    }),
  );

  await Promise.all(tasks);

  return results;
}
