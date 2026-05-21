import type { PRContext } from './context.js';

export interface PostResult {
  commentId: number;
  created: boolean;
}

/**
 * Placeholder — will be implemented in a subsequent task.
 * Posts or updates a PR comment with the review report.
 */
export async function postResults(
  _report: string,
  _prContext: PRContext,
  _commentMode: 'full' | 'summary' | 'collapsed',
  _stats?: { total: number; bySeverity: Record<string, number> },
): Promise<PostResult> {
  throw new Error('postResults is not yet implemented');
}
