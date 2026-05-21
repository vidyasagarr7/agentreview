import { createInterface } from 'readline';

const DISCLOSURE_MESSAGE = `
⚠️  AgentReview sends your PR diff to an LLM provider (default: OpenAI) for analysis.
    This includes all changed code in the PR, which may contain sensitive business logic,
    proprietary algorithms, or security-relevant code.

    Review the provider's data policy:
    OpenAI:    https://openai.com/policies/api-data-usage-policies
    Anthropic: https://www.anthropic.com/legal/privacy

    To skip this prompt in the future, set:
      AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1

`;

export async function checkDataDisclosure(
  acknowledged: boolean,
  nonInteractive: boolean
): Promise<void> {
  if (acknowledged) return;

  process.stderr.write(DISCLOSURE_MESSAGE);

  if (nonInteractive) {
    // --yes was explicitly passed: user has acknowledged the data policy
    process.stderr.write('⚠️  Data disclosure acknowledged via --yes flag.\n\n');
    return;
  }

  // Check if stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) {
    process.stderr.write(
      '❌  Non-interactive environment detected and --yes flag was not passed.\n' +
      '   AgentReview cannot proceed without explicit consent to send PR diffs to an LLM provider.\n' +
      '   In CI or piped usage, pass --yes (or -y) to acknowledge the data policy:\n' +
      '     agentreview <pr-url> --yes\n' +
      '   Or set AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1 to skip the prompt entirely.\n\n'
    );
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    rl.question('Continue? [y/N] ', (answer) => {
      rl.close();

      const normalized = answer.trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        resolve();
      } else {
        process.stderr.write('\nReview cancelled.\n');
        process.exit(0);
      }
    });
  });
}

export async function checkScanDisclosure(
  acknowledged: boolean,
  yes: boolean,
  meta: { fileCount: number; provider: string; model: string; focus?: string[] }
): Promise<void> {
  if (acknowledged) return;

  const scanMessage = `
⚠️  CODEBASE SCAN DATA DISCLOSURE

This scan will read and send the FULL CONTENTS of source files to an external
LLM API (${meta.provider}). This is broader than PR diff review.

Estimated: ${meta.fileCount} files will be sent to ${meta.provider} (${meta.model}).

This may include:
  • Source code (proprietary logic, algorithms)
  • Configuration files (potentially containing partial secrets)
  • Environment files (.env, docker-compose) if present

Recommendation: Use --redact to mask known secret patterns before transmission.
`;

  process.stderr.write(scanMessage);

  if (meta.focus?.includes('secrets')) {
    process.stderr.write(
      "\n⚠️  The 'secrets' focus intentionally reads files likely to contain credentials.\n" +
      '   Use --redact to prevent actual secret values from being sent to the LLM.\n\n'
    );
  }

  if (yes) {
    process.stderr.write('⚠️  Scan disclosure acknowledged via --yes flag.\n\n');
    return;
  }

  // Check if stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) {
    process.stderr.write(
      '❌  Non-interactive environment detected and --yes flag was not passed.\n' +
      '   Codebase scan cannot proceed without explicit consent to send source files to an LLM provider.\n' +
      '   In CI or piped usage, pass --yes (or -y) to acknowledge the scan disclosure:\n' +
      '     agentreview scan <path> --yes\n' +
      '   Or set AGENTREVIEW_ACKNOWLEDGE_DATA_POLICY=1 to skip the prompt entirely.\n\n'
    );
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    rl.question('Do you acknowledge and wish to proceed? [y/N] ', (answer) => {
      rl.close();

      const normalized = answer.trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        resolve();
      } else {
        process.stderr.write('\nScan cancelled.\n');
        process.exit(0);
      }
    });
  });
}
