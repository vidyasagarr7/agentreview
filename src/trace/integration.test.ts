import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseTrace } from './parser.js';
import { distillTrace } from './distiller.js';
import { analyzeTrace } from './analyzer.js';
import { redactSecrets } from '../scan/redact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'sample-session.jsonl');

describe('Agent Trace Review — Integration', () => {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');

  it('redaction removes planted secrets', () => {
    // The fixture contains an Anthropic API key: sk-ant-api03-realkey123456789abcdef
    const { redacted, count } = redactSecrets(raw);
    expect(count).toBeGreaterThan(0);
    expect(redacted).not.toContain('sk-ant-api03-realkey123456789abcdef');
    expect(redacted).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('full pipeline: redact → parse → distill → analyze', () => {
    const { redacted } = redactSecrets(raw);
    const session = parseTrace(redacted);

    // Parse checks
    expect(session.sessionId).toBe('sess-test-001');
    expect(session.model).toBe('claude-sonnet-4');
    expect(session.events.length).toBeGreaterThan(0);
    expect(session.stats.userPrompts).toBeGreaterThanOrEqual(1);
    expect(session.stats.toolCalls).toBeGreaterThan(0);
    expect(session.stats.errorCount).toBeGreaterThan(0); // The npm test failures
    expect(session.stats.durationMs).toBeGreaterThan(0);

    // Noise events (permission-mode, ai-title) should be dropped
    const noiseEvents = session.events.filter(e =>
      e.type === 'unknown' || e.type === 'system'
    );
    // permission-mode and ai-title should NOT appear as events
    expect(session.events.every(e =>
      e.type === 'user' || e.type === 'assistant' || e.type === 'tool_use'
    )).toBe(true);

    // Distill checks
    const distilled = distillTrace(session);
    expect(distilled.length).toBeGreaterThan(0);
    expect(distilled).toContain('USER:');
    expect(distilled).toContain('Bash:');
    expect(distilled).toContain('Read');
    expect(distilled).toContain('Write');
    // Secrets should NOT appear in distilled output
    expect(distilled).not.toContain('sk-ant-api03');

    // Analyze checks
    const findings = analyzeTrace(session);
    expect(findings.length).toBeGreaterThan(0);

    // Should detect dead end (fetch approach failed, switched to https module)
    const deadEnds = findings.filter(f => f.signal === 'dead_end');
    expect(deadEnds.length).toBeGreaterThanOrEqual(1);

    // Should detect some process issue (unhandled error or dead end)
    const warnings = findings.filter(f => f.severity === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('distilled output is within token budget', () => {
    const { redacted } = redactSecrets(raw);
    const session = parseTrace(redacted);
    const distilled = distillTrace(session);

    // Should be well under the 60K token target for this small fixture
    const estimatedTokens = distilled.length * 0.4;
    expect(estimatedTokens).toBeLessThan(60_000);
  });

  it('failed tool calls are NOT collapsed in distilled output', () => {
    const { redacted } = redactSecrets(raw);
    const session = parseTrace(redacted);
    const distilled = distillTrace(session);

    // The fixture has failed npm test calls — they should all be visible
    const errLines = distilled.split('\n').filter(l => l.includes('→ ERR'));
    expect(errLines.length).toBeGreaterThanOrEqual(2); // At least 2 npm test failures
  });

  it('stats reflect actual session content', () => {
    const { redacted } = redactSecrets(raw);
    const session = parseTrace(redacted);

    expect(session.stats.toolCallsByName['Read']).toBeGreaterThanOrEqual(2);
    expect(session.stats.toolCallsByName['Write']).toBeGreaterThanOrEqual(1);
    expect(session.stats.toolCallsByName['Bash']).toBeGreaterThanOrEqual(3);
  });
});
