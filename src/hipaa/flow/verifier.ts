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

// ─── Prompts ────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a HIPAA compliance verifier analyzing PHI (Protected Health Information) data flow paths in source code.

Your job is to determine whether a given data flow path constitutes a genuine PHI leak or whether the data is properly sanitized, anonymized, or handled in a HIPAA-compliant manner.

Respond with a JSON object matching this exact schema:
{
  "isLeak": boolean,       // true if PHI is exposed without proper safeguards
  "confidence": "high" | "medium" | "low",
  "explanation": string,   // brief explanation of your assessment
  "baaRelevant": boolean   // true if BAA status is relevant to this path
}

Be precise. Only flag real leaks — not projections, anonymized data, or de-identified aggregates.`;
}

function buildUserPrompt(
  path: PhiFlowPath,
  fileContents: FileContentMap,
  baaStatus: 'covered' | 'no-baa' | 'unknown' | null,
): string {
  const sourceSnippet = getSnippet(fileContents, path.source.file, path.source.line);
  const sinkSnippet = getSnippet(fileContents, path.sink.file, path.sink.line);

  const intermediateDetails = path.intermediates
    .map((step, i) => {
      const snippet = getSnippet(fileContents, step.file, step.line);
      return `Step ${i + 1}: ${step.name} (${step.mechanism}) in ${step.file}:${step.line}\n${snippet}`;
    })
    .join('\n\n');

  let baaSection = '';
  if (baaStatus) {
    const statusLabel =
      baaStatus === 'covered'
        ? 'BAA IN PLACE — data transfer may be permissible under BAA terms'
        : baaStatus === 'no-baa'
          ? 'NO BAA — sending PHI to this endpoint is a HIPAA violation'
          : 'BAA STATUS UNKNOWN — treat as potential violation';
    baaSection = `\n\nBAA Status for sink endpoint: ${statusLabel}`;
  }

  return `Analyze this PHI data flow path for HIPAA compliance:

SOURCE: ${path.source.name} (${path.source.type}) in ${path.source.file}:${path.source.line}
${sourceSnippet}

${intermediateDetails ? `INTERMEDIATE STEPS:\n${intermediateDetails}\n` : ''}SINK: ${path.sink.name} (${path.sink.type}) in ${path.sink.file}:${path.sink.line}
${sinkSnippet}

Current severity: ${path.severity}
Confidence: ${path.confidence}${baaSection}

Is this a genuine PHI leak? Respond with the JSON schema described in your instructions.`;
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

      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt(path, fileContents, baaStatus);

      try {
        const rawResponse = await withTimeout(
          llm.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
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
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
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
          checkAbortThreshold();
          return;
        }

        // Build the verified path
        let finalSeverity = path.severity;
        const baaRelevant = validated.baaRelevant;

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
          severity: finalSeverity,
          isLeak: validated.isLeak,
          explanation: validated.explanation,
          baaRelevant,
          ...(baaStatus ? { baaStatus: baaStatus } : {}),
        };

        // Only keep verified leaks
        if (verifiedPath.isLeak) {
          results.push(verifiedPath);
        }
      } catch {
        failures++;
        checkAbortThreshold();
        return;
      } finally {
        completed++;
        onProgress?.('verifying', completed, paths.length);
      }
    }),
  );

  function checkAbortThreshold(): void {
    const attemptsSoFar = completed + failures;
    if (attemptsSoFar > 0 && failures / attemptsSoFar > failureAbortThreshold) {
      aborted = true;
    }
  }

  await Promise.all(tasks);

  return results;
}
