import { describe, it, expect, vi } from 'vitest';
import { render } from './renderer.js';
import type { ConsolidatedReport } from '../types/index.js';

vi.mock('./renderers/markdown.js', () => ({
  renderMarkdown: vi.fn(() => '# Markdown Report'),
}));

vi.mock('./renderers/json.js', () => ({
  renderJSON: vi.fn(() => '{"report": true}'),
}));

const mockReport: ConsolidatedReport = {
  pr: {
    title: 'Test PR',
    number: 42,
    author: 'tester',
    repoOwner: 'owner',
    repoName: 'repo',
    filesChanged: 3,
    additions: 10,
    deletions: 5,
  },
  reviewedAt: '2026-01-01T00:00:00Z',
  lensesRun: ['security'],
  findings: [],
  parseErrors: [],
  stats: {
    total: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    byLens: {},
    cleanLenses: [],
    erroredLenses: [],
    parseErrorLenses: [],
  },
  confidence: 'NORMAL',
  skippedFiles: [],
};

describe('render', () => {
  it('calls renderMarkdown for markdown format', async () => {
    const { renderMarkdown } = await import('./renderers/markdown.js');
    const result = render(mockReport, 'markdown');
    expect(renderMarkdown).toHaveBeenCalledWith(mockReport);
    expect(result).toBe('# Markdown Report');
  });

  it('calls renderJSON for json format', async () => {
    const { renderJSON } = await import('./renderers/json.js');
    const result = render(mockReport, 'json');
    expect(renderJSON).toHaveBeenCalledWith(mockReport);
    expect(result).toBe('{"report": true}');
  });

  it('defaults to markdown for unknown format', async () => {
    const { renderMarkdown } = await import('./renderers/markdown.js');
    const result = render(mockReport, 'xml' as any);
    expect(renderMarkdown).toHaveBeenCalledWith(mockReport);
    expect(result).toBe('# Markdown Report');
  });
});
