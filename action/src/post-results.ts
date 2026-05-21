import * as github from '@actions/github';
import * as core from '@actions/core';
import type { PRContext } from './context.js';

const MARKER = '<!-- agentreview -->';
const MAX_COMMENT_LENGTH = 65000;

export interface PostResult {
  commentId: number;
  created: boolean;
}

/**
 * Post review results as a PR comment and write full report to step summary.
 */
export async function postResults(
  report: string,
  prContext: PRContext,
  commentMode: 'full' | 'summary' | 'collapsed',
  stats: { total: number; bySeverity: Record<string, number> },
): Promise<PostResult> {
  const octokit = github.getOctokit(prContext.token);
  const { owner, repo, prNumber } = prContext;

  // Build comment body based on mode
  let commentBody = buildCommentBody(report, commentMode, stats);

  // Prepend marker
  commentBody = `${MARKER}\n${commentBody}`;

  // Truncate if too long
  if (commentBody.length > MAX_COMMENT_LENGTH) {
    const truncationNotice =
      '\n\n> ⚠️ Report truncated — see GitHub Actions step summary for full results.';
    commentBody =
      commentBody.slice(0, MAX_COMMENT_LENGTH - truncationNotice.length) +
      truncationNotice;
  }

  // Find existing comment with marker
  const existingCommentId = await findExistingComment(
    octokit,
    owner,
    repo,
    prNumber,
  );

  let commentId: number;
  let created: boolean;

  if (existingCommentId) {
    // Update existing comment
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body: commentBody,
    });
    commentId = existingCommentId;
    created = false;
  } else {
    // Create new comment
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });
    commentId = data.id;
    created = true;
  }

  // Always write full report to step summary
  core.summary.addRaw(report).write();

  return { commentId, created };
}

async function findExistingComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const comments = await octokit.paginate(
    octokit.rest.issues.listComments,
    {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    },
  );

  for (const comment of comments) {
    if (comment.body?.includes(MARKER)) {
      return comment.id;
    }
  }
  return null;
}

function buildCommentBody(
  report: string,
  mode: 'full' | 'summary' | 'collapsed',
  stats: { total: number; bySeverity: Record<string, number> },
): string {
  if (mode === 'full') {
    return report;
  }

  if (mode === 'summary') {
    return buildSummaryBody(report, stats);
  }

  // collapsed
  return buildCollapsedBody(report, stats);
}

function buildSummaryBody(
  report: string,
  stats: { total: number; bySeverity: Record<string, number> },
): string {
  // Extract everything up to and including the risk posture table,
  // then append a finding count summary.
  const lines = report.split('\n');
  const summaryLines: string[] = [];
  let inTable = false;
  let tableEnded = false;

  for (const line of lines) {
    if (tableEnded) {
      break;
    }

    if (line.trim().startsWith('|')) {
      inTable = true;
      summaryLines.push(line);
      continue;
    }

    if (inTable && !line.trim().startsWith('|')) {
      tableEnded = true;
      continue;
    }

    summaryLines.push(line);
  }

  // Append finding count summary
  summaryLines.push('');
  summaryLines.push(`**${stats.total} finding(s)** across severities:`);
  for (const [severity, count] of Object.entries(stats.bySeverity)) {
    summaryLines.push(`- ${severity}: ${count}`);
  }

  return summaryLines.join('\n');
}

function buildCollapsedBody(
  report: string,
  stats: { total: number; bySeverity: Record<string, number> },
): string {
  const severityPattern =
    /^(#{2,3})\s+(?:🔴|🟠|🟡|🟢|🔵|⚪)?\s*(CRITICAL|HIGH|MEDIUM|LOW|INFO|NOTE)\b/i;

  const lines = report.split('\n');
  const result: string[] = [];
  let currentSeverity: string | null = null;
  let currentLevel: number | null = null;
  let sectionLines: string[] = [];

  function flushSection() {
    if (currentSeverity && sectionLines.length > 0) {
      const count = stats.bySeverity[currentSeverity.toUpperCase()] ?? 0;
      result.push(
        `<details><summary>${count} ${currentSeverity.toUpperCase()} finding(s)</summary>`,
      );
      result.push('');
      result.push(...sectionLines);
      result.push('');
      result.push('</details>');
    } else {
      result.push(...sectionLines);
    }
    sectionLines = [];
    currentSeverity = null;
    currentLevel = null;
  }

  for (const line of lines) {
    const match = line.match(severityPattern);
    if (match) {
      flushSection();
      currentSeverity = match[2];
      currentLevel = match[1].length;
      sectionLines.push(line);
      continue;
    }

    if (currentSeverity) {
      const headingMatch = line.match(/^(#{1,6})\s/);
      if (headingMatch && headingMatch[1].length <= currentLevel!) {
        flushSection();
      }
    }

    sectionLines.push(line);
  }

  flushSection();

  return result.join('\n');
}
