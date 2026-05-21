import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PRContext } from './context.js';

// Mock @actions/github
vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    eventName: 'pull_request',
    payload: {
      pull_request: { number: 42 },
    },
  },
}));

// Mock @actions/core
vi.mock('@actions/core', () => ({
  debug: vi.fn(),
}));

import * as github from '@actions/github';
import { extractPRContext } from './context.js';

function setEvent(
  eventName: string,
  payload: Record<string, unknown> = {},
): void {
  Object.assign(github.context, { eventName, payload });
}

describe('extractPRContext', () => {
  beforeEach(() => {
    // Reset to default pull_request state
    setEvent('pull_request', { pull_request: { number: 42 } });
  });

  it('extracts context from pull_request event', () => {
    const ctx: PRContext = extractPRContext({ githubToken: 'tok-123' });

    expect(ctx).toEqual({
      owner: 'test-owner',
      repo: 'test-repo',
      prNumber: 42,
      token: 'tok-123',
    });
  });

  it('extracts context from pull_request_target event', () => {
    setEvent('pull_request_target', { pull_request: { number: 99 } });

    const ctx = extractPRContext({ githubToken: 'tok-456' });

    expect(ctx.prNumber).toBe(99);
    expect(ctx.owner).toBe('test-owner');
    expect(ctx.repo).toBe('test-repo');
  });

  it('uses pr-number input for workflow_dispatch', () => {
    setEvent('workflow_dispatch', {});

    const ctx = extractPRContext({ githubToken: 'tok-789', prNumber: 55 });

    expect(ctx.prNumber).toBe(55);
  });

  it('throws on workflow_dispatch without pr-number', () => {
    setEvent('workflow_dispatch', {});

    expect(() => extractPRContext({ githubToken: 'tok-000' })).toThrow(
      "AgentReview requires a pull_request event or the 'pr-number' input",
    );
  });

  it('uses pr-number input for issue_comment event', () => {
    setEvent('issue_comment', { comment: { id: 1 } });

    const ctx = extractPRContext({ githubToken: 'tok-abc', prNumber: 77 });

    expect(ctx.prNumber).toBe(77);
  });

  it('passes token through from inputs', () => {
    const ctx = extractPRContext({ githubToken: 'my-secret-token' });

    expect(ctx.token).toBe('my-secret-token');
  });
});
