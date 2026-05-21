import * as core from '@actions/core';

// 1 MB limit for GitHub Actions output
const MAX_REPORT_BYTES = 1_048_576;

export interface ReviewResult {
  report: string;
  findings: Array<{ severity: string }>;
  stats: {
    total: number;
    bySeverity: Record<string, number>;
  };
  commentId?: number;
  shouldFail: boolean;
}

export function setOutputs(result: ReviewResult): void {
  core.setOutput('findings-count', result.stats.total.toString());
  core.setOutput('critical-count', (result.stats.bySeverity['CRITICAL'] || 0).toString());
  core.setOutput('high-count', (result.stats.bySeverity['HIGH'] || 0).toString());
  core.setOutput('review-comment-id', result.commentId?.toString() ?? '');

  let report = result.report;
  if (Buffer.byteLength(report, 'utf8') > MAX_REPORT_BYTES) {
    const truncationWarning = '\n\n⚠️ Report truncated — exceeded 1 MB output limit.';
    // Leave room for the warning suffix
    const budget = MAX_REPORT_BYTES - Buffer.byteLength(truncationWarning, 'utf8');
    // Slice to budget (byte-safe via Buffer)
    report = Buffer.from(report, 'utf8').subarray(0, budget).toString('utf8') + truncationWarning;
  }
  core.setOutput('report', report);

  core.setOutput('exit-code', result.shouldFail ? '2' : '0');
}
