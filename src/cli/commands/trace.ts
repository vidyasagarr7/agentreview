import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { parseTrace, distillTrace, analyzeTrace } from '../../trace/index.js';
import { redactSecrets } from '../../scan/redact.js';
import type { TraceSession, ProcessFinding } from '../../trace/types.js';

function formatDuration(ms: number | null): string {
  if (ms === null) return 'unknown';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatToolDistribution(byName: Record<string, number>): string {
  return Object.entries(byName)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}

function renderTextOutput(session: TraceSession, findings: ProcessFinding[], verbose: boolean, distilled: string): string {
  const lines: string[] = [];

  // Session summary
  lines.push('📊 Session Summary');
  lines.push(`  Model: ${session.model || 'unknown'} | Duration: ${formatDuration(session.stats.durationMs)} | Tools: ${session.stats.toolCalls} calls`);
  if (Object.keys(session.stats.toolCallsByName).length > 0) {
    lines.push(`  Distribution: ${formatToolDistribution(session.stats.toolCallsByName)}`);
  }
  lines.push(`  Events: ${session.stats.totalEvents} total | ${session.stats.userPrompts} prompts | ${session.stats.errorCount} errors`);
  if (session.warnings > 0) {
    lines.push(`  ⚠ ${session.warnings} malformed lines skipped`);
  }
  lines.push('');

  // Findings
  if (findings.length > 0) {
    lines.push(`⚠️  Process Findings (${findings.length})`);
    lines.push('');
    for (const finding of findings) {
      const icon = finding.severity === 'warning' ? 'warning' : 'info';
      lines.push(`  [${icon}] ${finding.signal.replace(/_/g, ' ')} — ${finding.description}`);
      lines.push(`    Evidence: ${finding.evidence}`);
      lines.push('');
    }
  } else {
    lines.push('✅ No process issues detected');
    lines.push('');
  }

  // Verbose: show distilled trace
  if (verbose) {
    lines.push('--- Distilled Trace ---');
    lines.push(distilled);
    lines.push('');
  }

  return lines.join('\n');
}

function renderJsonOutput(session: TraceSession, findings: ProcessFinding[], distilled: string): string {
  return JSON.stringify({
    session: {
      sessionId: session.sessionId,
      model: session.model,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      stats: session.stats,
      warnings: session.warnings,
    },
    findings,
    distilled,
  }, null, 2);
}

function renderMarkdownOutput(session: TraceSession, findings: ProcessFinding[], distilled: string): string {
  const lines: string[] = [];

  lines.push('# Agent Trace Review');
  lines.push('');
  lines.push('## Session Summary');
  lines.push(`- **Model:** ${session.model || 'unknown'}`);
  lines.push(`- **Duration:** ${formatDuration(session.stats.durationMs)}`);
  lines.push(`- **Tool Calls:** ${session.stats.toolCalls}`);
  lines.push(`- **Errors:** ${session.stats.errorCount}`);
  lines.push(`- **User Prompts:** ${session.stats.userPrompts}`);
  lines.push('');

  if (Object.keys(session.stats.toolCallsByName).length > 0) {
    lines.push('### Tool Distribution');
    for (const [name, count] of Object.entries(session.stats.toolCallsByName).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${name}: ${count}`);
    }
    lines.push('');
  }

  if (findings.length > 0) {
    lines.push('## Process Findings');
    lines.push('');
    for (const finding of findings) {
      const emoji = finding.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(`### ${emoji} ${finding.signal.replace(/_/g, ' ')}`);
      lines.push(`**Severity:** ${finding.severity}`);
      lines.push(`${finding.description}`);
      lines.push(`> ${finding.evidence}`);
      lines.push('');
    }
  } else {
    lines.push('## Process Findings');
    lines.push('✅ No process issues detected.');
    lines.push('');
  }

  return lines.join('\n');
}

export function createTraceCommand(): Command {
  const cmd = new Command('trace')
    .description('Analyze an AI coding agent session trace for process quality')
    .argument('<path>', 'Path to Claude Code JSONL session transcript')
    .option('--format <fmt>', 'Output format: text, json, markdown', 'text')
    .option('--verbose', 'Include distilled trace in output', false)
    .option('--stats-only', 'Show session stats only, skip process analysis', false)
    .action(async (tracePath: string, opts: { format: string; verbose: boolean; statsOnly: boolean }) => {
      // Validate file exists
      if (!existsSync(tracePath)) {
        console.error(`Error: file not found: ${tracePath}`);
        process.exit(1);
      }

      // Read and redact
      const raw = await readFile(tracePath, 'utf-8');
      const { redacted, count: redactCount } = redactSecrets(raw);
      if (redactCount > 0) {
        console.error(`🔒 Redacted ${redactCount} potential secret(s) before processing`);
      }

      // Parse
      const session = parseTrace(redacted);
      if (session.events.length === 0) {
        console.error('Warning: no events found in trace file');
      }

      // Distill
      const distilled = distillTrace(session);

      // Analyze (unless stats-only)
      const findings = opts.statsOnly ? [] : analyzeTrace(session);

      // Render output
      let output: string;
      switch (opts.format) {
        case 'json':
          output = renderJsonOutput(session, findings, distilled);
          break;
        case 'markdown':
          output = renderMarkdownOutput(session, findings, distilled);
          break;
        default:
          output = renderTextOutput(session, findings, opts.verbose, distilled);
      }

      console.log(output);
    });

  return cmd;
}
