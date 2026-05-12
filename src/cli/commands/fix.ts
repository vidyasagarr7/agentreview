import { Command } from 'commander';
import ora from 'ora';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { parsePRUrl, InvalidPRUrlError } from '../../github/parse-url.js';
import { GitHubClient, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../../github/client.js';
import { buildReviewContext } from '../../github/context-builder.js';
import { LensRegistry } from '../../lenses/registry.js';
import { LLMClient } from '../../llm/client.js';
import { dispatchAgents } from '../../agents/dispatcher.js';
import { validateAgentResults } from '../../validation/validator.js';
import { consolidate } from '../../report/consolidator.js';
import { ConfigManager } from '../config.js';
import { checkDataDisclosure } from '../disclosure.js';
import { generateFixes, isFixable } from '../../fix/generator.js';
import { verifyFixes } from '../../fix/verifier.js';
import { applyPatch, revertPatch } from '../../fix/applier.js';
import { renderFixReport } from '../../fix/report.js';
import type { FixAttempt, FixReport } from '../../types/index.js';

export function createFixCommand(): Command {
  const fixCmd = new Command('fix')
    .description('Auto-fix confirmed findings from a PR review')
    .argument('<pr-url>', 'GitHub PR URL')
    .option('--dry-run', 'Generate fix patches without applying them', false)
    .option('--repo-dir <path>', 'Local repo checkout directory (required for non-dry-run)')
    .option('--min-confidence <score>', 'Only fix findings above this confidence', (v) => parseInt(v, 10))
    .option('--model <model>', 'LLM model to use')
    .option('--output <file>', 'Write fix report to file')
    .option('-v, --verbose', 'Verbose output', false)
    .option('-y, --yes', 'Skip data policy prompt', false)
    .action(async (prUrl: string, opts) => {
      try {
        await runFix(prUrl, opts);
      } catch (err) {
        console.error(`\n❌ Unexpected error: ${(err as Error).message}`);
        if (opts.verbose) console.error((err as Error).stack);
        process.exit(1);
      }
    });

  return fixCmd;
}

async function runFix(prUrl: string, opts: {
  dryRun: boolean;
  repoDir?: string;
  minConfidence?: number;
  model?: string;
  output?: string;
  verbose: boolean;
  yes: boolean;
}): Promise<void> {
  const config = new ConfigManager();

  // ── Data disclosure ────────────────────────────────────────────────────────
  await checkDataDisclosure(config.hasAcknowledgedDataPolicy(), opts.yes);

  // ── Validate options ──────────────────────────────────────────────────────
  if (!opts.dryRun && !opts.repoDir) {
    console.error('❌ --repo-dir is required when not using --dry-run.');
    console.error('   Provide the path to a local checkout of the repo.');
    process.exit(1);
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
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Fetch PR ──────────────────────────────────────────────────────────────
  const githubClient = new GitHubClient(githubToken);
  const fetchSpinner = ora(`Fetching PR #${number}…`).start();
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

  // ── Review ────────────────────────────────────────────────────────────────
  const context = buildReviewContext(pr, pr.diff, pr.files, llmConfig.contextTokens);
  const llm = new LLMClient(llmConfig);

  const registry = new LensRegistry();
  const lenses = registry.resolveLenses('all');

  const reviewSpinner = ora('Running review…').start();
  const agentResults = await dispatchAgents(lenses, context, llm, {
    verbose: opts.verbose,
    timeoutMs: llmConfig.timeout * 1000,
  });
  reviewSpinner.succeed('Review complete');

  // ── Validate ──────────────────────────────────────────────────────────────
  const validateSpinner = ora('Validating findings…').start();
  let validatedResults;
  try {
    validatedResults = await validateAgentResults(agentResults, context, llm, {
      minConfidence: opts.minConfidence,
    });
    validateSpinner.succeed('Validation complete');
  } catch {
    validateSpinner.warn('Validation failed — proceeding without validation');
    validatedResults = agentResults;
  }

  // ── Consolidate ───────────────────────────────────────────────────────────
  const report = consolidate(validatedResults, pr);

  // ── Filter fixable findings ───────────────────────────────────────────────
  const fixableFindings = report.findings.filter(isFixable);

  if (opts.minConfidence) {
    const minConf = opts.minConfidence;
    const before = fixableFindings.length;
    const filtered = fixableFindings.filter(
      (f) => f.confidenceScore === undefined || f.confidenceScore >= minConf
    );
    if (opts.verbose && filtered.length < before) {
      console.error(`   Filtered ${before - filtered.length} findings below ${minConf}% confidence`);
    }
    fixableFindings.length = 0;
    fixableFindings.push(...filtered);
  }

  if (fixableFindings.length === 0) {
    console.error('\n✅ No fixable findings — nothing to do!');
    return;
  }

  console.error(`\n🔧 ${fixableFindings.length} finding(s) eligible for auto-fix\n`);

  // ── Generate fixes ────────────────────────────────────────────────────────
  const genSpinner = ora('Generating fixes…').start();
  const fixes = await generateFixes(fixableFindings, context, llm, { dryRun: opts.dryRun });
  const generated = fixes.filter((f) => f.status !== 'failed');
  genSpinner.succeed(`Generated ${generated.length} fix(es)`);

  // ── Apply → Verify → Revert cycle ────────────────────────────────────────
  if (!opts.dryRun && opts.repoDir) {
    for (const fix of fixes) {
      if (fix.status === 'failed' || !fix.patch) continue;

      const applySpinner = ora(`Applying fix for ${fix.findingId}…`).start();
      const applied = await applyPatch(fix.patch, opts.repoDir);

      if (!applied) {
        fix.status = 'failed';
        fix.verificationResult = 'Patch failed to apply';
        applySpinner.fail(`[${fix.findingId}] Patch failed to apply`);
        continue;
      }

      fix.status = 'applied';
      applySpinner.succeed(`[${fix.findingId}] Patch applied`);

      // Verify
      const verifySpinner = ora(`Verifying fix for ${fix.findingId}…`).start();
      const [verification] = await verifyFixes([fix], context, llm);

      if (verification?.passed) {
        fix.status = 'verified';
        fix.verificationResult = 'Fix verified — no regressions detected';
        verifySpinner.succeed(`[${fix.findingId}] Fix verified ✓`);
      } else {
        // Revert
        const reverted = await revertPatch(fix.patch, opts.repoDir);
        fix.status = 'reverted';
        fix.verificationResult = verification?.issues?.join('; ') ?? 'Verification failed';
        if (reverted) {
          verifySpinner.warn(`[${fix.findingId}] Fix reverted — ${fix.verificationResult}`);
        } else {
          verifySpinner.fail(`[${fix.findingId}] Fix reverted (manual cleanup may be needed)`);
        }
      }
    }
  }

  // ── Build fix report ──────────────────────────────────────────────────────
  const fixReport: FixReport = {
    pr: {
      title: pr.title,
      number: pr.number,
      repoOwner: owner,
      repoName: repo,
    },
    eligible: fixableFindings.length,
    generated: fixes.filter((f) => f.status !== 'failed').length,
    verified: fixes.filter((f) => f.status === 'verified').length,
    reverted: fixes.filter((f) => f.status === 'reverted').length,
    failed: fixes.filter((f) => f.status === 'failed').length,
    fixes,
  };

  const rendered = renderFixReport(fixReport);

  if (opts.output) {
    await mkdir(dirname(opts.output), { recursive: true });
    await writeFile(opts.output, rendered, 'utf-8');
    console.error(`\n✅ Fix report written to: ${opts.output}`);
  } else {
    process.stdout.write(rendered + '\n');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.error(`\n📋 Fix Summary: ${fixReport.verified} verified, ${fixReport.reverted} reverted, ${fixReport.failed} failed out of ${fixReport.eligible} eligible`);
}
