export class InvalidPRUrlError extends Error {
  constructor(url: string) {
    super(
      `Invalid GitHub PR URL: "${url}"\n` +
      `Expected format: https://github.com/owner/repo/pull/123\n` +
      `Note: GitHub Enterprise URLs (e.g., github.mycompany.com) are not supported in v1.`
    );
    this.name = 'InvalidPRUrlError';
  }
}

export interface ParsedPRUrl {
  owner: string;
  repo: string;
  number: number;
}

export function parsePRUrl(url: string): ParsedPRUrl {
  // Normalize: strip protocol, trailing slash
  const normalized = url
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  const match = normalized.match(/^github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);

  if (!match) {
    throw new InvalidPRUrlError(url);
  }

  const [, owner, repo, numberStr] = match;
  const number = parseInt(numberStr, 10);

  if (isNaN(number) || number <= 0) {
    throw new InvalidPRUrlError(url);
  }

  return { owner, repo, number };
}
