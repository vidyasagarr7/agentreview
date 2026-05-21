import { Command } from 'commander';
import ora from 'ora';
import { writeFile, mkdir } from 'fs/promises';
import { GitHubClient } from '../../github/client.js';
import { dirname } from 'path';
import { ConfigManager } from '../config.js';
import { checkScanDisclosure } from '../disclosure.js';
import { LLMClient } from '../../llm/client.js';
import { scanCodebase } from '../../scan/orchestrator.js';
import { renderScanReport } from '../../scan/renderer.js';
import type { SecurityDomain, ScanOptions } from '../../scan/types.js';
import type { FindingSeverity } from '../../types/index.js';
import { SEVERITY_ORDER } from '../../types/index.js';

const VALID_DOMAINS = new Set<SecurityDomain>([
  'auth', 'secrets', 'injection', 'config', 'deps', 'crypto', 'data-flow', 'general',
]);

function parseDomains(raw: string): SecurityDomain[] {
  const domains = raw.split(',').map((d) => d.trim()).filter(Boolean) as SecurityDomain[];
  for (const d of domains) {
    if (!VALID_DOMAINS.has(d)) {
      console.error(`❌ Invalid --focus domain: "${d}". Valid domains: ${[...VALID_DOMAINS].join(', ')}`);
      process.exit(1);
    }
  }
  return domains;
}

export function createScanCommand(): Command {
  const scanCmd = new Command('scan')
    .description('Security scan a codebase (local path or GitHub URL)')
    .argument('<target>', 'GitHub URL (owner/repo) or local directory path')
    .option('--focus <areas>', 'Comma-separated security domains to focus on')
    .option('--model <model>', 'LLM model override')
    .option('--format <format>', 'Output format (markdown|json|sarif)', 'markdown')
    .option('--output <file>', 'Write report to file instead of stdout')
    .option('--fail-on <severity>', 'Exit with code 2 if findings at or above this severity')
    .option('--redact', 'Redact known secret patterns before sending to LLM', false)
    .option('--issue', 'Create a GitHub issue with the scan report', false)
    .option('--max-files <n>', 'Maximum number of files to scan', (v) => parseInt(v, 10), 50)
    .option('--budget <tokens>', 'Token budget for scan', (v) => parseInt(v, 10), 100000)
    .option('--branch <ref>', 'Branch/ref to scan (for GitHub targets)')
    .option('--timeout <seconds>', 'Per-chunk timeout in seconds', (v) => parseInt(v, 10))
    .option('-v, --verbose', 'Verbose output', false)
    .option('-y, --yes', 'Skip data disclosure prompt', false)
    .action(async (target: string, opts) => {
      try {
        await runScan(target, opts);
      } catch (err) {
        console.error(`\n❌ Unexpected error: ${(err as Error).message}`);
        if (opts.verbose) console.error((err as Error).stack);
        process.exit(1);
      }
    });

  return scanCmd;
}

async function runScan(target: string, opts: {
  focus?: string;
  model?: string;
  format: string;
  output?: string;
  failOn?: string;
  redact: boolean;
  issue: boolean;
  maxFiles: number;
  budget: number;
  branch?: string;
  timeout?: number;
  verbose: boolean;
  yes: boolean;
}): Promise<void> {
  const config = new ConfigManager();

  // ── Parse options ─────────────────────────────────────────────────────────
  const focus = opts.focus ? parseDomains(opts.focus) : undefined;

  // Validate --fail-on
  let failOn: FindingSeverity | undefined;
  if (opts.failOn) {
    const upper = opts.failOn.toUpperCase() as FindingSeverity;
    if (!SEVERITY_ORDER.includes(upper)) {
      console.error(`❌ Invalid --fail-on value: "${opts.failOn}". Valid values: ${SEVERITY_ORDER.join(', ')}`);
      process.exit(1);
    }
    failOn = upper;
  }

  // Validate format
  const format = opts.format as 'markdown' | 'json' | 'sarif';
  if (format !== 'markdown' && format !== 'json' && format !== 'sarif') {
    console.error(`❌ Invalid --format: "${opts.format}". Use "markdown", "json", or "sarif".`);
    process.exit(1);
  }

  // ── LLM config ────────────────────────────────────────────────────────────
  let llmConfig;
  try {
    llmConfig = config.getLLMConfig(opts.model);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }

  if (opts.timeout) {
    llmConfig = { ...llmConfig, timeout: opts.timeout };
  }


  // ── Disclosure ────────────────────────────────────────────────────────────
  // Quick file listing for disclosure count (local targets only)
  let preFileCount = 0;
  if (!target.includes('github.com')) {
    try {
      const { LocalSourceReader } = await import('../../scan/local-reader.js');
      const preReader = new LocalSourceReader(target);
      const files = await preReader.listFiles();
      preFileCount = files.length;
    } catch { /* target may not exist yet for remote */ }
  }
  const acknowledged = config.hasAcknowledgedDataPolicy();
  await checkScanDisclosure(acknowledged, opts.yes, {
    fileCount: preFileCount,
    provider: llmConfig.provider,
    model: llmConfig.model,
    focus: focus,
  });

  // ── Run scan ──────────────────────────────────────────────────────────────
  const llm = new LLMClient(llmConfig);

  const scanOptions: ScanOptions = {
    focus,
    maxConcurrency: 3,
    budgetTokens: opts.budget,
    maxFiles: opts.maxFiles,
    model: opts.model,
    timeout: llmConfig.timeout,
    validate: true,
    verbose: opts.verbose,
    redact: opts.redact,
  };

  const chunkSpinners = new Map<string, ReturnType<typeof ora>>();

  const scanSpinner = ora(`Scanning ${target}…`).start();

  // Wire progress callback into scan options
  scanOptions.onProgress = (chunkId, status, meta) => {
    if (status === 'started') {
      const spinner = ora(`  [${chunkId}] Scanning ${meta?.domain ?? 'unknown'} (${meta?.fileCount ?? 0} files)…`).start();
      chunkSpinners.set(chunkId, spinner);
    } else if (status === 'completed') {
      chunkSpinners.get(chunkId)?.succeed(
        `  [${chunkId}] Done — ${meta?.findingCount ?? 0} finding(s) (${((meta?.durationMs ?? 0) / 1000).toFixed(1)}s)`,
      );
      chunkSpinners.delete(chunkId);
    } else {
      chunkSpinners.get(chunkId)?.fail(`  [${chunkId}] Failed`);
      chunkSpinners.delete(chunkId);
    }
  };

  const result = await scanCodebase(target, scanOptions, llm, {
    branch: opts.branch,
  });

  scanSpinner.succeed(`Scan complete: ${result.filesScanned} files scanned`);

  // ── Render ────────────────────────────────────────────────────────────────
  const rendered = renderScanReport(result, format);

  // ── Output ────────────────────────────────────────────────────────────────
  if (opts.output) {
    await mkdir(dirname(opts.output), { recursive: true });
    await writeFile(opts.output, rendered, 'utf-8');
    console.error(`✅ Report written to: ${opts.output}`);
  } else {
    process.stdout.write(rendered + '\n');
  }

  // ── Post as GitHub Issue ─────────────────────────────────────────────────
  if (opts.issue && target.includes('github.com')) {
    const issueSpinner = ora('Creating GitHub issue…').start();
    try {
      const { parseGitHubUrl } = await import('../../scan/clone.js');
      const { owner, repo } = parseGitHubUrl(target);
      const githubToken = config.getGitHubToken();
      const ghClient = new GitHubClient(githubToken);
      const severityLabel = result.stats.bySeverity.CRITICAL > 0 ? 'critical' : result.stats.bySeverity.HIGH > 0 ? 'high' : 'security';
      const issueBody = rendered.length > 65000 ? rendered.slice(0, 65000) + '\n\n*[truncated — full report exceeded GitHub limit]*' : rendered;
      const issue = await ghClient.createIssue(owner, repo, `🔒 Security Scan: ${result.findings.length} finding(s)`, issueBody, ['security', severityLabel]);
      issueSpinner.succeed(`Issue created: ${issue.url}`);
    } catch (err) {
      issueSpinner.fail('Failed to create issue');
      console.error(`⚠️  ${(err as Error).message}`);
    }
  } else if (opts.issue) {
    console.error('⚠️  --issue requires a GitHub URL target.');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const { stats } = result;
  const parts: string[] = [];
  if (stats.bySeverity.CRITICAL > 0) parts.push(`${stats.bySeverity.CRITICAL} CRITICAL`);
  if (stats.bySeverity.HIGH > 0) parts.push(`${stats.bySeverity.HIGH} HIGH`);
  if (stats.bySeverity.MEDIUM > 0) parts.push(`${stats.bySeverity.MEDIUM} MEDIUM`);
  if (stats.bySeverity.LOW > 0) parts.push(`${stats.bySeverity.LOW} LOW`);
  if (stats.bySeverity.INFO > 0) parts.push(`${stats.bySeverity.INFO} INFO`);

  const summaryLine = parts.length > 0
    ? `Found ${stats.total} finding(s): ${parts.join(', ')}`
    : '✅ No findings — looks clean!';

  console.error(`\n📋 ${summaryLine}`);

  if (stats.erroredChunks.length > 0) {
    console.error(`⚠️  ${stats.erroredChunks.length} chunk(s) errored during scan`);
  }

  // ── Exit code ─────────────────────────────────────────────────────────────
  if (failOn) {
    const failSeverityRank = SEVERITY_ORDER.indexOf(failOn);
    const hasFailingFinding = result.findings.some((f) => {
      const rank = SEVERITY_ORDER.indexOf(f.severity);
      return rank <= failSeverityRank;
    });

    if (hasFailingFinding) {
      console.error(`\n❌ Exiting with code 2: findings at or above ${failOn} severity were found.`);
      process.exit(2);
    }
  }
}
