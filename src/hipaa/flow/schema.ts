// ─── schema.ts — Zod schemas for LLM output validation + retry utility ──────

import { z } from 'zod';
import { PHI_SOURCE_TYPES, PHI_SINK_TYPES } from './types.js';

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

export const PhiSourceSchema = z.object({
  name: z.string(),
  line: z.number(),
  type: z.enum(PHI_SOURCE_TYPES),
});

export const PhiSinkSchema = z.object({
  name: z.string(),
  line: z.number(),
  type: z.enum(PHI_SINK_TYPES),
});

export const PhiTransformSchema = z.object({
  name: z.string(),
  line: z.number(),
  inputParam: z.string(),
  outputReturn: z.boolean(),
  mechanism: z.enum(['direct', 'event-emit', 'middleware-next', 'queue-publish', 'callback', 'fhir-bundle-unwrap']),
});

export const PhiExportSchema = z.object({
  name: z.string(),
  containsPhi: z.boolean(),
});

export const RuntimeFlowDescriptorSchema = z.object({
  type: z.enum(['event-emit', 'event-listen', 'middleware-chain', 'queue-publish', 'queue-subscribe']),
  channel: z.string(),
  functionName: z.string(),
  line: z.number(),
  dataParam: z.string().optional(),
});

export const FilePhiProfileSchema = z.object({
  sources: z.array(PhiSourceSchema),
  sinks: z.array(PhiSinkSchema),
  transforms: z.array(PhiTransformSchema),
  exports: z.array(PhiExportSchema),
  imports: z.array(z.object({
    from: z.string(),
    names: z.array(z.string()),
  })).optional().default([]),
  runtimeFlows: z.array(RuntimeFlowDescriptorSchema).optional().default([]),
});

export const VerifierResponseSchema = z.object({
  isLeak: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  explanation: z.string(),
  baaRelevant: z.boolean(),
});

// ─── Error Formatting ─────────────────────────────────────────────────────────

/**
 * Format a Zod error into a human-readable string suitable for LLM re-prompting.
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

/**
 * Extract JSON from an LLM response that may contain markdown fences or prose.
 */
export function extractJson(raw: string): string {
  // Try to extract from markdown code fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find a JSON object directly
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];

  return raw.trim();
}

// ─── Validate with Retry ─────────────────────────────────────────────────────

/**
 * Parse JSON, validate against a Zod schema, and retry once on failure.
 *
 * @param rawJson - Raw string from LLM (may contain markdown fences)
 * @param schema - Zod schema to validate against
 * @param retryFn - Called with formatted error string; should return corrected JSON
 * @returns Validated object or null on double failure
 */
export async function validateWithRetry<T>(
  rawJson: string,
  schema: z.ZodSchema<T>,
  retryFn: (error: string) => Promise<string>,
): Promise<T | null> {
  // First attempt
  const firstResult = parseAndValidate(rawJson, schema);
  if (firstResult.success) return firstResult.data;

  // Retry with error context
  let retryRaw: string;
  try {
    retryRaw = await retryFn(firstResult.error);
  } catch {
    return null;
  }

  const secondResult = parseAndValidate(retryRaw, schema);
  if (secondResult.success) return secondResult.data;

  return null;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function parseAndValidate<T>(
  raw: string,
  schema: z.ZodSchema<T>,
): ParseResult<T> {
  let parsed: unknown;
  try {
    const json = extractJson(raw);
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      success: false as const,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true as const, data: result.data as T };
  }

  return {
    success: false as const,
    error: `Validation errors:\n${formatZodError(result.error)}`,
  };
}
