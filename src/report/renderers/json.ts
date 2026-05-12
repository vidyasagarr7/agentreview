import type { ConsolidatedReport } from '../../types/index.js';

export function renderJSON(report: ConsolidatedReport): string {
  return JSON.stringify(report, null, 2);
}
