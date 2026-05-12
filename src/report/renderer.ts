import type { ConsolidatedReport, ReportFormat } from '../types/index.js';
import { renderMarkdown } from './renderers/markdown.js';
import { renderJSON } from './renderers/json.js';

export function render(report: ConsolidatedReport, format: ReportFormat): string {
  switch (format) {
    case 'json':
      return renderJSON(report);
    case 'markdown':
    default:
      return renderMarkdown(report);
  }
}
