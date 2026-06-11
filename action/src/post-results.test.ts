import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks so vi.mock factories can reference them
const { mockCreateComment, mockUpdateComment, mockPaginate, mockSummaryWrite, mockSummaryAddRaw, mockCreateReview } = vi.hoisted(() => {
  const mockSummaryWrite = vi.fn();
  const mockSummaryAddRaw = vi.fn(() => ({ write: mockSummaryWrite }));
  return {
    mockCreateComment: vi.fn(),
    mockUpdateComment: vi.fn(),
    mockCreateReview: vi.fn(),
    mockPaginate: vi.fn(),
    mockSummaryWrite,
    mockSummaryAddRaw,
  };
});

vi.mock('@actions/github', () => ({
  getOctokit: vi.fn(() => ({
    rest: {
      issues: {
        createComment: mockCreateComment,
        updateComment: mockUpdateComment,
        listComments: { endpoint: { merge: vi.fn() } },
      },
      pulls: {
        createReview: mockCreateReview,
      },
    },
    paginate: mockPaginate,
  })),
}));

vi.mock('@actions/core', () => ({
  summary: {
    addRaw: mockSummaryAddRaw,
  },
}));

import { postResults, type PostResult } from './post-results.js';
import type { PRContext } from './context.js';

const prContext: PRContext = {
  owner: 'testowner',
  repo: 'testrepo',
  prNumber: 42,
  token: 'ghp_test',
};

const defaultStats = { total: 3, bySeverity: { CRITICAL: 1, HIGH: 2 } };

describe('postResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 100 } });
    mockCreateReview.mockResolvedValue({ data: { id: 900 } });
    mockSummaryAddRaw.mockReturnValue({ write: mockSummaryWrite });
  });

  it('creates new comment when no existing comment found', async () => {
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 123 } });

    const result = await postResults(
      '## Review\nLooks good.',
      prContext,
      'full',
      defaultStats,
    );

    expect(result).toEqual({ commentId: 123, created: true });
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      issue_number: 42,
      body: expect.stringContaining('<!-- agentreview -->'),
    });
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });

  it('updates existing comment when marker is found', async () => {
    mockPaginate.mockResolvedValue([
      { id: 55, body: 'some comment' },
      { id: 77, body: '<!-- agentreview -->\nold review' },
    ]);

    const result = await postResults(
      '## Updated Review',
      prContext,
      'full',
      defaultStats,
    );

    expect(result).toEqual({ commentId: 77, created: false });
    expect(mockUpdateComment).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      comment_id: 77,
      body: expect.stringContaining('<!-- agentreview -->'),
    });
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it('uses <!-- agentreview --> as the marker', async () => {
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 200 } });

    await postResults('report', prContext, 'full', defaultStats);

    const body = mockCreateComment.mock.calls[0][0].body as string;
    expect(body.startsWith('<!-- agentreview -->')).toBe(true);
  });

  it('truncates body exceeding 65000 chars', async () => {
    const longReport = 'x'.repeat(70000);
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 300 } });

    await postResults(longReport, prContext, 'full', defaultStats);

    const body = mockCreateComment.mock.calls[0][0].body as string;
    expect(body.length).toBeLessThanOrEqual(65000);
    expect(body).toContain(
      '⚠️ Report truncated — see GitHub Actions step summary for full results.',
    );
  });

  it('always writes full report to step summary', async () => {
    const report = '## Full Report\nDetails here.';
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 400 } });

    await postResults(report, prContext, 'full', defaultStats);

    expect(mockSummaryAddRaw).toHaveBeenCalledWith(report);
    expect(mockSummaryWrite).toHaveBeenCalled();
  });

  it('comment-mode=summary produces shorter comment', async () => {
    const report = [
      '# AgentReview',
      '',
      '| Risk | Level |',
      '| --- | --- |',
      '| Overall | HIGH |',
      '',
      '## 🔴 CRITICAL',
      '',
      '### Finding 1',
      'Details about critical finding...',
      '',
      '## 🟠 HIGH',
      '',
      '### Finding 2',
      'Details about high finding...',
    ].join('\n');

    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 500 } });

    await postResults(report, prContext, 'summary', defaultStats);

    const body = mockCreateComment.mock.calls[0][0].body as string;
    expect(body).not.toContain('Details about critical finding');
    expect(body).not.toContain('Details about high finding');
    expect(body).toContain('3 finding(s)');
    expect(body).toContain('CRITICAL: 1');
    expect(body).toContain('HIGH: 2');
    expect(mockSummaryAddRaw).toHaveBeenCalledWith(report);
  });

  describe('inline review mode', () => {
    const makeFinding = (overrides: Partial<import('../../src/types/index.js').AgentFinding> = {}): import('../../src/types/index.js').AgentFinding => ({
      id: 'f1',
      severity: 'HIGH',
      category: 'security',
      location: 'src/auth.ts:10',
      summary: 'Test finding',
      detail: 'Detail text',
      suggestion: 'Fix it',
      lenses: ['security'],
      ...overrides,
    });

    it('calls pulls.createReview with COMMENT event when inline=true and no failOn', async () => {
      const findings = [makeFinding()];
      const changedFiles = ['src/auth.ts'];

      const result = await postResults(
        '## Report',
        prContext,
        'full',
        defaultStats,
        { inline: true, findings, changedFiles },
      );

      expect(result).toEqual({ commentId: 900, created: true });
      expect(mockCreateReview).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testowner',
          repo: 'testrepo',
          pull_number: 42,
          event: 'COMMENT',
          body: '## Report',
          comments: expect.arrayContaining([
            expect.objectContaining({
              path: 'src/auth.ts',
              line: 10,
              side: 'RIGHT',
            }),
          ]),
        }),
      );
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockSummaryAddRaw).toHaveBeenCalledWith('## Report');
    });

    it('calls pulls.createReview with REQUEST_CHANGES event when failOn is set', async () => {
      const findings = [makeFinding()];
      const changedFiles = ['src/auth.ts'];

      const result = await postResults(
        '## Report',
        prContext,
        'full',
        defaultStats,
        { inline: true, findings, changedFiles, failOn: 'high' },
      );

      expect(result).toEqual({ commentId: 900, created: true });
      expect(mockCreateReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'REQUEST_CHANGES',
        }),
      );
    });

    it('includes fallback notice in reviewBody when some findings cannot be mapped', async () => {
      const findings = [
        makeFinding({ location: 'src/auth.ts:10' }),
        makeFinding({ id: 'f2', location: 'unmappable-location' }),
        makeFinding({ id: 'f3', location: 'other-file.ts:5' }),
      ];
      const changedFiles = ['src/auth.ts'];

      await postResults(
        '## Report',
        prContext,
        'full',
        defaultStats,
        { inline: true, findings, changedFiles },
      );

      const body = mockCreateReview.mock.calls[0][0].body as string;
      expect(body).toContain('2 finding(s) could not be mapped to specific diff lines');
    });

    it('uses report directly as reviewBody when all findings map to inline comments', async () => {
      const findings = [makeFinding({ location: 'src/auth.ts:10' })];
      const changedFiles = ['src/auth.ts'];

      await postResults(
        '## Report',
        prContext,
        'full',
        defaultStats,
        { inline: true, findings, changedFiles },
      );

      const body = mockCreateReview.mock.calls[0][0].body as string;
      expect(body).toBe('## Report');
    });
  });

  it('comment-mode=collapsed wraps severity sections in details blocks', async () => {
    const report = [
      '# AgentReview',
      '',
      '## 🔴 CRITICAL',
      '',
      '### Finding 1',
      'Critical details.',
      '',
      '## 🟠 HIGH',
      '',
      '### Finding 2',
      'High details.',
    ].join('\n');

    const stats = { total: 2, bySeverity: { CRITICAL: 1, HIGH: 1 } };
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 600 } });

    await postResults(report, prContext, 'collapsed', stats);

    const body = mockCreateComment.mock.calls[0][0].body as string;
    expect(body).toContain('<details><summary>1 CRITICAL finding(s)</summary>');
    expect(body).toContain('<details><summary>1 HIGH finding(s)</summary>');
    expect(body).toContain('</details>');
    expect(mockSummaryAddRaw).toHaveBeenCalledWith(report);
  });
});
