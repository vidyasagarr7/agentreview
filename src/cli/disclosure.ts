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
    process.stderr.write('⚠️  Running in non-interactive mode. Proceeding automatically.\n\n');
    return;
  }

  // Check if stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) {
    process.stderr.write('⚠️  Non-interactive environment detected. Proceeding automatically.\n\n');
    return;
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
