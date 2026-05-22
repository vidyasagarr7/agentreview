// ─── profiler.ts — Pass 1: Per-file PHI profiling via LLM ───────────────────

import pLimit from 'p-limit';
import { FilePhiProfileSchema, validateWithRetry } from './schema.js';
import { PROFILER_SYSTEM_PROMPT, PROFILER_USER_PROMPT, PROFILER_RETRY_PROMPT } from './prompts.js';
import type { FilePhiProfile, LLMClient, FlowProgressCallback } from './types.js';

// ─── Known PHI Source Imports ─────────────────────────────────────────────────
// Files importing these packages are prioritized for profiling.

const PHI_SOURCE_IMPORTS = new Set([
  'fhir.js', 'fhirclient', '@asymmetrik/node-fhir-server-core', '@medplum/core',
  'hl7', 'node-hl7-complete', 'simple-hl7',
  'blue-button', 'cda-parser',
  'cds-hooks',
]);

// ─── Single-File Profiling ────────────────────────────────────────────────────

/**
 * Profile a single file for PHI sources, sinks, transforms, and exports.
 * Returns null if the LLM fails validation after one retry.
 */
export async function profileFile(
  filePath: string,
  source: string,
  llm: LLMClient,
): Promise<FilePhiProfile | null> {
  const rawResponse = await llm.chat([
    { role: 'system', content: PROFILER_SYSTEM_PROMPT },
    { role: 'user', content: PROFILER_USER_PROMPT(filePath, source) },
  ]);

  return validateWithRetry(
    rawResponse,
    FilePhiProfileSchema,
    async (error: string) => {
      return llm.chat([
        { role: 'system', content: PROFILER_SYSTEM_PROMPT },
        { role: 'user', content: PROFILER_RETRY_PROMPT(filePath, source, error) },
      ]);
    },
  ) as Promise<FilePhiProfile | null>;
}

// ─── File Prioritization ─────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  content: string;
}

function prioritizeFiles(files: FileEntry[]): FileEntry[] {
  return [...files].sort((a, b) => {
    const scoreA = filePriorityScore(a);
    const scoreB = filePriorityScore(b);
    return scoreB - scoreA; // higher score = higher priority
  });
}

function filePriorityScore(file: FileEntry): number {
  let score = 0;

  // (1) Known PHI source imports — highest priority
  for (const pkg of Array.from(PHI_SOURCE_IMPORTS)) {
    if (file.content.includes(pkg)) {
      score += 100;
      break;
    }
  }

  // (2) src/ files over lib/ or node_modules
  if (file.path.startsWith('src/') || file.path.includes('/src/')) {
    score += 10;
  }

  // (3) File size — larger files more likely to contain flows
  score += Math.min(file.content.length / 1000, 50);

  return score;
}

// ─── Batch Profiling ──────────────────────────────────────────────────────────

/**
 * Profile multiple files in parallel with concurrency control.
 *
 * - Prioritizes files by PHI-relevance, directory, and size
 * - Skips empty files
 * - Caps at maxFiles
 * - Aborts if failure rate exceeds threshold (Claude challenge #4)
 * - Reports progress via onProgress callback (Claude challenge #6)
 */
export async function profileFiles(
  files: Array<{ path: string; content: string }>,
  llm: LLMClient,
  options: {
    concurrency: number;
    maxFiles: number;
    onProgress?: FlowProgressCallback;
  },
): Promise<Map<string, FilePhiProfile>> {
  const results = new Map<string, FilePhiProfile>();

  // Filter empty files
  const nonEmpty = files.filter((f) => f.content.trim().length > 0);

  // Prioritize and cap
  const prioritized = prioritizeFiles(nonEmpty);
  const capped = prioritized.slice(0, options.maxFiles);
  const total = capped.length;

  if (total === 0) return results;

  const limit = pLimit(options.concurrency);
  const failureThreshold = 0.3;
  let completed = 0;
  let failures = 0;
  let aborted = false;

  const tasks = capped.map((file) =>
    limit(async () => {
      if (aborted) return;

      try {
        const profile = await profileFile(file.path, file.content, llm);
        if (profile) {
          results.set(file.path, profile);
        } else {
          failures++;
        }
      } catch {
        failures++;
      }

      completed++;
      options.onProgress?.('profiling', completed, total, file.path);

      // Check failure rate after enough samples
      if (completed >= 5 && failures / completed > failureThreshold) {
        aborted = true;
      }
    }),
  );

  await Promise.all(tasks);

  return results;
}
