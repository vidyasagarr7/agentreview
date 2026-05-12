import { describe, it, expect } from 'vitest';
import { buildPrompt } from './prompt-builder.js';
import type { Lens, ReviewContext, PRData } from '../types/index.js';

const mockPR: PRData = {
  title: 'Add user auth endpoint',
  body: 'This PR adds a new login endpoint',
  author: 'developer',
  baseBranch: 'main',
  headBranch: 'feature/auth',
  labels: ['security', 'backend'],
  diff: 'diff --git a/auth.ts b/auth.ts\n+ const key = "hardcoded";\n',
  files: [
    { filename: 'auth.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
  ],
  additions: 1,
  deletions: 0,
  number: 42,
  repoOwner: 'acme',
  repoName: 'api',
  isDraft: false,
  state: 'open',
};

const mockLens: Lens = {
  id: 'security',
  name: 'Security',
  description: 'Security review',
  systemPrompt: 'You are a security reviewer.',
  focusAreas: ['auth', 'injection'],
  severity: 'strict',
};

const mockContext: ReviewContext = {
  pr: mockPR,
  diff: mockPR.diff,
  fileList: '- auth.ts (modified, +1/-0)',
  truncated: false,
  estimatedTokens: 100,
};

describe('buildPrompt', () => {
  it('includes PR title in user prompt', () => {
    const { user } = buildPrompt(mockLens, mockContext);
    expect(user).toContain('Add user auth endpoint');
  });

  it('includes file list in user prompt', () => {
    const { user } = buildPrompt(mockLens, mockContext);
    expect(user).toContain('auth.ts');
  });

  it('includes diff in user prompt', () => {
    const { user } = buildPrompt(mockLens, mockContext);
    expect(user).toContain('hardcoded');
  });

  it('includes JSON schema instruction in system prompt', () => {
    const { system } = buildPrompt(mockLens, mockContext);
    expect(system).toContain('JSON array');
    expect(system).toContain('"severity"');
  });

  it('includes lens system prompt in system', () => {
    const { system } = buildPrompt(mockLens, mockContext);
    expect(system).toContain('You are a security reviewer.');
  });

  it('adds truncation note when context is truncated', () => {
    const truncatedContext: ReviewContext = {
      ...mockContext,
      truncated: true,
      truncationNote: '[TRUNCATED] 5 file(s) omitted',
    };
    const { user } = buildPrompt(mockLens, truncatedContext);
    expect(user).toContain('[TRUNCATED]');
  });

  it('does not add truncation note when not truncated', () => {
    const { user } = buildPrompt(mockLens, mockContext);
    expect(user).not.toContain('[TRUNCATED]');
  });

  it('adds draft warning for draft PRs', () => {
    const draftContext: ReviewContext = {
      ...mockContext,
      pr: { ...mockPR, isDraft: true },
    };
    const { user } = buildPrompt(mockLens, draftContext);
    expect(user).toContain('DRAFT');
  });
});
