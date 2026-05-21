import pLimit from 'p-limit';

import type { AgentFinding, FindingSeverity, ParseError } from '../types/index.js';
import { SEVERITY_ORDER } from '../types/index.js';
import type { LLMClient } from '../llm/client.js';
import { parseFindings } from '../llm/parse-findings.js';
import type {
  ChunkResult,
  CoverageEntry,
  ScanChunk,
  ScanOptions,
  ScanProgressCallback,
  ScanResult,
  ScanStats,
  SecurityDomain,
  SourceReader,
} from './types.js';
import { cloneRepo } from './clone.js';
import { LocalSourceReader } from './local-reader.js';
import { discoverFiles } from './discovery.js';
import { chunkFiles } from './chunker.js';
import { buildScanPrompt } from './prompts.js';
import { dedupScanFindings } from './dedup-scan.js';
import { loadBaseline, saveBaseline, filterNewFindings, createBaseline } from './baseline.js';
import { redactSecrets } from './redact.js';
import { loadRepoConfig } from '../config/repo-config.js';
import { buildHipaaContext } from '../lenses/builtin/hipaa.js';

// ─── Redacting Reader Wrapper ─────────────────────────────────────────────────

class RedactingReader implements SourceReader {
  constructor(private inner: SourceReader) {}

  listFiles() {
    return this.inner.listFiles();
  }

  async readFile(path: string): Promise<string | null> {
    const content = await this.inner.readFile(path);
    if (content === null) return null;
    const { redacted } = redactSecrets(content);
    return redacted;
  }

  async cleanup(): Promise<void> {
    await this.inner.cleanup?.();
  }
}

// ─── Chunk Dispatcher ─────────────────────────────────────────────────────────

async function dispatchChunk(
  chunk: ScanChunk,
  llm: LLMClient,
  meta: { target: string; branch: string },
  onProgress?: ScanProgressCallback,
  hipaaContext?: string,
): Promise<ChunkResult> {
  const start = Date.now();

  onProgress?.(chunk.id, 'started', {
    domain: chunk.domain,
    fileCount: chunk.files.length,
  });

  try {
    const { system, user } = buildScanPrompt(chunk, meta, { hipaaContext });
    const response = await llm.complete(system, user, undefined, { maxTokens: 8192 });
    const parsed = parseFindings(response, chunk.id);

    const durationMs = Date.now() - start;

    let findings: AgentFinding[];
    let error: string | undefined;

    if (Array.isArray(parsed)) {
      findings = parsed;
    } else {
      // ParseError — record it but don't crash
      findings = [];
      error = (parsed as ParseError).message;
    }

    onProgress?.(chunk.id, 'completed', {
      domain: chunk.domain,
      fileCount: chunk.files.length,
      durationMs,
      findingCount: findings.length,
    });

    return { chunkId: chunk.id, domain: chunk.domain, findings, error, durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);

    onProgress?.(chunk.id, 'failed', {
      domain: chunk.domain,
      fileCount: chunk.files.length,
      durationMs,
    });

    return { chunkId: chunk.id, domain: chunk.domain, findings: [], error: message, durationMs };
  }
}

// ─── Stats & Coverage Builders ────────────────────────────────────────────────

function buildStats(chunkResults: ChunkResult[], findings: AgentFinding[]): ScanStats {
  const bySeverity: Record<FindingSeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
  };

  for (const f of findings) {
    bySeverity[f.severity]++;
  }

  const byDomain: Record<string, number> = {};
  for (const cr of chunkResults) {
    byDomain[cr.domain] = (byDomain[cr.domain] ?? 0) + cr.findings.length;
  }

  // Clean domains: domains with chunks but zero findings
  const allDomains = new Set(chunkResults.map((cr) => cr.domain));
  const cleanDomains = [...allDomains].filter((d) => !byDomain[d] || byDomain[d] === 0);

  const erroredChunks = chunkResults.filter((cr) => cr.error).map((cr) => cr.chunkId);

  return {
    total: findings.length,
    bySeverity,
    byDomain,
    cleanDomains,
    erroredChunks,
  };
}

function buildCoverageFromChunks(chunks: ScanChunk[], chunkResults: ChunkResult[]): CoverageEntry[] {
  const domainFiles = new Map<SecurityDomain, Set<string>>();
  const domainFindings = new Map<SecurityDomain, number>();

  for (const chunk of chunks) {
    if (!domainFiles.has(chunk.domain)) {
      domainFiles.set(chunk.domain, new Set());
    }
    for (const f of chunk.files) {
      domainFiles.get(chunk.domain)!.add(f.path);
    }
  }

  for (const cr of chunkResults) {
    domainFindings.set(cr.domain, (domainFindings.get(cr.domain) ?? 0) + cr.findings.length);
  }

  return [...domainFiles.entries()].map(([domain, files]) => ({
    domain,
    filesScanned: files.size,
    findings: domainFindings.get(domain) ?? 0,
  }));
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

export async function scanCodebase(
  target: string,
  options: ScanOptions & { onProgress?: ScanProgressCallback; baseline?: string; updateBaseline?: boolean; baselinePath?: string },
  llm: LLMClient,
  config: { token?: string; branch?: string },
): Promise<ScanResult> {
  const branch = config.branch ?? 'main';
  const isGitHub = target.includes('github.com');

  let reader: SourceReader;
  let cleanupFn: (() => Promise<void>) | undefined;
  let clonedRepoRoot: string | undefined;

  // a. Resolve source
  if (isGitHub) {
    const result = await cloneRepo(target, { token: config.token, branch: config.branch });
    reader = result.reader;
    cleanupFn = result.cleanup;
    // LocalSourceReader exposes rootReal for config loading
    clonedRepoRoot = result.reader.rootReal;
  } else {
    reader = new LocalSourceReader(target);
  }

  // Wrap with redacting reader if requested
  const effectiveReader: SourceReader = options.redact ? new RedactingReader(reader) : reader;

  try {
    // b. Discover files (respect maxFiles limit)
    let classifiedFiles = await discoverFiles(effectiveReader, options.focus);
    if (options.maxFiles && classifiedFiles.length > options.maxFiles) {
      classifiedFiles = classifiedFiles.slice(0, options.maxFiles);
    }

    // c. Chunk files (redaction is handled by the reader wrapper)
    const chunks = await chunkFiles(classifiedFiles, effectiveReader, {
      budgetTokens: options.budgetTokens,
      focus: options.focus,
    });

    // d. Count files for stats
    const allFilePaths = new Set<string>();
    for (const chunk of chunks) {
      for (const f of chunk.files) {
        allFilePaths.add(f.path);
      }
    }

    // e. Dispatch chunks to LLM in parallel with concurrency limit
    const limit = pLimit(options.maxConcurrency || 3);
    const meta = { target, branch };

    // Load repo config for HIPAA context in scan (works for both local and cloned repos)
    let hipaaContext: string | undefined;
    const configRoot = isGitHub ? clonedRepoRoot : target;
    if (configRoot) {
      try {
        const repoConfig = await loadRepoConfig(configRoot);
        if (repoConfig?.hipaa) {
          hipaaContext = buildHipaaContext(repoConfig.hipaa);
        }
      } catch {
        // Ignore — HIPAA context is optional
      }
    }

    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        limit(() => dispatchChunk(chunk, llm, meta, options.onProgress, hipaaContext)),
      ),
    );

    // f. Dedup findings
    const allFindings = dedupScanFindings(chunkResults);

    // g. Baseline filtering
    const resolvedBaselinePath = options.baselinePath ?? `${isGitHub ? '.' : target}/.agentreview-baseline.json`;
    let findings = allFindings;
    let suppressedCount: number | undefined;

    if (options.baseline || options.updateBaseline) {
      // Creating or updating baseline — save all findings
      const baselineData = createBaseline(allFindings, target);
      await saveBaseline(resolvedBaselinePath, baselineData);
    } else {
      // Check for existing baseline and filter
      const existingBaseline = await loadBaseline(resolvedBaselinePath);
      if (existingBaseline) {
        const filtered = filterNewFindings(allFindings, existingBaseline);
        findings = filtered.new;
        suppressedCount = filtered.suppressed.length;
      }
    }

    // h. Build stats and coverage
    const stats = buildStats(chunkResults, findings);
    const coverage = buildCoverageFromChunks(chunks, chunkResults);

    return {
      target,
      branch,
      scannedAt: new Date().toISOString(),
      filesDiscovered: classifiedFiles.length,
      filesScanned: allFilePaths.size,
      filesSkipped: classifiedFiles.length - allFilePaths.size,
      chunks: chunkResults,
      findings,
      stats,
      coverage,
      suppressedCount,
    };
  } finally {
    // h. Always cleanup
    await cleanupFn?.();
    if (!isGitHub) {
      await reader.cleanup?.();
    }
  }
}
