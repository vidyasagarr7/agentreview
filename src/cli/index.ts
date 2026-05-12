import { Command, Option } from 'commander';
import ora from 'ora';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { parsePRUrl, InvalidPRUrlError } from '../github/parse-url.js';
import { GitHubClient, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../github/client.js';
import { buildReviewContext } from '../github/context-builder.js';
import { LensRegistry } from '../lenses/registry.js';
import { LLMClient } from '../llm/client.js';
import { dispatchAgents } from '../agents/dispatcher.js';
import { consolidate } from '../report/consolidator.js';
import { render } from '../report/renderer.js';
import { ConfigManager, ConfigError } from './config.js';
import { checkDataDisclosure } from './disclosure.js';
import { createLensesCommand } from './commands/lenses.js';
import type { FindingSeverity, ReportFormat } from '../types/index.js';
import { SEVERITY_ORDER } from '../types/index.js';

const CUSTOM_LENS_DIR = join(homedir(), '.agentreview', 'lenses');

async function reviewPR(prUrl: string, opts: {
  format: ReportFormat;
  lenses: string;
  failOn?: string;
  timeout: number;
  model?: string;
  post: boolean;
  verbose: boolean;
  noDedup: boolean;
  yes: boolean;
  output?: string;
}): Promise<void> {
  const config = new ConfigManager();

  // ── Data disclosure ────────────────────────────────────────────────────────
  const acknowledged = config.hasAcknowledgedDataPolicy();
  await checkDataDisclosure(acknowledged, opts.yes);

  // ── Validate --fail-on ────────────────────────────────────────────────────
  let failOn: FindingSeverity | undefined;
  if (opts.failOn) {
    const upper = opts.failOn.toUpperCase() as FindingSeverity;
    if (!SEVERITY_ORDER.includes(upper)) {
      console.error(`❌ Invalid --fail-on value: "${opts.failOn}". Valid values: ${SEVERITY_ORDER.join(', ')}`);
      process.exit(1);
    }
    failOn = upper;
  }

  // ── Parse PR URL ──────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = parsePRUrl(prUrl);
  } catch (err) {
    if (err instanceof InvalidPRUrlError) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const { owner, repo, number } = parsed;

  // ── Config ────────────────────────────────────────────────────────────────
  let githubToken: string;
  let llmConfig;

  try {
    githubToken = config.getGitHubToken();
    llmConfig = config.getLLMConfig(opts.model);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Override timeout if provided
  if (opts.timeout) {
    llmConfig = { ...llmConfig, timeout: opts.timeout };
  }

  // ── Lens resolution ───────────────────────────────────────────────────────
  const registry = new LensRegistry();
  await registry.loadCustomLenses(CUSTOM_LENS_DIR);

  let lensIds: string[] | 'all';
  const rawLenses = opts.lenses.trim();
  if (rawLenses === 'all' || rawLenses === '') {
    lensIds = 'all';
  } else {
    lensIds = rawLenses.split(',').map((l) => l.trim()).filter(Boolean);
  }

  let lenses;
  try {
    lenses = registry.resolveLenses(lensIds);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }

  if (opts.verbose) {
    console.error(`🔍 Reviewing ${owner}/${repo}#${number} with lenses: ${lenses.map((l) => l.id).join(', ')}`);
  }

  // ── Fetch PR data ─────────────────────────────────────────────────────────
  const githubClient = new GitHubClient(githubToken);

  const fetchSpinner = ora(`Fetching PR #${number} from ${owner}/${repo}…`).start();
  let pr;
  try {
    pr = await githubClient.getPR(owner, repo, number);
    fetchSpinner.succeed(`Fetched PR #${number}: ${pr.title}`);
  } catch (err) {
    fetchSpinner.fail('Failed to fetch PR');
    if (err instanceof GitHubAuthError || err instanceof GitHubNotFoundError || err instanceof GitHubRateLimitError) {
      console.error(`❌ ${err.message}`);
    } else {
      console.error(`❌ GitHub error: ${(err as Error).message}`);
    }
    process.exit(1);
  }

  // ── Build review context ──────────────────────────────────────────────────
  const context = buildReviewContext(pr, pr.diff, pr.files, llmConfig.contextTokens);

  if (opts.verbose) {
    console.error(`📊 Context: ~${context.estimatedTokens} tokens${context.truncated ? ' (truncated)' : ''}`);
    if (context.truncationNote) {
      console.error(`   ${context.truncationNote}`);
    }
  }

  // ── Dispatch agents ───────────────────────────────────────────────────────
  const llm = new LLMClient(llmConfig);
  const agentSpinners = new Map<string, ReturnType<typeof ora>>();

  const agentResults = await dispatchAgents(lenses, context, llm, {
    verbose: opts.verbose,
    timeoutMs: llmConfig.timeout * 1000,
    onProgress(lensId, status, durationMs) {
      if (status === 'started') {
        const spinner = ora(`[${lensId}] Analyzing…`).start();
        agentSpinners.set(lensId, spinner);
      } else if (status === 'completed') {
        agentSpinners.get(lensId)?.succeed(`[${lensId}] Done (${((durationMs ?? 0) / 1000).toFixed(1)}s)`);
        agentSpinners.delete(lensId);
      } else {
        agentSpinners.get(lensId)?.fail(`[${lensId}] Failed`);
        agentSpinners.delete(lensId);
      }
    },
  });

  // ── Consolidate & render ──────────────────────────────────────────────────
  const report = consolidate(agentResults, pr, opts.noDedup, context.skippedFiles ?? []);
  const rendered = render(report, opts.format);

  // ── Output ────────────────────────────────────────────────────────────────
  if (opts.output) {
    await mkdir(dirname(opts.output), { recursive: true });
    await writeFile(opts.output, rendered, 'utf-8');
    console.error(`✅ Report written to: ${opts.output}`);
  } else {
    process.stdout.write(rendered + '\n');
  }

  // ── Post to GitHub ────────────────────────────────────────────────────────
  if (opts.post) {
    const postSpinner = ora('Posting review comment to GitHub…').start();
    try {
      // Always post as markdown when posting to GitHub
      const markdownBody = opts.format === 'markdown' ? rendered : render(report, 'markdown');
      await githubClient.postOrUpdateComment(owner, repo, number, markdownBody);
      postSpinner.succeed('Review posted to GitHub');
    } catch (err) {
      postSpinner.fail('Failed to post comment');
      console.error(`⚠️  Could not post to GitHub: ${(err as Error).message}`);
      // Don't exit — local output was already written
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const { stats } = report;
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
  if (report.confidence === 'LOW') {
    console.error('⚠️  Confidence: LOW (some lenses errored or returned parse failures)');
  }

  // ── Exit code ─────────────────────────────────────────────────────────────
  if (failOn) {
    const failSeverityRank = SEVERITY_ORDER.indexOf(failOn);
    const hasFailingFinding = report.findings.some((f) => {
      const rank = SEVERITY_ORDER.indexOf(f.severity);
      return rank <= failSeverityRank; // lower index = higher severity
    });

    if (hasFailingFinding) {
      console.error(`\n❌ Exiting with code 2: findings at or above ${failOn} severity were found.`);
      process.exit(2);
    }
  }
}

// ── CLI setup ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('agentreview')
  .description('Multi-perspective automated PR review using parallel AI agents')
  .version('0.1.0')
  .argument('<pr-url>', 'GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['markdown', 'json'])
      .default(new ConfigManager().getDefaultFormat())
  )
  .option(
    '--lenses <lenses>',
    'Comma-separated lens IDs to run, or "all"'
  )
  .option(
    '--lens <lenses>',
    'Alias for --lenses (comma-separated lens IDs, or "all")'
  )
  .option(
    '--fail-on <severity>',
    'Exit with code 2 if any finding meets or exceeds this severity (CRITICAL|HIGH|MEDIUM|LOW|INFO)'
  )
  .option(
    '--timeout <seconds>',
    'Per-agent timeout in seconds',
    (v) => parseInt(v, 10)
  )
  .option(
    '--model <model>',
    'LLM model to use (overrides AGENTREVIEW_MODEL env var)'
  )
  .option(
    '--post',
    'Post review as a GitHub PR comment',
    false
  )
  .option(
    '--output <file>',
    'Write report to file instead of stdout'
  )
  .option(
    '--no-dedup',
    'Disable cross-lens deduplication of findings'
  )
  .option(
    '-v, --verbose',
    'Enable verbose progress output',
    false
  )
  .option(
    '-y, --yes',
    'I acknowledge that PR diffs will be sent to an external LLM provider (required for non-interactive/CI use)',
    false
  )
  .action(async (prUrl: string, opts) => {
    try {
      const config = new ConfigManager();
      // Resolve --lens / --lenses (--lens is alias for --lenses)
      const lensesValue: string = opts.lens ?? opts.lenses ?? config.getDefaultLenses();
      // Resolve --fail-on: CLI flag overrides env var
      const failOnValue: string | undefined = opts.failOn ?? config.getFailOnSeverity();
      // Resolve timeout: CLI flag > env var (via ConfigManager) > hardcoded default
      const timeoutValue: number = opts.timeout ?? config.getTimeout();
      await reviewPR(prUrl, {
        format: opts.format as ReportFormat,
        lenses: lensesValue,
        failOn: failOnValue,
        timeout: timeoutValue,
        model: opts.model,
        post: opts.post,
        verbose: opts.verbose,
        noDedup: !opts.dedup, // commander inverts --no-dedup → opts.dedup
        yes: opts.yes,
        output: opts.output,
      });
    } catch (err) {
      console.error(`\n❌ Unexpected error: ${(err as Error).message}`);
      if (opts.verbose) {
        console.error((err as Error).stack);
      }
      process.exit(1);
    }
  });

// Sub-commands
program.addCommand(createLensesCommand());

program.parseAsync(process.argv);
