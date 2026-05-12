import { describe, it, expect } from 'vitest';
import { parsePRUrl, InvalidPRUrlError } from './parse-url.js';

describe('parsePRUrl', () => {
  it('parses a full https URL', () => {
    const result = parsePRUrl('https://github.com/owner/repo/pull/123');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 123 });
  });

  it('parses without protocol', () => {
    const result = parsePRUrl('github.com/owner/repo/pull/456');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 456 });
  });

  it('parses with http protocol', () => {
    const result = parsePRUrl('http://github.com/org/my-repo/pull/1');
    expect(result).toEqual({ owner: 'org', repo: 'my-repo', number: 1 });
  });

  it('handles trailing slash', () => {
    const result = parsePRUrl('https://github.com/owner/repo/pull/123/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 123 });
  });

  it('throws for missing PR number', () => {
    expect(() => parsePRUrl('https://github.com/owner/repo')).toThrow(InvalidPRUrlError);
  });

  it('throws for malformed URL', () => {
    expect(() => parsePRUrl('not-a-url')).toThrow(InvalidPRUrlError);
  });

  it('throws for GitLab URL', () => {
    expect(() => parsePRUrl('https://gitlab.com/owner/repo/merge_requests/123')).toThrow(InvalidPRUrlError);
  });

  it('throws for GitHub Enterprise URL with helpful message', () => {
    expect(() => parsePRUrl('https://github.mycompany.com/org/repo/pull/1')).toThrow(InvalidPRUrlError);
  });

  it('throws for empty string', () => {
    expect(() => parsePRUrl('')).toThrow(InvalidPRUrlError);
  });
});
