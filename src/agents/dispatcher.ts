import type { Lens, ReviewContext, AgentResult } from '../types/index.js';
import type { LLMClient } from '../llm/client.js';
import { parseFindings } from '../llm/parse-findings.js';
import { buildPrompt } from './prompt-builder.js';

export interface DispatchOptions {
  verbose?: boolean;
  timeoutMs?: number;
  onProgress?: (lensId: string, status: 'started' | 'completed' | 'failed', durationMs?: number) => void;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`[${label}] Agent timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );
  return Promise.race([promise, timeoutPromise]);
}

async function dispatchSingleAgent(
  lens: Lens,
  context: ReviewContext,
  llm: LLMClient,
  options: DispatchOptions
): Promise<AgentResult> {
  const startTime = Date.now();

  options.onProgress?.(lens.id, 'started');

  try {
    const { system, user } = buildPrompt(lens, context);
    const timeoutMs = options.timeoutMs ?? 60000;

    const raw = await withTimeout(
      llm.complete(system, user),
      timeoutMs,
      lens.id
    );

    const findings = parseFindings(raw, lens.id);
    const durationMs = Date.now() - startTime;

    options.onProgress?.(lens.id, 'completed', durationMs);

    // Tag findings with lens ID
    if (Array.isArray(findings)) {
      for (const f of findings) {
        f.lenses = [lens.id];
      }
    }

    return { lensId: lens.id, findings, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    options.onProgress?.(lens.id, 'failed', durationMs);

    return {
      lensId: lens.id,
      findings: [],
      error: errorMsg,
      durationMs,
    };
  }
}

export async function dispatchAgents(
  lenses: Lens[],
  context: ReviewContext,
  llm: LLMClient,
  options: DispatchOptions = {}
): Promise<AgentResult[]> {
  // Run all lenses in parallel using Promise.allSettled for resilience
  const settled = await Promise.allSettled(
    lenses.map((lens) => dispatchSingleAgent(lens, context, llm, options))
  );

  return settled.map((result, i) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Should not happen since dispatchSingleAgent catches internally, but guard anyway
    return {
      lensId: lenses[i].id,
      findings: [],
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      durationMs: 0,
    };
  });
}
