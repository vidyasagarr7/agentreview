import { describe, it, expect } from 'vitest';
import { parseLocation, formatInlineComment, mapFindingsToInlineComments } from './inline.js';
import type { AgentFinding } from '../types/index.js';

describe('parseLocation', () => {
  it('parses "file.ts:42" correctly', () => {
    const result = parseLocation('file.ts:42');
    expect(result).toEqual({ path: 'file.ts', line: 42 });
  });

  it('parses "src/auth/login.ts:3-15" to line 3', () => {
    const result = parseLocation('src/auth/login.ts:3-15');
    expect(result).toEqual({ path: 'src/auth/login.ts', line: 3 });
  });

  it('parses deeply nested paths', () => {
    const result = parseLocation('packages/core/src/utils/helper.ts:100');
    expect(result).toEqual({ path: 'packages/core/src/utils/helper.ts', line: 100 });
  });

  it('returns null for unparseable location', () => {
    expect(parseLocation('general codebase issue')).toBeNull();
    expect(parseLocation('README.md')).toBeNull();
    expect(parseLocation('')).toBeNull();
    expect(parseLocation('multiple files')).toBeNull();
  });

  it('returns null for line 0', () => {
    expect(parseLocation('file.ts:0')).toBeNull();
  });
});

describe('formatInlineComment', () => {
  const finding: AgentFinding = {
    id: 'f1',
    severity: 'CRITICAL',
    category: 'Hardcoded Secret',
    location: 'src/config.ts:10',
    summary: 'AWS access key hardcoded in source',
    detail: 'The AWS access key is directly embedded in the source code.',
    suggestion: 'Use environment variables or secrets manager.',
    lenses: ['security'],
  };

  it('includes severity emoji', () => {
    const result = formatInlineComment(finding);
    expect(result).toContain('🔴');
    expect(result).toContain('CRITICAL');
  });

  it('includes category and summary', () => {
    const result = formatInlineComment(finding);
    expect(result).toContain('Hardcoded Secret');
    expect(result).toContain('AWS access key hardcoded in source');
  });

  it('includes suggestion', () => {
    const result = formatInlineComment(finding);
    expect(result).toContain('**Suggestion:** Use environment variables or secrets manager.');
  });

  it('includes lens tag', () => {
    const result = formatInlineComment(finding);
    expect(result).toContain('*AgentReview [security]*');
  });

  it('handles multiple lenses', () => {
    const multi = { ...finding, lenses: ['security', 'quality'] };
    const result = formatInlineComment(multi);
    expect(result).toContain('[security + quality]');
  });
});

describe('mapFindingsToInlineComments', () => {
  const changedFiles = ['src/auth/login.ts', 'src/config.ts', 'README.md'];

  const findingInDiff: AgentFinding = {
    id: 'f1',
    severity: 'HIGH',
    category: 'SQL Injection',
    location: 'src/auth/login.ts:42',
    summary: 'Unparameterized query',
    detail: 'User input flows directly into SQL query.',
    suggestion: 'Use parameterized queries.',
    lenses: ['security'],
  };

  const findingNotInDiff: AgentFinding = {
    id: 'f2',
    severity: 'MEDIUM',
    category: 'Code Smell',
    location: 'src/utils/helpers.ts:10',
    summary: 'Unused import',
    detail: 'Import is never used.',
    suggestion: 'Remove it.',
    lenses: ['quality'],
  };

  const findingNoParse: AgentFinding = {
    id: 'f3',
    severity: 'LOW',
    category: 'Documentation',
    location: 'general codebase',
    summary: 'Missing README section',
    detail: 'No contributing guide.',
    suggestion: 'Add CONTRIBUTING.md.',
    lenses: ['quality'],
  };

  it('maps findings in diff to inline comments', () => {
    const { inline, fallback } = mapFindingsToInlineComments(
      [findingInDiff],
      changedFiles,
    );
    expect(inline).toHaveLength(1);
    expect(inline[0].path).toBe('src/auth/login.ts');
    expect(inline[0].line).toBe(42);
    expect(inline[0].severity).toBe('HIGH');
    expect(fallback).toHaveLength(0);
  });

  it('sends findings not in diff to fallback', () => {
    const { inline, fallback } = mapFindingsToInlineComments(
      [findingNotInDiff],
      changedFiles,
    );
    expect(inline).toHaveLength(0);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].id).toBe('f2');
  });

  it('sends unparseable findings to fallback', () => {
    const { inline, fallback } = mapFindingsToInlineComments(
      [findingNoParse],
      changedFiles,
    );
    expect(inline).toHaveLength(0);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].id).toBe('f3');
  });

  it('splits mixed findings correctly', () => {
    const { inline, fallback } = mapFindingsToInlineComments(
      [findingInDiff, findingNotInDiff, findingNoParse],
      changedFiles,
    );
    expect(inline).toHaveLength(1);
    expect(fallback).toHaveLength(2);
  });

  it('handles empty findings array', () => {
    const { inline, fallback } = mapFindingsToInlineComments([], changedFiles);
    expect(inline).toHaveLength(0);
    expect(fallback).toHaveLength(0);
  });
});
